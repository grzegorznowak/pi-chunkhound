import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { defaultRemoteBranch, runGit } from "../../../chhound/git.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 3 legacy checks moved from smoke.ts section 9 (default branch),
// git-branches half. Real local git repos, no remotes needed — origin/HEAD
// symbolic refs are manufactured directly.

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
