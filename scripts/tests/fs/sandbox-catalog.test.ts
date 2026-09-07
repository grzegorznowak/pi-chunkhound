import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { baselineDirFor, listBaselines } from "../../../chhound/baseline.js";
import { runGit } from "../../../chhound/git.js";
import { claimedRootMatches, listSandboxes, pruneSandboxes, readClaimedRoot, sandboxConfigPath, sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta } from "../../../chhound/sandbox.js";
import type { BaselineMeta, ChhoundSettings, SandboxMeta } from "../../../chhound/types.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 11 legacy checks moved from smoke.ts section 15 (status: list +
// prune). SELF-OWNED fixture — the legacy section consumed the shared
// engine-produced sandbox and destroyed it (git worktree remove + prune);
// here a real git repo/worktree plus handcrafted meta/state and fake db bytes
// (never opened by the engine) reproduce the listing/claim/prune lifecycle in
// isolation. HOME is fake and GIT_CONFIG_NOSYSTEM=1 so git never reads the
// operator's config. Git setup failures abort the scenario (infrastructure),
// they are not silently ignored.

describe("sandbox catalog", () => {
	test("legacy status list + prune obligations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-sandbox-catalog-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
			};
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			const git = async (args: string[], opts: { cwd?: string } = {}): Promise<void> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
			};
			await git(["init", "-b", "main"], { cwd: repo });
			await git(["config", "user.name", "smoke"], { cwd: repo });
			await git(["config", "user.email", "smoke@test"], { cwd: repo });
			fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
			await git(["add", "seed.txt"], { cwd: repo });
			await git(["commit", "-m", "seed"], { cwd: repo });
			const sha = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;
			await git(["branch", "fix/smoke"], { cwd: repo });
			const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
			const wt = path.join(sandboxDir, "fix-smoke");
			fs.mkdirSync(sandboxDir, { recursive: true });
			await git(["worktree", "add", wt, "fix/smoke"], { cwd: repo });
			const stateDir = sandboxStateDir(sandboxDir);
			const dbDir = sandboxDbDir(sandboxDir);
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(dbDir, "fake catalog db bytes — never opened by the engine\n");
			const meta: SandboxMeta = {
				version: 1,
				worktree: wt,
				repoRoot: repo,
				branch: "fix/smoke",
				baseRef: "main",
				baseCommit: sha,
				chhoundVersion: "test-fixture",
				createdAt: "2026-09-07T00:00:00.000Z",
				copiedFrom: "",
				dbPath: dbDir,
			};
			writeSandboxMeta(stateDir, meta);
			const bDir = baselineDirFor(repo, "main", settings);
			const bMeta: BaselineMeta = {
				version: 1,
				repoRoot: repo,
				baseRef: "main",
				baseCommit: sha,
				chhoundVersion: "test-fixture",
				updatedAt: "2026-09-07T00:00:00.000Z",
			};
			fs.mkdirSync(bDir, { recursive: true });
			fs.writeFileSync(path.join(bDir, "meta.json"), JSON.stringify(bMeta, null, 2) + "\n", "utf8");

			const sandboxes = listSandboxes(settings);
			await check(t, "sandbox listed", sandboxes.length === 1 && sandboxes[0]!.meta.worktree === wt);
			await check(t, "db size reported", sandboxes[0]!.dbSizeBytes > 0);
			// chunkhound's root-claim sidecar (written at index time) — Design 1: it
			// claims the SANDBOX DIR (the daemon's project dir), not the checkout.
			const claimPath = `${dbDir}.root.json`;
			fs.writeFileSync(claimPath, JSON.stringify({ version: 1, indexed_root_path: sandboxDir }) + "\n", "utf8");
			await check(t, "claimed root read from sidecar", readClaimedRoot(dbDir) === sandboxDir);
			const claimed = listSandboxes(settings);
			await check(t, "sandbox entry carries claimed root", claimed[0]!.claimedRoot === sandboxDir);
			await check(t, "claimed root matches sandbox dir", claimedRootMatches(claimed[0]!.claimedRoot!, sandboxDir));
			await check(t, "mismatch detected", !claimedRootMatches(claimed[0]!.claimedRoot!, "/somewhere/else"));
			await check(t, "trailing-slash mismatch tolerated", claimedRootMatches(`${sandboxDir}/`, sandboxDir));
			fs.rmSync(claimPath, { force: true });
			await check(t, "missing sidecar → unclaimed", listSandboxes(settings)[0]!.claimedRoot === undefined);
			const baselines = listBaselines(settings);
			await check(t, "baseline listed", baselines.length === 1 && !!baselines[0]!.meta);
			await git(["worktree", "remove", "--force", wt], { cwd: repo });
			await git(["branch", "-D", "fix/smoke"], { cwd: repo });
			const removed = pruneSandboxes(settings);
			await check(t, "prune removed orphan sandbox", removed.length === 1 && listSandboxes(settings).length === 0);
			await check(t, "config path helper", sandboxConfigPath(sandboxDir).endsWith(path.join(sandboxDir, ".chunkhound.json")));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
