import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { c1EntryFrom, plantCandidate } from "../lib/c1.js";
import { retriageEntry, sizeAskEligible } from "../../chhound/discovery.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: the "C1 advisory current verdict" scenario of scripts/smoke.ts @
// 9576fb1 (draft PR #3), re-homed RED-first (feature label c1). Scenario
// title + all four leaf check names verbatim. The pure selection-order
// scenario of the same section moved to unit/c1-discovery-policy.test.ts.
// Env: fake HOME; each source is a real planted layout whose db/config/claim
// is then moved/deleted/replaced to exercise use-time re-triage. Historical
// verdicts in the entry are advisory only — current file state decides.

describe("c1 advisory re-triage", () => {
	test("C1 advisory current verdict: moved/deleted/reappeared sources never retain stale suppression", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-advisory-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			const staleDb = plantCandidate(path.join(root, "stale-db"), ".chunkhound.json");
			fs.renameSync(staleDb.dbPath, staleDb.dbPath + ".moved");
			const staleConfig = plantCandidate(path.join(root, "stale-config"), ".chunkhound.json");
			fs.rmSync(staleConfig.configPath);
			const staleSidecar = plantCandidate(path.join(root, "stale-sidecar"), ".chunkhound.json");
			fs.writeFileSync(`${staleSidecar.dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: path.join(root, "other-root") }));
			const reappeared = plantCandidate(path.join(root, "reappeared"), ".chunkhound.json");

			const [goneDb, goneConfig, replacedClaim, current] = await Promise.all([
				retriageEntry(c1EntryFrom(staleDb)),
				retriageEntry(c1EntryFrom(staleConfig)),
				retriageEntry(c1EntryFrom(staleSidecar)),
				retriageEntry(c1EntryFrom(reappeared, { verdict: "unusable" })),
			]);
			await check(
				t,
				"C1 moved db and deleted config are dropped or currently unusable",
				(goneDb === undefined || goneDb.verdict === "unusable") && (goneConfig === undefined || goneConfig.verdict === "unusable"),
			);
			await check(t, "C1 replaced sidecar re-triages to current layout verdict", replacedClaim?.verdict === "layout-not-supported");
			await check(t, "C1 historical unusable reappeared source is currently adoptable", current?.verdict === "adoptable");
			await check(
				t,
				"C1 historical busy/unusable never suppresses retry or the current size ask",
				current?.verdict === "adoptable" && sizeAskEligible(goneDb) && !sizeAskEligible(current),
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
