import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { deepSweep, fastPass } from "../../chhound/discovery.js";
import { check } from "../lib/checks.js";
import { c1ConfigText, c1ManagedRoots, plantCandidate } from "../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: the "C1 host fast-pass + deep sweep" section of scripts/smoke.ts
// @ 9576fb1 (draft PR #3), re-homed RED-first (feature label c1). The
// fast-pass scenario is whole and verbatim. The deep-sweep scenario keeps its
// verbatim title and its tree leaves (reviewable candidates; symlink-cycle
// termination + permission denial); its truncation-limits/AbortSignal leaf
// moved to robustness/fs/c1-discovery-bounds.test.ts (scenario "C1 deep-sweep
// budgets/cancel bounds", leaf name verbatim) — see that file's header.
// HARDENING (pre-green RED commit, reviewed): the draft-era checks left spec
// obligations unpinned — the fast-pass dir-layout fixed spot was planted but
// never required, and deep-sweep skip semantics were asserted only for
// node_modules + the outside symlink. Added leaves pin (a) dir-layout spot
// presence, (b) .git/dependency/cache decoy exclusion, (c) pruning of a real
// managed subtree planted INSIDE the swept tree, and (d) path-based (never
// name-based) containment via a same-named user-dir decoy.
// Env: fake HOME + the three CHHOUND_*_ROOT managed-root overrides, matching
// the smoke-era runtime env for these discovery paths. Managed roots are
// siblings here (deepSweep receives the sweep-local managed subtree
// explicitly; fastPass reads env).

describe("c1 discovery fast-pass + sweep", () => {
	test("C1 fast-pass: selected host fixed spots only and silent entry is callable", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-discovery-");
		try {
			const home = await makeFakeHome(root);
			const managed = c1ManagedRoots(root);
			applyEnv(
				isolatedEnv({
					home,
					overrides: {
						CHHOUND_SANDBOX_ROOT: managed[0],
						CHHOUND_BASE_ROOT: managed[1],
						CHHOUND_MIRROR_ROOT: managed[2],
					},
				}),
			);

			// Fixed spots: the selected host root, its dir-layout leaf, the
			// repo parent dir, and the session cwd — never the process cwd, and
			// no recursion into the .chunkhound leaf (deep.json) or daemon
			// artifacts (watchman.sock).
			const host = path.join(root, "host");
			const parent = path.dirname(host);
			const sessionCwd = path.join(root, "session-cwd");
			const session = plantCandidate(sessionCwd, ".chunkhound.json");
			const file = plantCandidate(host, ".chunkhound.json");
			const dir = plantCandidate(host, "config.json", "dir");
			const parentConfig = plantCandidate(parent, ".chunkhound.json");
			fs.mkdirSync(path.join(host, ".chunkhound", "sub"), { recursive: true });
			fs.writeFileSync(path.join(host, ".chunkhound", "sub", "deep.json"), c1ConfigText(file.dbPath));
			fs.writeFileSync(path.join(host, ".chunkhound", "watchman.sock"), "artifact");

			const found = await fastPass(host, sessionCwd);
			await check(t, "C1 selected host is scanned rather than process cwd", found.some((x) => x.repoRoot === host && x.configPath === file.configPath));
			await check(
				t,
				"C1 all four fixed spots include host, dir, parent, session and exclude recursion/artifacts",
				found.some((x) => x.configPath === session.configPath) &&
					found.some((x) => x.configPath === parentConfig.configPath) &&
					!found.some((x) => x.configPath.endsWith("deep.json") || x.configPath.endsWith("watchman.sock")),
			);
			await check(t, "C1 silent fast-pass is callable without UI", Array.isArray(found));
			// HARDENING: the dir-layout fixed spot (repoRoot/.chunkhound/ with a
			// config inside) was planted but never required by the draft checks.
			await check(t, "C1 fast-pass dir-layout fixed spot is present", found.some((x) => x.configPath === dir.configPath));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 deep-sweep: real bounded tree skips decoys, symlinks and managed roots", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-discovery-");
		try {
			const home = await makeFakeHome(root);
			const managed = c1ManagedRoots(root);
			applyEnv(
				isolatedEnv({
					home,
					overrides: {
						CHHOUND_SANDBOX_ROOT: managed[0],
						CHHOUND_BASE_ROOT: managed[1],
						CHHOUND_MIRROR_ROOT: managed[2],
					},
				}),
			);

			// Real bounded tree: one allowed candidate; standard skip dirs
			// (node_modules/.git/dependency/cache) plus a "managed-bases" decoy
			// (same NAME as a managed root but NOT inside one — containment must
			// be path-based); a REAL managed subtree planted inside the swept
			// tree (sweepRoot/managed-inside, passed via managedRoots below); a
			// chmod-000 dir (restored in finally); a symlink cycle back to the
			// sweep root; an outside candidate reachable only via a symlinked
			// config file (no symlink follow). Truncation/abort runs moved to
			// robustness/fs/c1-discovery-bounds.test.ts.
			const sweepRoot = path.join(root, "sweep");
			const allowed = plantCandidate(path.join(sweepRoot, "allowed"), ".chunkhound.json");
			for (const d of ["node_modules/pkg", ".git/x", "dependency/x", "cache/x", "managed-bases/x"]) {
				plantCandidate(path.join(sweepRoot, d), ".chunkhound.json");
			}
			const nameDecoy = path.join(sweepRoot, "managed-bases", "x", ".chunkhound.json");
			const managedInside = plantCandidate(path.join(sweepRoot, "managed-inside", "x"), ".chunkhound.json");
			const sweepManaged = [...managed, path.join(sweepRoot, "managed-inside")];
			const denied = path.join(sweepRoot, "denied");
			fs.mkdirSync(denied, { recursive: true });
			fs.chmodSync(denied, 0o000);
			fs.symlinkSync(sweepRoot, path.join(sweepRoot, "cycle"));
			const outside = plantCandidate(path.join(root, "outside"), ".chunkhound.json");
			fs.symlinkSync(outside.configPath, path.join(sweepRoot, "outside-link.json"));
			try {
				const result = await deepSweep(sweepRoot, { managedRoots: sweepManaged, limits: { maxDirs: 100, maxFiles: 100, maxMs: 5_000 } });
				await check(
					t,
					"C1 sweep reports only reviewable allowed candidates",
					result.candidates.some((x) => x.configPath === allowed.configPath) &&
						!result.candidates.some((x) => x.configPath.includes("node_modules") || x.configPath === outside.configPath),
				);
				await check(
					t,
					"C1 sweep terminates symlink cycle and reports permission denial",
					!result.cancelled && result.permissionErrors >= 1,
				);
				// HARDENING: .git/dependency/cache subtrees and REAL managed
				// subtrees inside the swept root must never surface as candidates.
				const decoyConfigs = [".git/x", "dependency/x", "cache/x"].map((d) => path.join(sweepRoot, d, ".chunkhound.json"));
				await check(
					t,
					"C1 sweep skips .git/dependency/cache decoys and managed subtrees",
					!result.candidates.some((x) => decoyConfigs.includes(x.configPath) || x.configPath === managedInside.configPath),
				);
				// HARDENING: containment is path-based — a user dir that merely
				// SHARES a managed root's name (managed-bases decoy, not inside any
				// managed root) is still traversed and reported.
				await check(
					t,
					"C1 sweep containment is path-based, never name-based",
					result.candidates.some((x) => x.configPath === nameDecoy),
				);
			} finally {
				fs.chmodSync(denied, 0o700);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
