import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { deepSweep, triage } from "../../../chhound/discovery.js";
import type { DiscoveryCandidate } from "../../../chhound/discovery.js";
import { check } from "../../lib/checks.js";
import { plantCandidate } from "../../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../../lib/isolation.js";

// Inventory: the bounded/failure leaves split out of two C1 sections of
// scripts/smoke.ts @ 9576fb1 (draft PR #3), re-homed RED-first into the
// robustness/fs tier (feature label c1), where explicit budget/cancellation
// and non-regular-file behavior is the subject. Source scenario linkage:
//   - "C1 deep-sweep: real bounded tree skips decoys, symlinks and managed
//     roots" (fs/c1-discovery.test.ts keeps that title + tree leaves) — the
//     truncation-limits + AbortSignal leaf lives here as its own scenario.
//   - "C1 triage bounded files: malformed, oversized and FIFO never expose
//     secrets or hang" (fs/c1-triage.test.ts keeps malformed/oversized) — the
//     FIFO bounded-read leaf lives here as its own scenario.
// Leaf check names are verbatim. Env: fake HOME. Both scenarios are
// self-owned real trees; mkfifo via the system binary.

describe("c1 discovery bounds", () => {
	test("C1 deep-sweep budgets/cancel bounds: limits and AbortSignal are reported", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-robustness-c1-bounds-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			const sweepRoot = path.join(root, "sweep");
			plantCandidate(path.join(sweepRoot, "allowed"), ".chunkhound.json");
			plantCandidate(path.join(sweepRoot, "node_modules", "pkg"), ".chunkhound.json");

			// Starved budgets must truncate rather than hang or overrun; an
			// already-aborted signal must cancel promptly. Both flags come from
			// the same sweep API the tree scenario exercises.
			const truncated = await deepSweep(sweepRoot, { limits: { maxDirs: 1, maxFiles: 1, maxMs: 1 } });
			const cancelled = await deepSweep(sweepRoot, { signal: AbortSignal.abort() });
			await check(t, "C1 limits and AbortSignal are reported", truncated.truncated && cancelled.cancelled);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 triage bounded reads (FIFO): non-regular config never blocks or exposes content", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-robustness-c1-bounds-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			// A FIFO planted where a config file would be: opening it for a read
			// would block forever unless triage stat-skips non-regular files.
			// The db + claim are real planted files so only the config read is
			// the bounded subject.
			const planted = plantCandidate(path.join(root, "fifo-case"), ".chunkhound.json");
			const fifo = path.join(root, "fifo.json");
			await new Promise<void>((resolve, reject) => {
				spawn("mkfifo", [fifo]).once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo failed (code ${code})`))));
			});
			const fifoCandidate: DiscoveryCandidate = { ...planted, configPath: fifo };

			const result = await triage(fifoCandidate, { limits: { maxConfigBytes: 256 * 1024 } });
			await check(t, "C1 FIFO is stat-skipped without blocking", result.verdict === "unusable");
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
