import { describe, test } from "node:test";
import { verdictCopy } from "../../chhound/discovery.js";
import type { Verdict } from "../../chhound/discovery.js";
import { check } from "../lib/checks.js";

// Inventory: the "C1 verdict copy" section of scripts/smoke.ts @ 9576fb1
// (draft PR #3), re-homed RED-first into the unit tier (feature label c1).
// Scenario title + leaf name verbatim. AMENDMENT (operator-authorized, spec
// v1.2 wins): the unresolved-path copy asserted by the draft-era smoke block
// was "Index location unclear (relative db path) — needs your answer or
// skip"; the authoritative v1.2 spec string is "Index location unclear —
// needs your answer or skip" (pi-chhound-stream2-spec §2 verdicts), so the
// expected strings here ARE the v1.2 copies — this file is the exact-string
// contract for all five verdict keys.

describe("c1 verdict copy", () => {
	test("C1 verdict copy: all S4 strings are exact", async (t) => {
		const v: Record<Verdict, string> = {
			adoptable: "Existing index for this repo found — will be reused",
			"layout-not-supported": "Index layout not supported (covers a different or multiple folders) — skipped",
			"unresolved-path": "Index location unclear — needs your answer or skip",
			busy: "Index in use by chunkhound right now — will copy when free",
			unusable: "Config or db missing/unreadable — skipped",
		};
		await check(
			t,
			"C1 S4 exact verdict strings",
			verdictCopy("adoptable") === v.adoptable &&
				verdictCopy("layout-not-supported") === v["layout-not-supported"] &&
				verdictCopy("unresolved-path") === v["unresolved-path"] &&
				verdictCopy("busy") === v.busy &&
				verdictCopy("unusable") === v.unusable,
		);
	});
});
