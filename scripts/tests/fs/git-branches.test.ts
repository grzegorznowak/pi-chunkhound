import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { currentBranch, defaultRemoteBranch, findRepoRoot, gitWorktreeAdd, runGit } from "../../../chhound/git.js";
import { sandboxDirFor } from "../../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { resolveBranchChoice } from "../../../worktree/command.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

async function git(args: string[], opts: { cwd?: string } = {}): Promise<void> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function gitOk(args: string[], opts: { cwd?: string } = {}): Promise<string> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

// Inventory: 3 legacy checks moved from smoke.ts section 9 (default branch),
// git-branches half. Real local git repos, no remotes needed — origin/HEAD
// symbolic refs are manufactured directly. PLUS 19 legacy checks moved from
// smoke.ts section "worktree spin-up" (branch-resolution half): worktree
// creation/placement, the branch-choice matrix (in-use / free / unknown /
// occupied suffix), remote-branch intent + one-go errors, detached remote
// checkout mechanics and repo-root walk-up. Env-isolated (fake HOME) because
// the branch-resolution fixtures commit and create real worktrees.

describe("defaultRemoteBranch", () => {
	test("legacy defaultRemoteBranch obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-git-branches-");
		try {
			// defaultRemoteBranch normalization: origin/HEAD stored as
			// ref: refs/remotes/origin/main must resolve to "main", not "remotes/origin/main".
			const repo3 = path.join(root, "head-repo");
			fs.mkdirSync(repo3);
			await runGit(["init", "-b", "main"], { cwd: repo3 });
			await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo3 });
			await check(t, "defaultRemoteBranch normalizes remotes/ prefix", (await defaultRemoteBranch(repo3)) === "main", await defaultRemoteBranch(repo3));
			const repo4 = path.join(root, "head-repo2");
			fs.mkdirSync(repo4);
			await runGit(["init", "-b", "main"], { cwd: repo4 });
			await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo4 });
			await runGit(["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo4 });
			await check(t, "defaultRemoteBranch origin/ form", (await defaultRemoteBranch(repo4)) === "main", await defaultRemoteBranch(repo4));
			const repo5 = path.join(root, "no-head");
			fs.mkdirSync(repo5);
			await runGit(["init", "-b", "main"], { cwd: repo5 });
			await check(t, "defaultRemoteBranch undefined without origin/HEAD", (await defaultRemoteBranch(repo5)) === undefined, String(await defaultRemoteBranch(repo5)));
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

describe("worktree add + branch resolution", () => {
	test("legacy worktree branch + resolution obligations", async (tc) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-git-branches-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
			};

			// Repo + in-use worktree fixture (branch fix/smoke). The matrix below
			// treats a branch checked out in ANY worktree as in-use; the legacy
			// hotstart/O2 assertions the worktree fed stay in smoke until the
			// sandbox-hotstart migration, so only the worktree location/branch
			// state and the resolution answers are asserted here.
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await git(["config", "user.email", "smoke@test"], { cwd: repo });
			await git(["config", "user.name", "Smoke"], { cwd: repo });
			fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
			await git(["add", "-A"], { cwd: repo });
			await git(["commit", "-qm", "init"], { cwd: repo });
			const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
			const wt = path.join(sandboxDir, "fix-smoke");
			fs.mkdirSync(sandboxDir, { recursive: true });
			await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
			const branch = await currentBranch(wt);
			await check(tc, "worktree branch", branch === "fix/smoke", branch);
			await check(tc, "worktree inside sandbox dir", wt.startsWith(sandboxDir + path.sep), wt);

			// Remote-branch resolution needs a remote: a bare clone of `repo` becomes
			// its origin, carrying branches that exist only remotely (never local).
			const branchBare = path.join(root, "branch-origin.git");
			const branchClone = await runGit(["clone", "-q", "--bare", repo, branchBare], { cwd: root });
			await check(tc, "setup: branch-origin bare cloned", branchClone.code === 0, branchClone.stderr);
			const mainSha = await gitOk(["rev-parse", "main"], { cwd: repo });
			const addRemoteOnly = await runGit(["--git-dir", branchBare, "update-ref", "refs/heads/remote-only", mainSha], { cwd: root });
			const addOrigin = await runGit(["remote", "add", "origin", branchBare], { cwd: repo });
			const fetched = await runGit(["fetch", "-q", "origin"], { cwd: repo });
			await check(
				tc,
				"setup: origin with a remote-only branch",
				addRemoteOnly.code === 0 && addOrigin.code === 0 && fetched.code === 0 &&
					(await runGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/remote-only"], { cwd: repo })).code === 0,
				`${addRemoteOnly.stderr || addOrigin.stderr || fetched.stderr}`,
			);
			// A branch added to the origin AFTER the last fetch — the resolver's own
			// best-effort fetch must pick it up.
			const addLater = await runGit(["--git-dir", branchBare, "update-ref", "refs/heads/remote-later", mainSha], { cwd: root });
			await check(tc, "setup: remote-later added after fetch", addLater.code === 0, addLater.stderr);

			const branchWarnings: string[] = [];
			const inUseChoice = await resolveBranchChoice(repo, "fix/smoke", (m, t) => branchWarnings.push(`${t}: ${m}`));
			await check(tc, "in-use branch → fresh create name", inUseChoice?.createBranch === "fix/smoke-2" && inUseChoice?.branch === undefined, JSON.stringify(inUseChoice));
			await check(tc, "in-use branch warns", branchWarnings.some((w) => w.includes("fix/smoke-2")), branchWarnings.join("\n"));
			const mainChoice = await resolveBranchChoice(repo, "main", () => {});
			await check(tc, "main-tree branch also in-use → fresh name", mainChoice?.createBranch === "main-2", JSON.stringify(mainChoice));
			await git(["branch", "free/smoke", "main"], { cwd: repo });
			const freeChoice = await resolveBranchChoice(repo, "free/smoke", () => {});
			await check(tc, "existing unattached branch → checkout", freeChoice?.branch === "free/smoke" && freeChoice?.createBranch === undefined, JSON.stringify(freeChoice));
			const freshChoice = await resolveBranchChoice(repo, "brand-new", () => {});
			await check(tc, "unknown name → create", freshChoice?.createBranch === "brand-new", JSON.stringify(freshChoice));
			// Occupy fix/smoke-2 as an unattached ref → the in-use fix/smoke must skip to -3.
			await git(["branch", "fix/smoke-2", "main"], { cwd: repo });
			const suffixed = await resolveBranchChoice(repo, "fix/smoke", () => {});
			await check(tc, "occupied suffix skips to next free", suffixed?.createBranch === "fix/smoke-3", JSON.stringify(suffixed));

			// Remote-branch intent: <remote>/<branch> resolves to a detached checkout
			// at the remote tip — never to a (bogus) local branch creation.
			const remoteChoice = await resolveBranchChoice(repo, "origin/remote-only", () => {});
			await check(tc, "remote branch → detached checkout choice", remoteChoice?.remoteRef === "origin/remote-only", JSON.stringify(remoteChoice));
			const laterChoice = await resolveBranchChoice(repo, "origin/remote-later", () => {});
			await check(tc, "remote branch fetched on demand by resolver", laterChoice?.remoteRef === "origin/remote-later", JSON.stringify(laterChoice));
			const remoteWarnings: string[] = [];
			const missingRemote = await resolveBranchChoice(repo, "origin/no-such-branch", (m, t) => remoteWarnings.push(`${t}: ${m}`));
			await check(tc, "remote branch missing on remote → error, no create", missingRemote === undefined && remoteWarnings.some((w) => w.startsWith("error")), remoteWarnings.join("\n"));
			const oneGoWarnings: string[] = [];
			const oneGoUnknown = await resolveBranchChoice(repo, "never-heard", (m, t) => oneGoWarnings.push(`${t}: ${m}`), { createUnknown: false });
			await check(tc, "one-go: unknown plain name → error (no silent create)", oneGoUnknown === undefined && oneGoWarnings.some((w) => w.startsWith("error")), oneGoWarnings.join("\n"));
			const oneGoInUse = await resolveBranchChoice(repo, "fix/smoke", (m) => oneGoWarnings.push(m), { createUnknown: false });
			await check(tc, "one-go: in-use branch → error (no suffix renaming)", oneGoInUse === undefined && oneGoWarnings.some((w) => w.includes("already checked out")), oneGoWarnings.join("\n"));

			// Detached remote checkout mechanics: worktree add at the remote tip stays
			// detached and lands on the remote branch's commit.
			const remoteSandbox = path.join(root, "remote-sandbox");
			fs.mkdirSync(remoteSandbox, { recursive: true });
			const remoteTipSha = await gitOk(["rev-parse", "--verify", "origin/remote-only^{commit}"], { cwd: repo });
			await gitWorktreeAdd({ cwd: repo, path: path.join(remoteSandbox, "remote-only"), detach: true, commitIsh: remoteTipSha });
			await check(
				tc,
				"detached remote-branch checkout lands at remote tip",
				// `branch --show-current` on a detached HEAD exits 0 with empty output.
				(await currentBranch(path.join(remoteSandbox, "remote-only"))) === "" &&
					(await runGit(["rev-parse", "HEAD"], { cwd: path.join(remoteSandbox, "remote-only") })).stdout === remoteTipSha,
				remoteTipSha,
			);
			await git(["worktree", "remove", "--force", path.join(remoteSandbox, "remote-only")], { cwd: repo });

			// Repo resolution from a non-repo cwd (the workspace-root scenario).
			const resolved = await findRepoRoot(path.join(repo, "sub", "deep"));
			await check(tc, "findRepoRoot walks up from nested dir", resolved === repo, `${resolved} vs ${repo}`);
			const none = await findRepoRoot(path.join(root, "not-a-repo"));
			await check(tc, "findRepoRoot undefined outside repos", none === undefined, `${none}`);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
