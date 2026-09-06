import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { sweepBaselineGarbage } from "../../../chhound/baseline.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 7 legacy checks moved from smoke.ts section 9 (baseline gc),
// gc half. Handcrafted metadata dirs under an owned baseRoot — no engine,
// no real commits (sweepBaselineGarbage only consults repoRoot existence,
// baseRef/updatedAt ordering and .prime.lock pid liveness).

describe("baseline gc", () => {
	test("legacy sweepBaselineGarbage obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-baseline-gc-");
		try {
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const bases = settings.baseRoot!;
			const mk = (repoSlug: string, ref: string, meta?: unknown) => {
				const d = path.join(bases, repoSlug, ref);
				fs.mkdirSync(d, { recursive: true });
				if (meta) fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(meta) + "\n");
				return d;
			};
			// Incomplete (no meta) → garbage.
			const noMeta = mk("junk-11111111", "main");
			// Dead repoRoot → garbage.
			const deadRepo = mk("junk-22222222", "main", { version: 1, repoRoot: path.join(root, "gone-repo"), baseRef: "main", baseCommit: "a", chhoundVersion: "v", updatedAt: "2026-01-01T00:00:00.000Z" });
			// Live repoRoot + fresh meta → kept (distinct fake repo so it can't be
			// superseded by any other baseline in this owned root).
			const fakeRepo = path.join(root, "fake-repo");
			fs.mkdirSync(fakeRepo);
			const live = mk("junk-33333333", "main", { version: 1, repoRoot: fakeRepo, baseRef: "main", baseCommit: "a", chhoundVersion: "v", updatedAt: "2026-09-01T00:00:00.000Z" });
			// Incomplete but with a LIVE prime lock → kept (prime in flight).
			const locked = mk("junk-44444444", "main");
			fs.writeFileSync(path.join(locked, ".prime.lock"), String(process.pid));
			// Superseded duplicate (same repo+ref, older updatedAt) → garbage.
			const older = mk("junk-55555555", "main", { version: 1, repoRoot: fakeRepo, baseRef: "main", baseCommit: "a", chhoundVersion: "v", updatedAt: "2026-08-01T00:00:00.000Z" });

			const removed = sweepBaselineGarbage(settings);
			await check(t, "gc: incomplete baseline removed", removed.includes(noMeta), removed.join(","));
			await check(t, "gc: dead-repo baseline removed", removed.includes(deadRepo), removed.join(","));
			await check(t, "gc: live baseline kept", !removed.includes(live) && fs.existsSync(live));
			await check(t, "gc: live-locked dir kept", !removed.includes(locked) && fs.existsSync(locked));
			await check(t, "gc: superseded duplicate removed", removed.includes(older) && fs.existsSync(live), removed.join(","));
			await check(t, "gc: empty parent dirs cleaned", !fs.existsSync(path.join(bases, "junk-11111111")) && !fs.existsSync(path.join(bases, "junk-22222222")));
			// GC is safe for in-flight primes only while the lock pid is alive — a dead
			// lock must not protect garbage.
			fs.mkdirSync(noMeta, { recursive: true }); // re-create (first sweep removed it)
			fs.writeFileSync(path.join(noMeta, ".prime.lock"), "999999999");
			const removed2 = sweepBaselineGarbage(settings);
			await check(t, "gc: dead lock does not protect garbage", removed2.includes(noMeta), removed2.join(","));
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
