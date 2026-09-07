import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { isManagedContainment, triage } from "../../chhound/discovery.js";
import { check } from "../lib/checks.js";
import { C1_CANARY, c1ConfigText, c1ManagedRoots, plantCandidate } from "../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: the "C1 triage, containment + secret handling" section of
// scripts/smoke.ts @ 9576fb1 (draft PR #3), re-homed RED-first (feature label
// c1). The matrix and containment scenarios are whole and verbatim. The
// bounded-files scenario keeps its verbatim title and its malformed/oversized
// leaves (sanitized unusable, canary-free); its FIFO leaf moved to
// robustness/fs/c1-discovery-bounds.test.ts (scenario "C1 triage bounded
// reads (FIFO)", leaf name verbatim). Env: fake HOME; the containment
// scenario additionally plants inside the three managed roots and overrides
// the CHHOUND_*_ROOT env so realpath aliases resolve into them.

describe("c1 triage + containment", () => {
	test("C1 triage matrix: layouts, claims, paths and writer artifacts have exact verdict keys", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-triage-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			const file = plantCandidate(path.join(root, "matrix-file"), ".chunkhound.json");
			const dir = plantCandidate(path.join(root, "matrix-dir"), "config.json", "dir");
			const missingSidecar = plantCandidate(path.join(root, "missing-claim"), ".chunkhound.json");
			fs.rmSync(`${missingSidecar.dbPath}.root.json`);
			const v2 = plantCandidate(path.join(root, "v2"), ".chunkhound.json");
			fs.writeFileSync(`${v2.dbPath}.root.json`, JSON.stringify({ version: 2, indexed_root_path: v2.repoRoot }));
			const wrong = plantCandidate(path.join(root, "wrong"), ".chunkhound.json", "file", path.join(root, "workspace-root"));
			const absent = plantCandidate(path.join(root, "absent"), ".chunkhound.json");
			fs.rmSync(absent.dbPath);
			const relative = { ...file, repoRoot: path.join(root, "relative"), configPath: path.join(root, "relative", ".chunkhound.json") };
			fs.mkdirSync(relative.repoRoot, { recursive: true });
			fs.writeFileSync(relative.configPath, c1ConfigText("relative.db"), { mode: 0o600 });
			const busyWal = plantCandidate(path.join(root, "busy-wal"), ".chunkhound.json");
			fs.writeFileSync(`${busyWal.dbPath}.wal`, "writer");
			const busyBackup = plantCandidate(path.join(root, "busy-backup"), ".chunkhound.json");
			fs.writeFileSync(`${busyBackup.dbPath}.compact_backup`, "writer");
			const busyNew = plantCandidate(path.join(root, "busy-new"), ".chunkhound.json");
			fs.writeFileSync(`${busyNew.dbPath}.compact_new`, "writer");

			const results = await Promise.all(
				[file, dir, missingSidecar, v2, wrong, absent, relative, busyWal, busyBackup, busyNew].map((x) =>
					triage(x, { limits: { maxConfigBytes: 256 * 1024 } }),
				),
			);
			await check(
				t,
				"C1 matching file and dir layouts are adoptable",
				results[0]!.verdict === "adoptable" && results[1]!.verdict === "adoptable",
			);
			await check(
				t,
				"C1 missing/v2 claims and missing db are unusable",
				results[2]!.verdict === "unusable" && results[3]!.verdict === "unusable" && results[5]!.verdict === "unusable",
			);
			await check(
				t,
				"C1 wrong root class-1 and relative db are distinct",
				results[4]!.verdict === "layout-not-supported" && results[6]!.verdict === "unresolved-path",
			);
			await check(
				t,
				"C1 WAL and both compact writer artifacts are busy",
				results[7]!.verdict === "busy" && results[8]!.verdict === "busy" && results[9]!.verdict === "busy",
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 triage bounded files: malformed, oversized and FIFO never expose secrets or hang", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-triage-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			// Malformed + oversized bounded config reads (canary sanitization).
			// FIFO bounded-read part of this scenario moved to
			// robustness/fs/c1-discovery-bounds.test.ts (leaf name verbatim).
			const malformed = plantCandidate(path.join(root, "malformed"), ".chunkhound.json");
			fs.writeFileSync(malformed.configPath, `{ ${C1_CANARY}`);
			const oversized = plantCandidate(path.join(root, "oversized"), ".chunkhound.json");
			fs.writeFileSync(oversized.configPath, "x".repeat(256 * 1024 + 1));

			const results = await Promise.all([
				triage(malformed),
				triage(oversized, { limits: { maxConfigBytes: 256 * 1024 } }),
			]);
			await check(
				t,
				"C1 malformed and oversized configs are sanitized unusable",
				results[0]!.verdict === "unusable" && results[1]!.verdict === "unusable" && results.every((r) => !r.issue?.includes(C1_CANARY)),
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 containment: managed paths, realpath aliases and mirrors are never catalogued", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-triage-");
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

			const managedCandidate = plantCandidate(path.join(managed[1], "source"), ".chunkhound.json");
			const alias = path.join(root, "managed-alias");
			fs.symlinkSync(managed[1], alias);
			const aliased = { ...managedCandidate, configPath: path.join(alias, "source", ".chunkhound.json"), dbPath: path.join(alias, "source", ".chunkhound.db") };
			const mirror = plantCandidate(path.join(managed[2], "github.com", "o", "r"), ".chunkhound.json");

			await check(t, "C1 direct managed root is excluded", isManagedContainment(managedCandidate, managed));
			await check(t, "C1 symlink alias resolves into managed root", isManagedContainment(aliased, managed));
			await check(t, "C1 PR mirror host is excluded from catalog", isManagedContainment(mirror, managed));
			await check(t, "C1 canary fixtures are 0600", (fs.statSync(managedCandidate.configPath).mode & 0o777) === 0o600);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
