import { describe, test } from "node:test";
import { selectAdoptable } from "../../chhound/discovery.js";
import type { DiscoveryCandidate, TriageResult } from "../../chhound/discovery.js";
import { check } from "../lib/checks.js";

// Inventory: the selection-order scenario of the C1 "advisory catalog +
// selection order" section of scripts/smoke.ts @ 9576fb1 (draft PR #3),
// re-homed RED-first into the unit tier (feature label c1): selectAdoptable
// is a pure function over supplied candidates + parallel triage results, so
// no fs/env is needed. Scenario title + both leaf check names verbatim. The
// fs-backed re-triage scenario of the same section lives in
// fs/c1-advisory.test.ts. NOTE (green-era, do not weaken silently): this
// fixture has only ONE adoptable candidate (bad is triaged unusable), so the
// fixed-spot-order preference cannot yet be proven — a second two-adoptable
// case is a reviewed green addition.

describe("c1 discovery policy", () => {
	test("C1 selection order: fixed spots outrank catalog insertion and bad first does not block", async (t) => {
		const base: DiscoveryCandidate = {
			repoRoot: "/fixture/repo",
			configPath: "/fixture/repo/.chunkhound.json",
			dbPath: "/fixture/repo/.chunkhound.db",
			layout: "file",
			sidecarRoot: "/fixture/repo",
		};
		const bad: DiscoveryCandidate = { ...base, repoRoot: "/fixture/fixed-first" };
		const good: DiscoveryCandidate = { ...base, repoRoot: "/fixture/fixed-later" };
		const triaged: TriageResult[] = [
			{ candidate: good, verdict: "adoptable" },
			{ candidate: bad, verdict: "unusable" },
		];
		const selected = selectAdoptable([bad, good], triaged);
		await check(t, "C1 bad first fixed spot does not block good later spot", selected?.repoRoot === good.repoRoot);
		await check(
			t,
			"C1 selected candidate follows fixed-spot candidate order rather than catalog insertion",
			selected?.repoRoot === [bad, good][1]!.repoRoot,
		);
	});
});
