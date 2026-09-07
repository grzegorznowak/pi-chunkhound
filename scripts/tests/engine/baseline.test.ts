import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ensureBaseline } from "../../../chhound/baseline.js";
import { runGit } from "../../../chhound/git.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 12 legacy checks moved from smoke.ts section "baseline anchor:
// local first" (the whole independent block). Repo A: local main @ c1 while a
// local bare origin carries a DIFFERENT main tip c2 (fetched → origin/main =
// c2). Worktrees are cut from local state, so the baseline must anchor c1 —
// never the origin tip. Repo B: local main renamed away → resolution falls
// back to origin/main. opts.ref override lands in its own (repo, ref) slot.
// Self-owned fixture and settings root; the prime/refresh half of the legacy
// baseline section joins this file in a later commit with its own context.

async function git(args: string[], opts: { cwd?: string } = {}): Promise<void> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function gitOk(args: string[], opts: { cwd?: string } = {}): Promise<string> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

describe("baseline anchor", () => {
	test("legacy local-first anchor obligations", async (tc) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-baseline-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: engine.binary } }));
			const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
			const extraArgs = ["--no-embeddings"];
			// Materialized engine configs force watchman by default (config.ts
			// REALTIME_BACKEND_DEFAULT); the config file wins over the
			// CHUNKHOUND_INDEXING__REALTIME_BACKEND env var, so baseline configs
			// opt into the engine's polling backend here.
			const anchorSettings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "anchor-bases"), indexing: { realtimeBackend: "polling" } };

			// Repo A: local main @ c1 while a local bare origin carries a DIFFERENT
			// main tip c2 (fetched → origin/main = c2). Worktrees are cut from local
			// state, so the baseline must anchor c1 — not the origin tip.
			const repoA = path.join(root, "anchor-a");
			fs.mkdirSync(repoA);
			await git(["init", "-b", "main"], { cwd: repoA });
			await git(["config", "user.email", "smoke@test"], { cwd: repoA });
			await git(["config", "user.name", "Smoke"], { cwd: repoA });
			fs.writeFileSync(path.join(repoA, "a.ts"), "export const a = 1;\n");
			await git(["add", "-A"], { cwd: repoA });
			await git(["commit", "-qm", "local c1"], { cwd: repoA });
			const c1 = await gitOk(["rev-parse", "HEAD"], { cwd: repoA });

			const bare = path.join(root, "anchor-origin.git");
			fs.mkdirSync(bare);
			await git(["init", "--bare", bare], { cwd: root });
			const feeder = path.join(root, "anchor-feeder");
			await git(["clone", "-q", repoA, feeder], { cwd: root });
			await git(["config", "user.email", "smoke@test"], { cwd: feeder });
			await git(["config", "user.name", "Smoke"], { cwd: feeder });
			fs.writeFileSync(path.join(feeder, "b.ts"), "export const b = 2;\n");
			await git(["add", "-A"], { cwd: feeder });
			await git(["commit", "-qm", "remote c2"], { cwd: feeder });
			const c2 = await gitOk(["rev-parse", "HEAD"], { cwd: feeder });
			// Feeder already has an origin (the clone source) — re-point it at the
			// bare repo, then advance the bare origin's main to c2.
			await git(["remote", "set-url", "origin", bare], { cwd: feeder });
			const pushed = await runGit(["push", "-q", "origin", "main"], { cwd: feeder });
			await check(tc, "setup: bare origin advanced to c2", pushed.code === 0 && (await runGit(["rev-parse", "main"], { cwd: bare })).stdout === c2, pushed.stderr || "bare main not at c2");
			await check(tc, "setup: origin tip differs from local tip", c2 !== c1, "same commit — test can't discriminate");
			await git(["remote", "add", "origin", bare], { cwd: repoA });
			const fetchedA = await runGit(["fetch", "-q", "origin", "main"], { cwd: repoA });
			const originTip = await gitOk(["rev-parse", "--verify", "origin/main^{commit}"], { cwd: repoA });
			await check(tc, "setup: origin/main fetched and ahead of local main", fetchedA.code === 0 && originTip === c2, `${fetchedA.stderr || originTip.slice(0, 8)} vs ${c1.slice(0, 8)}`);

			const a1 = await ensureBaseline({ repoRoot: repoA, settings: anchorSettings, onLine, extraArgs });
			await check(tc, "anchor: LOCAL tip preferred over fetched origin/main", a1.fresh && a1.meta.baseCommit === c1, `${a1.meta.baseCommit.slice(0, 8)} (origin/main=${originTip.slice(0, 8)})`);
			await check(tc, "anchor: baseline ref name kept", a1.ref === "main", a1.ref);
			const a2 = await ensureBaseline({ repoRoot: repoA, settings: anchorSettings, onLine, extraArgs });
			await check(tc, "anchor: re-run stays fresh against local tip (origin ignored)", a2.fresh === false, a2.reason);
			const anchorStatus = (await runGit(["status", "--porcelain"], { cwd: repoA })).stdout;
			await check(tc, "anchor: repo clean after prime", anchorStatus === "", anchorStatus);

			// Repo B: local main renamed away (revParse('main') = null) while
			// origin/main exists → resolution must fall back to origin/main.
			const repoB = path.join(root, "anchor-b");
			await git(["clone", "-q", repoA, repoB], { cwd: root });
			await git(["remote", "set-url", "origin", bare], { cwd: repoB });
			const fetchedB = await runGit(["fetch", "-q", "origin", "main"], { cwd: repoB });
			await git(["branch", "-m", "main", "dev"], { cwd: repoB });
			const originB = await gitOk(["rev-parse", "--verify", "origin/main^{commit}"], { cwd: repoB });
			const mainGone = (await runGit(["rev-parse", "--verify", "--quiet", "main^{commit}"], { cwd: repoB })).code !== 0;
			await check(tc, "setup: local main gone, origin/main present", fetchedB.code === 0 && originB === c2 && mainGone, `fetch=${fetchedB.stderr || "ok"} origin/main=${originB.slice(0, 8)} mainGone=${mainGone}`);
			const b1 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, onLine, extraArgs });
			await check(tc, "anchor: falls back to origin/main when local ref missing", b1.fresh && b1.meta.baseCommit === c2, `${b1.meta.baseCommit.slice(0, 8)} vs ${c2.slice(0, 8)}`);

			// opts.ref override: naming the actual base branch (local dev) must be
			// honored and land in its own (repo, ref) baseline slot.
			const dev1 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, ref: "dev", onLine, extraArgs });
			await check(tc, "anchor: ref override honored (local dev tip)", dev1.fresh && dev1.ref === "dev" && dev1.meta.baseCommit === c1, `${dev1.ref} @ ${dev1.meta.baseCommit.slice(0, 8)}`);
			await check(tc, "anchor: override lands in its own slot", dev1.dir !== b1.dir, `${dev1.dir} vs ${b1.dir}`);
			const dev2 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, ref: "dev", onLine, extraArgs });
			await check(tc, "anchor: override re-run stays fresh", dev2.fresh === false, dev2.reason);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
