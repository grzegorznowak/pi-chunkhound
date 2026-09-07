/**
 * C1 library-writer race worker (test/robustness/fs/c1-library-writers.test.ts).
 * Checked-in ESM worker — NOT a generated source string. Invoked by the test
 * as `process.execPath --import tsx <this file> <entry-json>`; the entry JSON
 * is argv[2]. The worker performs one upsertLibraryEntry (acquire lock, read,
 * merge, atomic write) against the SAME library.json the test process uses
 * (fake HOME inherited via env), so two real processes contend for the lock.
 *
 * The first writer parks inside the locked critical section (onPhase "read")
 * until the test releases it, proving the second writer's update cannot tear
 * the first. Barrier paths come from the environment so this file needs no
 * per-run interpolation; only the writer whose repoRoot ends with "one"
 * parks. The park is deadline-bounded (30 s — under the 45 s robustness/fs
 * tier envelope) so a stalled worker can never outlive its suite: on expiry
 * it throws and exits nonzero like any other worker failure.
 */
import * as fs from "node:fs";
import { upsertLibraryEntry } from "../../../chhound/library.js";
import type { LibraryEntry } from "../../../chhound/library.js";

const entry = JSON.parse(process.argv[2] ?? "") as LibraryEntry;

await upsertLibraryEntry(entry, {
	onPhase: async (phase) => {
		if (phase !== "read" || !entry.repoRoot.endsWith("one")) return;
		const ready = process.env.C1_WRITER_BARRIER_READY;
		const resume = process.env.C1_WRITER_BARRIER;
		if (!ready || !resume) throw new Error("C1 writer barrier env not set");
		fs.writeFileSync(ready, "ready");
		const parkDeadline = Date.now() + 30_000;
		await new Promise<void>((resolve, reject) => {
			const timer = setInterval(() => {
				if (fs.existsSync(resume)) {
					clearInterval(timer);
					resolve(undefined);
				} else if (Date.now() > parkDeadline) {
					clearInterval(timer);
					reject(new Error("C1 writer barrier wait expired"));
				}
			}, 5);
		});
	},
});
