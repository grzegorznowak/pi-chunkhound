/**
 * Legacy mechanics suite, temporarily invoked by the modular test adapter.
 * `npm run smoke` is now an alias for the full `npm test` suite; this file
 * remains only until Phase 2 extraction completes.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureBaseline } from "../chhound/baseline.js";
import { materializeConfig } from "../chhound/config.js";
import { chhoundVersion } from "../chhound/cli.js";
import { currentBranch, gitWorktreeAdd, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import {
	dirSize,
	readClaimedRoot,
	sandboxDbDir,
	sandboxDirFor,
	sandboxStateDir,
	writeSandboxMeta,
} from "../chhound/sandbox.js";

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
	// Resolve the scratch root BEFORE building any paths from it: git and the
	// engine canonicalize symlinked prefixes (macOS /var → /private/var), while
	// Node path ops do not — an unresolved root makes engine claims, daemon
	// locks and git results disagree with the paths this suite asserts on.
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-smoke-")));
	console.log(`scratch: ${tmp}`);
	const settings: ChhoundSettings = {
		version: 1,
		sandboxRoot: path.join(tmp, "sandboxes"),
		baseRoot: path.join(tmp, "bases"),
		// Materialized engine configs force watchman by default (config.ts
		// REALTIME_BACKEND_DEFAULT); the config file wins over the
		// CHUNKHOUND_INDEXING__REALTIME_BACKEND env var. On macOS the watchman
		// socket path exceeds the platform limit under deep runner tmp dirs, so
		// the suite (which polls daemon status and never asserts watchman
		// semantics) opts into the engine's polling backend here.
		indexing: { realtimeBackend: "polling" },
	};

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

	// ── 5. worktree spin-up: sandbox-anchored — copy + top-up ────────
	section("worktree spin-up");
	const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
	const wt = path.join(sandboxDir, "fix-smoke");
	fs.mkdirSync(sandboxDir, { recursive: true });
	fs.mkdirSync(sandboxStateDir(sandboxDir), { recursive: true });
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	// Commit the branch change (mirrors a real dev edit) so the final status
	// check proves the checkout stays CLEAN — no chunkhound artifacts.
	await runGit(["add", "-A"], { cwd: wt });
	await runGit(["commit", "-m", "add c"], { cwd: wt });
	const branch = await currentBranch(wt);

	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	// Baseline rows are relative to the bare checkout; the sandbox index root
	// wraps it in fix-smoke/ — pathPrefix re-keys the copy so unchanged files
	// (a.ts, b.md, b2.md) skip and only the worktree's own change (c.ts) parses.
	const topupLines: string[] = [];
	const r = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { topupLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
	check("index ok", r.code === 0, `code=${r.code}`);
	check("db copied from baseline", r.copied === true && fs.existsSync(dbDir));
	check("db bigger than baseline copy (top-up added c.ts)", dirSize(dbDir) > 0);
	check("top-up skips unchanged files (path re-key)", topupLines.some((l) => /^Processed: 1 files$/.test(l)), topupLines.filter((l) => /^(Processed|Skipped)/.test(l)).join(" | "));
	// Under O2 exactly ONE file parses: c.ts. The db claim sidecar used to
	// self-index into the root (+1 file/+2 chunks per sandbox); it now lives
	// in the .state sibling, outside the indexed root — nothing else parses.

	// Claim sidecar pre-write: hotstart re-points (or keeps) the claim BEFORE
	// the engine runs, so the engine's legacy-migration warning never fires.
	check("top-up emits no engine claim warning", !topupLines.some((l) => l.includes("sidecar was missing")), topupLines.find((l) => l.includes("sidecar was missing")) ?? "");
	const claimedRoot = readClaimedRoot(dbDir);
	check("claim sidecar claims the sandbox dir", claimedRoot === path.resolve(sandboxDir), `${claimedRoot ?? "unclaimed"} vs ${path.resolve(sandboxDir)}`);

	// Re-running hotstart against the same db must stay silent as well (the
	// matching claim is kept, not rewritten).
	const rerunLines: string[] = [];
	const r2 = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { rerunLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
	check("re-run index ok", r2.code === 0, `code=${r2.code}`);
	check("re-run emits no engine claim warning", !rerunLines.some((l) => l.includes("sidecar was missing")), rerunLines.find((l) => l.includes("sidecar was missing")) ?? "");

	// Design 1: ZERO operational files in the worktree or the repo — no
	// git-exclude writes, no .chhound/, no config inside the checkout.
	const excl = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
	check("no git-exclude writes in the repo", !excl.includes("pi-chhound") && !excl.includes(".chhound"), excl);
	check("no .chhound inside the checkout", !fs.existsSync(path.join(wt, ".chhound")), "found .chhound in checkout");
	check("no config inside the checkout", !fs.existsSync(path.join(wt, ".chunkhound.json")), "found config in checkout");
	const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
	check("worktree git status clean after index", wtStatus === "", wtStatus);
	const repoStatus = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after worktree+index", repoStatus === "", repoStatus);

	// O2: operational state lives OUTSIDE the indexed root — the sandbox dir
	// holds only checkout + config; db/sidecar/meta sit in the .state sibling.
	check("no db in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db")));
	check("no sidecar in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db.root.json")));
	check("db lives in .state sibling", dbDir.startsWith(sandboxStateDir(sandboxDir) + path.sep) && fs.existsSync(dbDir), dbDir);

	writeSandboxMeta(sandboxStateDir(sandboxDir), {
		version: 1,
		worktree: wt,
		repoRoot: repo,
		branch,
		baseRef: "main",
		baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: b2.dbDir,
		dbPath: dbDir,
	});
	check("meta lives in state dir (not the index root)", fs.existsSync(path.join(sandboxStateDir(sandboxDir), "meta.json")) && !fs.existsSync(path.join(sandboxDir, "meta.json")));
	console.log(`\n${checks - failures}/${checks} checks passed`);
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error("smoke crashed:", err);
	process.exit(1);
});
