import { describe, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertLibraryEntry, withLibraryLock } from "../../../chhound/library.js";
import type { LibraryEntry } from "../../../chhound/library.js";
import { globalSettingsPath } from "../../../chhound/paths.js";
import { check } from "../../lib/checks.js";
import { c1EntryFrom, plantCandidate } from "../../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../../lib/isolation.js";

// Inventory: the third scenario of the C1 "catalog schema + concurrent merge"
// section of scripts/smoke.ts @ 9576fb1 (draft PR #3) — real contending child
// writers + bounded lock timeout — re-homed RED-first into the robustness/fs
// tier (feature label c1), where explicit concurrency/failure behavior is the
// subject. Scenario title + all three leaf check names verbatim. The RED
// smoke-era worker was a generated source string embedding barrier paths;
// here it is the checked-in test/lib/workers/library-writer.ts, launched via
// process.execPath --import tsx (never a guessed tsx path), barrier paths
// passed through env. Scenario-owned catalog under fake HOME.
//
// GREEN FIXTURE REPAIRS (operator-authorized, implemented in the C1 green
// pass; the RED-era notes they replaced are recorded here):
// 1. The RED-era in-process `await upsertLibraryEntry(c1Entry)` seam would
//    add a THIRD root to the catalog the final two-root assertion must not
//    count. The seam now runs against a THROWAWAY catalog under a separate
//    fake HOME (proof leaf asserts its own merge result), then the scenario
//    catalog is explicitly reset to empty before the child race.
// 2. The RED-era lock-timeout leaf ran a never-resolving critical section
//    with NO competing lock, confusing acquisition timeout with execution
//    timeout. The leaf now holds a REAL competing lock (a parked child that
//    parks inside its locked critical section at the "read" phase) and
//    asserts the bounded acquisition timeout against it; the parked child
//    is released in a finally and its park is 30 s deadline-bounded.

