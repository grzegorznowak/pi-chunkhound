import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ensureBaseline } from "../../../chhound/baseline.js";
import { chhoundVersion } from "../../../chhound/cli.js";
import { materializeConfig } from "../../../chhound/config.js";
import { currentBranch, gitWorktreeAdd, runGit } from "../../../chhound/git.js";
import { hotStartIndex } from "../../../chhound/hotstart.js";
import {
	dirSize,
	readClaimedRoot,
	sandboxDbDir,
	sandboxDirFor,
	sandboxStateDir,
	writeSandboxMeta,
} from "../../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 17 legacy checks moved from smoke.ts section "worktree spin-up"
// (hotstart half): db copy + top-up from a primed baseline (pathPrefix re-key
// → exactly one processed file), claim sidecar pre-write (no engine warning),
// silent re-run, ZERO operational files in the checkout/repo (O2), db in the
// .state sibling, meta placement. The recipe mirrors the legacy flow with its
// OWN fixture (the buildIndexedSandbox helper runs hotstart internally and
// hides the r/copied results these checks assert on, so the recipe is inline):
// prime the baseline first, cut the worktree at the same tip, commit the
// worktree's own file, then hotstart into the sandbox. No cross-file state.

async function git(args: string[], opts: { cwd?: string } = {}): Promise<void> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function gitOk(args: string[], opts: { cwd?: string } = {}): Promise<string> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

describe("sandbox hotstart", () => {
	test("legacy hotstart + O2 layout obligations", async (tc) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-sandbox-hotstart-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: engine.binary } }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
				// Materialized engine configs force watchman by default (config.ts
				// REALTIME_BACKEND_DEFAULT); the config file wins over the
				// CHUNKHOUND_INDEXING__REALTIME_BACKEND env var, so the materialized
				// sandbox config opts into the engine's polling backend here.
				indexing: { realtimeBackend: "polling" },
			};

			// Scratch repo prime — the source baseline rows (a.ts + b.md) the
			// sandbox db is copied from.
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await git(["config", "user.email", "smoke@test"], { cwd: repo });
			await git(["config", "user.name", "Smoke"], { cwd: repo });
			fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
			fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
			await git(["add", "-A"], { cwd: repo });
			await git(["commit", "-qm", "init"], { cwd: repo });
			const baseCommit = await gitOk(["rev-parse", "HEAD"], { cwd: repo });
			const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
			const extraArgs = ["--no-embeddings"];
			const b = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });

			// Worktree on fix/smoke with its own file commit (mirrors a real dev
			// edit, so the final status check proves the checkout stays CLEAN).
			const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
			const wt = path.join(sandboxDir, "fix-smoke");
			fs.mkdirSync(sandboxDir, { recursive: true });
			fs.mkdirSync(sandboxStateDir(sandboxDir), { recursive: true });
			await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
			fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
			await git(["add", "-A"], { cwd: wt });
			await git(["commit", "-m", "add c"], { cwd: wt });
			const branch = await currentBranch(wt);

			const dbDir = sandboxDbDir(sandboxDir);
			const configPath = materializeConfig(sandboxDir, { settings, dbDir });
			// Baseline rows are relative to the bare checkout; the sandbox index root
			// wraps it in fix-smoke/ — pathPrefix re-keys the copy so unchanged files
			// (a.ts, b.md) skip and only the worktree's own change (c.ts) parses.
			const topupLines: string[] = [];
			const r = await hotStartIndex({ sourceDbDir: b.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { topupLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
			await check(tc, "index ok", r.code === 0, `code=${r.code}`);
			await check(tc, "db copied from baseline", r.copied === true && fs.existsSync(dbDir));
			await check(tc, "db bigger than baseline copy (top-up added c.ts)", dirSize(dbDir) > 0);
			await check(tc, "top-up skips unchanged files (path re-key)", topupLines.some((l) => /^Processed: 1 files$/.test(l)), topupLines.filter((l) => /^(Processed|Skipped)/.test(l)).join(" | "));
			// Under O2 exactly ONE file parses: c.ts. The db claim sidecar used to
			// self-index into the root (+1 file/+2 chunks per sandbox); it now lives
			// in the .state sibling, outside the indexed root — nothing else parses.

			// Claim sidecar pre-write: hotstart re-points (or keeps) the claim BEFORE
			// the engine runs, so the engine's legacy-migration warning never fires.
			await check(tc, "top-up emits no engine claim warning", !topupLines.some((l) => l.includes("sidecar was missing")), topupLines.find((l) => l.includes("sidecar was missing")) ?? "");
			const claimedRoot = readClaimedRoot(dbDir);
			await check(tc, "claim sidecar claims the sandbox dir", claimedRoot === path.resolve(sandboxDir), `${claimedRoot ?? "unclaimed"} vs ${path.resolve(sandboxDir)}`);

			// Re-running hotstart against the same db must stay silent as well (the
			// matching claim is kept, not rewritten).
			const rerunLines: string[] = [];
			const r2 = await hotStartIndex({ sourceDbDir: b.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { rerunLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
			await check(tc, "re-run index ok", r2.code === 0, `code=${r2.code}`);
			await check(tc, "re-run emits no engine claim warning", !rerunLines.some((l) => l.includes("sidecar was missing")), rerunLines.find((l) => l.includes("sidecar was missing")) ?? "");

			// Design 1: ZERO operational files in the worktree or the repo — no
			// git-exclude writes, no .chhound/, no config inside the checkout.
			const excl = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
			await check(tc, "no git-exclude writes in the repo", !excl.includes("pi-chhound") && !excl.includes(".chhound"), excl);
			await check(tc, "no .chhound inside the checkout", !fs.existsSync(path.join(wt, ".chhound")), "found .chhound in checkout");
			await check(tc, "no config inside the checkout", !fs.existsSync(path.join(wt, ".chunkhound.json")), "found config in checkout");
			const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
			await check(tc, "worktree git status clean after index", wtStatus === "", wtStatus);
			const repoStatus = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
			await check(tc, "repo clean after worktree+index", repoStatus === "", repoStatus);

			// O2: operational state lives OUTSIDE the indexed root — the sandbox dir
			// holds only checkout + config; db/sidecar/meta sit in the .state sibling.
			await check(tc, "no db in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db")));
			await check(tc, "no sidecar in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db.root.json")));
			await check(tc, "db lives in .state sibling", dbDir.startsWith(sandboxStateDir(sandboxDir) + path.sep) && fs.existsSync(dbDir), dbDir);

			writeSandboxMeta(sandboxStateDir(sandboxDir), {
				version: 1,
				worktree: wt,
				repoRoot: repo,
				branch,
				baseRef: "main",
				baseCommit,
				chhoundVersion: await chhoundVersion(),
				createdAt: new Date().toISOString(),
				copiedFrom: b.dbDir,
				dbPath: dbDir,
			});
			await check(tc, "meta lives in state dir (not the index root)", fs.existsSync(path.join(sandboxStateDir(sandboxDir), "meta.json")) && !fs.existsSync(path.join(sandboxDir, "meta.json")));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
