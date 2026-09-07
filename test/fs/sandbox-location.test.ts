import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { resolveSandboxLocation } from "../../worktree/command.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 7 legacy checks moved from smoke.ts section 4 (dest: location +
// wizard + conflict) — resolveSandboxLocation consults the settings-provided
// library root (env-derived in production ⇒ fs tier per the tier contract),
// so --dest root overrides and (repo, branch) naming are asserted here against
// real fixture paths. The pure wizard/conflict checks moved to
// unit/worktree-intent.test.ts.

describe("sandbox location", () => {
	test("legacy resolveSandboxLocation obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-sandbox-location-");
		try {
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
			};
			const repo2 = path.join(root, "dest-repo");
			fs.mkdirSync(repo2);
			const dest = path.join(root, "dest-parent");
			// Design 1: the checkout lives INSIDE its sandbox dir — name derived
			// from repo + branch, folder = branch (slashes → "-").
			const sb = resolveSandboxLocation(repo2, undefined, settings, dest);
			await check(t, "sandbox: name from repo+branch (repo-wt default)", path.basename(sb.sandboxDir).startsWith("dest-repo-"), path.basename(sb.sandboxDir));
			await check(t, "sandbox: worktree inside sandbox dir", sb.wtPath === path.join(sb.sandboxDir, "dest-repo-wt"), sb.wtPath);
			const sbBranch = resolveSandboxLocation(repo2, "fix/foo", settings, dest);
			await check(t, "sandbox: branch-named folder (slashes → dashes)", sbBranch.wtPath === path.join(sbBranch.sandboxDir, "fix-foo"), sbBranch.wtPath);
			await check(t, "sandbox: distinct branch → distinct sandbox", sbBranch.sandboxDir !== sb.sandboxDir, `${sbBranch.sandboxDir} vs ${sb.sandboxDir}`);
			// Branch-rename safety: the name never depends on the worktree path (no circularity).
			const sbSame = resolveSandboxLocation(repo2, "fix/foo", settings, dest);
			await check(t, "sandbox: stable for same (repo, branch)", sbSame.sandboxDir === sbBranch.sandboxDir && sbSame.wtPath === sbBranch.wtPath);
			// --dest re-scoped: sandbox library root override — same (repo, branch) at a
			// different root yields a different sandbox dir.
			const sbOther = resolveSandboxLocation(repo2, "fix/foo", settings, path.join(root, "other-root"));
			await check(t, "sandbox: --dest = library root override", sbOther.sandboxDir.startsWith(path.join(root, "other-root")) && sbOther.sandboxDir !== sbBranch.sandboxDir, sbOther.sandboxDir);
			await check(t, "sandbox: folder name independent of root", path.basename(sbOther.wtPath) === "fix-foo");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
