import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { dirCompletions, worktreeArgumentCompletions } from "../../../chhound/completions.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 19 legacy checks moved from smoke.ts section 3 (completions).
// Deterministic fake HOME, never the operator home: the ~-expansion listing
// reads os.homedir(), so the fake home is seeded with one visible dir instead
// of relying on whatever the real home happens to contain. `proj` is
// deliberately NOT a git repo — branch/new-branch and --from positions must
// yield nothing (no repo anywhere means the command cannot run). Values
// replace the WHOLE argument text, so every value carries the typed base.

describe("completions", () => {
	test("legacy dir + argument completions obligations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-completions-");
		try {
			const home = await makeFakeHome(root);
			fs.mkdirSync(path.join(home, "documents")); // only visible dir the ~/ listing needs
			applyEnv(isolatedEnv({ home }));
			const proj = path.join(root, "comp-proj");
			fs.mkdirSync(path.join(proj, "src", "nested"), { recursive: true });
			fs.mkdirSync(path.join(proj, "docs"), { recursive: true });
			fs.writeFileSync(path.join(proj, "a.txt"), "x");
			const dirs0 = dirCompletions("", proj);
			await check(t, "dir picker: dirs only, trailing /", dirs0.map((d) => d.label).join(",") === "docs/,src/", JSON.stringify(dirs0));
			const dirs1 = dirCompletions("sr", proj);
			await check(t, "dir picker: prefix filter + full value", dirs1.length === 1 && dirs1[0]!.value === "src/" && dirs1[0]!.label === "src/");
			const dirs2 = dirCompletions("src/", proj);
			await check(t, "dir picker: subdir navigation", dirs2.length === 1 && dirs2[0]!.value === "src/nested/", JSON.stringify(dirs2));
			const files = dirCompletions("a", proj, { includeFiles: true });
			await check(t, "file picker (--config): files included", files.some((f) => f.label === "a.txt" && f.description === "file"));
			const abs = dirCompletions(proj + "/s", proj);
			await check(t, "dir picker: absolute prefix", abs.length === 1 && abs[0]!.value === proj + "/src/", JSON.stringify(abs));
			const tilde = dirCompletions("~/", proj);
			await check(t, "dir picker: ~ expansion", tilde.length > 0 && tilde.every((d) => d.value.startsWith("~/")));
			// Full-argument replacement contract (applyCompletion replaces the whole arg string).
			const arg0 = await worktreeArgumentCompletions("", proj);
			await check(t, "arg completions: empty → cwd dirs", arg0.some((c) => c.value === "src/"), JSON.stringify(arg0));
			await check(t, "arg completions name the parameter", arg0.length > 0 && arg0[0]!.description === "worktree path (required)", JSON.stringify(arg0[0]));
			const argBranch = await worktreeArgumentCompletions("wt ", proj);
			await check(t, "arg completions: trailing space → branch position, full values", argBranch.every((c) => c.value.startsWith("wt ")));
			const argNoRepo = await worktreeArgumentCompletions("wt ", proj);
			await check(t, "no repo → no branch/new-branch items", argNoRepo.length === 0, JSON.stringify(argNoRepo));
			const argNoRepoName = await worktreeArgumentCompletions("wt something", proj);
			await check(t, "no repo → no create-branch item", argNoRepoName.length === 0, JSON.stringify(argNoRepoName));
			const argBDash = await worktreeArgumentCompletions("wt -b ", proj);
			await check(t, "-b value position → no existing-branch suggestions", argBDash.length === 0, JSON.stringify(argBDash));
			const argConfigTrailing = await worktreeArgumentCompletions("wt --config ", proj);
			await check(t, "--config trailing space → config files", argConfigTrailing.some((c) => c.value === "wt --config a.txt" && c.label === "a.txt"), JSON.stringify(argConfigTrailing));
			const argFlag = await worktreeArgumentCompletions("wt --f", proj);
			await check(t, "arg completions: flag names keep base", argFlag.some((c) => c.value === "wt --force-reindex") && argFlag.some((c) => c.value === "wt --from"), JSON.stringify(argFlag));
			const argFrom = await worktreeArgumentCompletions("wt --from ", proj);
			await check(t, "arg completions: --from value position", argFrom.every((c) => c.value.startsWith("wt --from ")));
			const argConfig = await worktreeArgumentCompletions("wt --config a", proj);
			await check(t, "arg completions: --config value position keeps base", argConfig.some((c) => c.value === "wt --config a.txt" && c.label === "a.txt"), JSON.stringify(argConfig));
			const argDestFlag = await worktreeArgumentCompletions("wt --d", proj);
			await check(t, "arg completions: --dest flag name", argDestFlag.some((c) => c.value === "wt --dest"), JSON.stringify(argDestFlag));
			const argDest = await worktreeArgumentCompletions("wt --dest ", proj);
			await check(t, "--dest value → dir picker (optional label)", argDest.every((c) => c.value.startsWith("wt --dest ")) && argDest.some((c) => c.value === "wt --dest src/" && c.description === "worktree library root (worktrees + indexes land there)"), JSON.stringify(argDest));
			await check(t, "--dest picker dirs only", !argDest.some((c) => c.label === "a.txt"), JSON.stringify(argDest));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
