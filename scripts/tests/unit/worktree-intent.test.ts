import { describe, test } from "node:test";
import path from "node:path";
import { findConflictingIndexed } from "../../../chhound/sandbox.js";
import { isWizardInvocation, OTHER_REPO, REPO_PICKER_TITLE } from "../../../worktree/command.js";
import { check } from "../lib/checks.js";

// Inventory: 13 legacy checks moved from smoke.ts section 4 (dest: location +
// wizard + conflict) — the pure wizard-intent predicates, the picker wording
// constants and the overlap logic over supplied absolute path strings (no fs
// access: path.resolve comparisons only). The env-dependent
// resolveSandboxLocation checks moved to fs/sandbox-location.test.ts.

describe("worktree intent", () => {
	test("legacy wizard + conflict obligations", async (t) => {
		const base = "/tmp/pi-chhound-worktree-intent"; // pure string anchor, never created
		const idx = [path.join(base, "idx-a")];
		await check(t, "wizard: bare /chworktree", isWizardInvocation([], {}), JSON.stringify(isWizardInvocation([], {})));
		await check(t, "wizard: repo only", isWizardInvocation(["repo"], {}));
		await check(t, "one-go: branch given", isWizardInvocation(["repo", "main"], {}) === false);
		await check(t, "one-go: --dest given", isWizardInvocation(["repo"], { dest: "~/wt" }) === false);
		await check(t, "one-go: -b given", isWizardInvocation([], { b: "x" }) === false);
		await check(t, "wizard: --help is not wizard", isWizardInvocation(["repo"], { help: true }) === false);
		await check(t, "wizard: -h is not wizard", isWizardInvocation(["repo"], { h: true }) === false);
		await check(t, "repo picker title wording", REPO_PICKER_TITLE === "Select a repository", REPO_PICKER_TITLE);
		await check(t, "repo picker path-option wording", OTHER_REPO === "select local repository", OTHER_REPO);
		await check(t, "conflict: exact match", findConflictingIndexed(path.join(base, "idx-a"), idx) === path.join(base, "idx-a"));
		await check(t, "conflict: inside indexed worktree", findConflictingIndexed(path.join(base, "idx-a", "sub"), idx) === path.join(base, "idx-a"));
		await check(t, "conflict: contains indexed worktree", findConflictingIndexed(base, idx) === path.join(base, "idx-a"));
		await check(t, "no conflict", findConflictingIndexed(path.join(base, "other"), idx) === undefined);
	});
});