describe("c1 library writers", () => {
	test("C1 catalog writers: real contending processes preserve both atomic updates", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-robustness-c1-writers-");
		const spawned: ChildProcess[] = [];
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const library = path.join(path.dirname(globalSettingsPath()), "library.json");
			const barrier = path.join(root, "writer-barrier");
			const readyFile = `${barrier}.first-ready`;
			const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../lib/workers/library-writer.ts");

			fs.mkdirSync(path.dirname(library), { recursive: true });
			fs.writeFileSync(library, JSON.stringify({ version: 1, entries: [] }));
			const c1Entry = c1EntryFrom(plantCandidate(path.join(root, "repo"), ".chunkhound.json"));

			// Repair note 1: prove the in-process upsert seam against a
			// THROWAWAY catalog under a separate fake HOME — the scenario catalog
			// must start the child race empty so the final assertion counts
			// exactly the two racing roots.
			const seamHome = await makeFakeHome(root, "seam-home");
			applyEnv(isolatedEnv({ home: seamHome }));
			const seamCatalog = await upsertLibraryEntry(c1Entry);
			await check(
				t,
				"C1 in-process upsert seam works against its own catalog",
				seamCatalog.entries.length === 1 && seamCatalog.entries[0]!.repoRoot === c1Entry.repoRoot,
			);
			applyEnv(isolatedEnv({ home }));
			fs.writeFileSync(library, JSON.stringify({ version: 1, entries: [] }));

			// Children inherit these (fake HOME too): the parked first writer
			// signals readiness here and waits for the resume file.
			process.env.C1_WRITER_BARRIER = barrier;
			process.env.C1_WRITER_BARRIER_READY = readyFile;

			const runWriter = (entry: LibraryEntry): Promise<number> =>
				new Promise((resolve, reject) => {
					const child = spawn(process.execPath, ["--import", "tsx", worker, JSON.stringify(entry)], { env: process.env, stdio: "ignore" });
					spawned.push(child);
					child.once("error", reject);
					child.once("exit", (code) => resolve(code ?? -1));
				});
			const waitForFile = async (file: string, deadlineMs = 15_000): Promise<void> => {
				const deadline = Date.now() + deadlineMs;
				while (!fs.existsSync(file)) {
					if (Date.now() > deadline) throw new Error(`writer barrier was not reached: ${file}`);
					await new Promise((r) => setTimeout(r, 20));
				}
			};

			const one: LibraryEntry = { ...c1Entry, repoRoot: path.join(root, "one") };
			const two: LibraryEntry = { ...c1Entry, repoRoot: path.join(root, "two") };
			// Writer one parks inside the locked critical section at the "read"
			// phase; writer two then contends for the lock while one's update is
			// still uncommitted. Releasing the barrier lets one finish its atomic
			// write; two must then read one's entry, merge, and write its own.
			const first = runWriter(one);
			await waitForFile(readyFile);
			const second = runWriter(two);
			fs.writeFileSync(barrier, "resume");

			const codes = await Promise.all([first, second]);
			await check(t, "C1 two writers exit successfully", codes.every((code) => code === 0), codes.join(","));
			const raw = fs.readFileSync(library, "utf8");
			const final = JSON.parse(raw) as { version: number; entries: LibraryEntry[] };
			await check(
				t,
				"C1 concurrent merge retains both and JSON never tears",
				final.entries.map((e) => e.repoRoot).sort().join(",") === [one.repoRoot, two.repoRoot].sort().join(",") && JSON.parse(raw).version === 1,
			);

			// Repair note 2: the lock-timeout leaf contends against a REAL
			// competing lock — a parked writer child holds the lock inside its
			// locked critical section; the in-process acquisition must time out
			// against that holder (never against its own critical section).
			const timeoutBarrier = path.join(root, "timeout-barrier");
			const timeoutReady = `${timeoutBarrier}.first-ready`;
			process.env.C1_WRITER_BARRIER = timeoutBarrier;
			process.env.C1_WRITER_BARRIER_READY = timeoutReady;
			const holder = runWriter({ ...c1Entry, repoRoot: path.join(root, "lock-holder-one") });
			let timedOut = false;
			try {
				await waitForFile(timeoutReady);
				try {
					await withLibraryLock(async () => undefined, { lockTimeoutMs: 15 });
				} catch {
					timedOut = true;
				}
				await check(t, "C1 lock timeout is bounded and reported", timedOut);
			} finally {
				// Release the parked holder (its park is deadline-bounded at 30 s);
				// the shared teardown below escalates TERM → KILL as a backstop.
				try {
					fs.writeFileSync(timeoutBarrier, "resume");
				} catch {
					/* root may already be gone; teardown still reaps */
				}
			}
		} finally {
			// Exception-safe teardown: release any parked writer first, give the
			// children a short grace to exit naturally, then escalate TERM →
			// KILL and AWAIT each straggler's 'exit' before env restore + root
			// removal. Signal-killed children keep exitCode === null, so
			// settlement is judged on exitCode OR signalCode.
			try {
				fs.writeFileSync(path.join(root, "writer-barrier"), "resume");
			} catch {
				/* root may already be gone; reaping still runs */
			}
			const settled = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
			const waitExit = (child: ChildProcess): Promise<void> =>
				settled(child) ? Promise.resolve() : new Promise<void>((resolve) => child.once("exit", () => resolve()));
			const remaining = [...spawned];
			const grace = Date.now() + 2_000;
			while (remaining.length > 0 && Date.now() < grace) {
				for (const child of remaining) if (settled(child)) remaining.splice(remaining.indexOf(child), 1);
				if (remaining.length > 0) await new Promise((r) => setTimeout(r, 20));
			}
			for (const child of remaining) {
				const exited = waitExit(child);
				child.kill("SIGTERM");
				await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
				if (!settled(child)) {
					const killed = waitExit(child);
					child.kill("SIGKILL");
					await Promise.race([killed, new Promise((r) => setTimeout(r, 2_000))]);
				}
			}
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
