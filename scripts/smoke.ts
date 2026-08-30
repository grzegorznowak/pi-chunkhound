/**
 * pi-chhound mechanics smoke test — no pi session needed.
 * Uses a scratch git repo and the real chunkhound CLI with --no-embeddings
 * (no API key required). Verifies baseline prime/refresh, worktree spin-up
 * via db copy + top-up, config materialization, sandbox listing/prune.
 *
 * Run: npm run smoke
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../chhound/args.js";
import { ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { chhoundVersion } from "../chhound/cli.js";
import { branchCompletions, dirCompletions, worktreeArgumentCompletions } from "../chhound/completions.js";
import { currentBranch, findRepoRoot, gitWorktreeAdd, repoExcludePath, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import {
	dirSize,
	listSandboxes,
	pruneSandboxes,
	sandboxConfigPath,
	sandboxDbDir,
	sandboxDirFor,
	writeSandboxMeta,
} from "../chhound/sandbox.js";
import { loadSettings, saveSettings } from "../chhound/settings.js";
import { deriveWorktreePath } from "../worktree/command.js";
import type { ChhoundSettings } from "../chhound/types.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	checks++;
	if (cond) console.log(`  ok ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
const section = (t: string) => console.log(`\n== ${t}`);

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-smoke-"));
	console.log(`scratch: ${tmp}`);
	const settings: ChhoundSettings = {
		version: 1,
		sandboxRoot: path.join(tmp, "sandboxes"),
		baseRoot: path.join(tmp, "bases"),
	};

	// ── 1. arg parsing ────────────────────────────────────────────────
	section("parseArgs");
	{
		const p = parseArgs(`../wt -b feature/x --from abc123 --no-index --config "my cfg.json"`);
		check("positionals", JSON.stringify(p.positionals) === JSON.stringify(["../wt"]), JSON.stringify(p.positionals));
		check("-b value", p.flags["b"] === "feature/x");
		check("--from value", p.flags["from"] === "abc123");
		check("--no-index boolean", p.flags["no-index"] === true);
		check("quoted --config", p.flags["config"] === "my cfg.json");
	}

	// ── 2. completions ─────────────────────────────────────────────────
	section("completions");
	{
		const proj = path.join(tmp, "comp-proj");
		fs.mkdirSync(path.join(proj, "src", "nested"), { recursive: true });
		fs.mkdirSync(path.join(proj, "docs"), { recursive: true });
		fs.writeFileSync(path.join(proj, "a.txt"), "x");
		const dirs0 = dirCompletions("", proj);
		check("dir picker: dirs only, trailing /", dirs0.map((d) => d.label).join(",") === "docs/,src/", JSON.stringify(dirs0));
		const dirs1 = dirCompletions("sr", proj);
		check("dir picker: prefix filter + full value", dirs1.length === 1 && dirs1[0]!.value === "src/" && dirs1[0]!.label === "src/");
		const dirs2 = dirCompletions("src/", proj);
		check("dir picker: subdir navigation", dirs2.length === 1 && dirs2[0]!.value === "src/nested/", JSON.stringify(dirs2));
		const files = dirCompletions("a", proj, { includeFiles: true });
		check("file picker (--config): files included", files.some((f) => f.label === "a.txt" && f.description === "file"));
		const abs = dirCompletions(proj + "/s", proj);
		check("dir picker: absolute prefix", abs.length === 1 && abs[0]!.value === proj + "/src/", JSON.stringify(abs));
		const tilde = dirCompletions("~/", proj);
		check("dir picker: ~ expansion", tilde.length > 0 && tilde.every((d) => d.value.startsWith("~/")));
		// Full-argument replacement contract (applyCompletion replaces the whole arg string).
		const arg0 = await worktreeArgumentCompletions("", proj);
		check("arg completions: empty → cwd dirs", arg0.some((c) => c.value === "src/"), JSON.stringify(arg0));
		check("arg completions name the parameter", arg0.length > 0 && arg0[0]!.description === "worktree path (required)", JSON.stringify(arg0[0]));
		const argBranch = await worktreeArgumentCompletions("wt ", proj);
		check("arg completions: trailing space → branch position, full values", argBranch.every((c) => c.value.startsWith("wt ")));
		const argFlag = await worktreeArgumentCompletions("wt --f", proj);
		check("arg completions: flag names keep base", argFlag.some((c) => c.value === "wt --force-reindex") && argFlag.some((c) => c.value === "wt --from"), JSON.stringify(argFlag));
		const argFrom = await worktreeArgumentCompletions("wt --from ", proj);
		check("arg completions: --from value position", argFrom.every((c) => c.value.startsWith("wt --from ")));
		const argConfig = await worktreeArgumentCompletions("wt --config a", proj);
		check("arg completions: --config value position keeps base", argConfig.some((c) => c.value === "wt --config a.txt" && c.label === "a.txt"), JSON.stringify(argConfig));
	}

	// ── 3. adoptConfigFile strips secrets ─────────────────────────────
	section("adoptConfigFile");
	{
		const cfgPath = path.join(tmp, "existing-chhound.json");
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				embedding: { provider: "voyageai", model: "voyage-3.5", rerank_model: "rerank-2.5", api_key: "sk-SECRET" },
				indexing: { include: ["**/*.rs"], per_file_timeout_seconds: 8 },
				database: { provider: "duckdb", path: "/ignored" },
			}),
		);
		const { adopted, warnings } = adoptConfigFile(cfgPath, tmp);
		check("embedding folded", adopted.embedding?.provider === "voyageai" && adopted.embedding?.model === "voyage-3.5");
		check("rerank_model mapped", adopted.embedding?.rerankModel === "rerank-2.5");
		check("api_key adopted into settings", adopted.embedding?.apiKey === "sk-SECRET");
		check("api_key adoption noted", warnings.some((w) => w.includes("api_key")), warnings.join("; "));
		check("database warning", warnings.some((w) => w.includes("database")));
	}

	// ── 3. materializeConfig ──────────────────────────────────────────
	section("materializeConfig");
	{
		const dir = path.join(tmp, "cfg-out");
		const dbDir = path.join(dir, ".chhound.db");
		const p = materializeConfig(dir, { settings, dbDir });
		const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		const db = cfg.database as Record<string, unknown>;
		check("duckdb pinned", db.provider === "duckdb" && db.path === dbDir);
		check("no api_key without key in settings", JSON.stringify(cfg).includes("api_key") === false);
		const excludes = (cfg.indexing as Record<string, unknown>).exclude as string[];
		check("chhound exclusion guaranteed", excludes.includes("**/.chhound/**"));

		// With a key in settings, the materialized config carries it (v1) — 0600.
		const dir2 = path.join(tmp, "cfg-keyed");
		const p2 = materializeConfig(dir2, { settings: { ...settings, embedding: { apiKey: "sk-KEY" } }, dbDir: path.join(dir2, ".chhound.db") });
		const cfg2 = JSON.parse(fs.readFileSync(p2, "utf8")) as Record<string, unknown>;
		check("api_key materialized when set", (cfg2.embedding as Record<string, unknown>).api_key === "sk-KEY");
		check("config file 0600", (fs.statSync(p2).mode & 0o777) === 0o600, `mode=${(fs.statSync(p2).mode & 0o777).toString(8)}`);
	}

	// ── 4. scratch git repo + baseline prime ─────────────────────────
	section("baseline prime");
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo);
	await runGit(["init", "-b", "main"], { cwd: repo });
	await runGit(["config", "user.email", "smoke@test"], { cwd: repo });
	await runGit(["config", "user.name", "Smoke"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit = await runGit(["commit", "-m", "init"], { cwd: repo });
	check("seed commit", commit.code === 0, commit.stderr);
	const baseCommit = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;

	const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
	const extraArgs = ["--no-embeddings"];
	const b1 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline primed", b1.fresh && fs.existsSync(b1.dbDir), b1.dir);
	check("baseline meta commit", b1.meta.baseCommit === baseCommit);
	check("baseline no artifacts in repo", !fs.existsSync(path.join(repo, ".chhound")), "found .chhound in repo");
	const wtClean1 = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after prime", wtClean1 === "", wtClean1);

	const b2 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline fresh on re-run", b2.fresh === false);

	// Base moved → refresh must re-prime via in-place top-up.
	fs.writeFileSync(path.join(repo, "b2.md"), "# more\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit2 = await runGit(["commit", "-m", "more"], { cwd: repo });
	check("second commit", commit2.code === 0, commit2.stderr);
	const baseCommit2 = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;
	const b3 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline refreshed on base move", b3.fresh === true && b3.meta.baseCommit === baseCommit2, b3.reason);

	// ── 5. worktree spin-up: copy + top-up ────────────────────────────
	section("worktree spin-up");
	const wt = path.join(tmp, "wt-fix");
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	const branch = await currentBranch(wt);
	check("worktree branch", branch === "fix/smoke", branch);

	const branches = await branchCompletions(repo);
	check("branch completions include new branch", branches.some((b) => b.value === "fix/smoke"), branches.map((b) => b.value).join(","));
	const argComp = await worktreeArgumentCompletions("wt fix", repo);
	check("arg completions: branch position", argComp.some((b) => b.value === "wt fix/smoke"), JSON.stringify(argComp));

	// Repo resolution from a non-repo cwd (the workspace-root scenario).
	const resolved = await findRepoRoot(path.join(repo, "sub", "deep"));
	check("findRepoRoot walks up from nested dir", resolved === repo, `${resolved} vs ${repo}`);
	const none = await findRepoRoot(path.join(tmp, "not-a-repo"));
	check("findRepoRoot undefined outside repos", none === undefined, `${none}`);
	check("deriveWorktreePath sibling", deriveWorktreePath(repo) === path.join(tmp, "repo-wt"), deriveWorktreePath(repo));
	const argComp2 = await worktreeArgumentCompletions("repo fix", tmp);
	check("arg completions resolve repo from path (cwd not a repo)", argComp2.some((b) => b.value === "repo fix/smoke"), JSON.stringify(argComp2));

	const sandboxDir = sandboxDirFor(repo, wt, settings);
	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	const r = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: wt, configPath, onLine, extraArgs });
	check("index ok", r.code === 0, `code=${r.code}`);
	check("db copied from baseline", r.copied === true && fs.existsSync(dbDir));
	check("db bigger than baseline copy (top-up added c.ts)", dirSize(dbDir) > 0);

	const excludePath = await repoExcludePath(wt);
	if (excludePath) {
		fs.mkdirSync(path.dirname(excludePath), { recursive: true });
		fs.appendFileSync(excludePath, "\n.chhound/\n.chhound.json\n");
	}
	const excl = excludePath ? fs.readFileSync(excludePath, "utf8") : "";
	check("repo git exclude", !!excludePath && excl.includes(".chhound/"), excludePath ?? "no exclude path");
	// Prove the exclude actually bites (common-dir exclude applies repo-wide).
	fs.mkdirSync(path.join(wt, ".chhound"), { recursive: true });
	fs.writeFileSync(path.join(wt, ".chhound", "daemon.log"), "log\n");
	const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
	check("worktree ignores .chhound (daemon.log untracked noise)", !wtStatus.includes(".chhound"), wtStatus);
	const repoStatus = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after worktree+index", repoStatus === "", repoStatus);

	writeSandboxMeta(sandboxDir, {
		version: 1,
		worktree: wt,
		branch,
		baseRef: "main",
		baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: b2.dbDir,
		dbPath: dbDir,
	});

	// ── 6. listing + prune ────────────────────────────────────────────
	section("status: list + prune");
	const sandboxes = listSandboxes(settings);
	check("sandbox listed", sandboxes.length === 1 && sandboxes[0]!.meta.worktree === wt);
	check("db size reported", sandboxes[0]!.dbSizeBytes > 0);
	const baselines = listBaselines(settings);
	check("baseline listed", baselines.length === 1 && !!baselines[0]!.meta);
	await runGit(["worktree", "remove", "--force", wt], { cwd: repo });
	await runGit(["branch", "-D", "fix/smoke"], { cwd: repo });
	const removed = pruneSandboxes(settings);
	check("prune removed orphan sandbox", removed.length === 1 && listSandboxes(settings).length === 0);
	check("config path helper", sandboxConfigPath(sandboxDir).endsWith(path.join(sandboxDir, "chhound.json")));

	// ── 7. settings round-trip (project scope, in scratch) ────────────
	section("settings round-trip");
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(path.join(proj, ".pi", "pi-chhound"), { recursive: true });
	const saved = saveSettings(
		{ ...settings, embedding: { provider: "voyageai", model: "voyage-3.5", apiKey: "sk-ROUNDTRIP" } },
		"project",
		proj,
	);
	const loaded = loadSettings(proj);
	check("project settings round-trip", loaded.settings.embedding?.model === "voyage-3.5", saved);
	check("api key round-trips through settings", loaded.settings.embedding?.apiKey === "sk-ROUNDTRIP");
	check("settings file 0600", (fs.statSync(saved).mode & 0o777) === 0o600, `mode=${(fs.statSync(saved).mode & 0o777).toString(8)}`);
	check("project path used", loaded.projectPath === saved);

	// ── 8. extension loads ────────────────────────────────────────────
	section("extension entry loads");
	{
		const mod = (await import("../index.js")) as { default: unknown };
		check("index.ts default export is a function", typeof mod.default === "function");
	}

	console.log(`\n${checks - failures}/${checks} checks passed`);
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error("smoke crashed:", err);
	process.exit(1);
});
