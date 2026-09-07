import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireRoLease } from "../../chhound/ro-lease.js";
import { enginePython } from "../../chhound/cli.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: C2 RED-first scenarios (feature label c2) encoding the
// RO-lease obligations of the Stream-2 spec v1.2 §3.2 (RO-LEASE step:
// python/duckdb read_only child, lock-held handshake, timeout + death
// monitoring, finally-close; WAL/.compact_backup/.compact_new rejected as
// busy-equivalent; RO open fails => BUSY; missing python => adoption
// ineligible) plus the test-design group 6 "lease" (pi-chhound-stream2-tests:
// real DB; RW child READY/RELEASE; RO lease READY/RELEASE/CLOSED with EOF
// finally closes; while RO is held another RW opener fails; child kill during
// lease fails closed with the child reaped; no repair/source changes).
// chhound/ro-lease.ts is a C2 module and does not exist yet — this file is
// the RED encoding; the green pass implements it. Scenario titles and leaf
// names below are the inventory identity: keep verbatim in every future
// commit. Env: fake HOME; engine binary resolved BEFORE env isolation and
// re-injected via CHHOUND_BINARY so enginePython() resolves the engine venv
// python (duckdb) for the probe and fixture children.

const READY_MS = 15_000;

function pythonScript(...lines: string[]): string {
	return lines.join("\n");
}

/** One-shot python run; resolves with its exit code (null on spawn error). */
function runPython(py: string, script: string, args: string[]): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(py, ["-c", script, ...args], { stdio: ["ignore", "ignore", "ignore"] });
		child.on("error", () => resolve(null));
		child.on("exit", (code) => resolve(code));
	});
}

/** Polls until the file appears or the deadline passes. */
async function waitForFile(file: string, timeoutMs = READY_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return fs.existsSync(file);
}

/** Polls a predicate; no sleeps as evidence (barrier polls only). */
async function pollUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = READY_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return predicate();
}

function spawnHeldChild(py: string, script: string, args: string[]): ReturnType<typeof spawn> {
	return spawn(py, ["-c", script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

function childExited(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) return resolve(child.exitCode);
		child.once("exit", (code) => resolve(code));
	});
}

async function makeSeedDb(py: string, dbPath: string): Promise<void> {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const script = pythonScript(
		"import duckdb, sys",
		"c = duckdb.connect(sys.argv[1])",
		"c.execute('create table t (i integer)')",
		"c.execute('insert into t values (1),(2),(3)')",
		"c.close()",
	);
	const code = await runPython(py, script, [dbPath]);
	if (code !== 0) throw new Error(`seed db creation failed with exit ${code}`);
}

function contentSha256(dbPath: string): string {
	return createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
}

function fileShape(dbPath: string): { size: number; mtimeMs: number; sha256: string } {
	const s = fs.statSync(dbPath);
	return { size: s.size, mtimeMs: s.mtimeMs, sha256: contentSha256(dbPath) };
}

const RW_OPEN_SCRIPT = pythonScript(
	"import duckdb, sys",
	"try:",
	"    c = duckdb.connect(sys.argv[1])",
	"    c.close()",
	"    sys.exit(0)",
	"except Exception:",
	"    sys.exit(3)",
);

const RW_HOLD_SCRIPT = pythonScript(
	"import duckdb, sys",
	"c = duckdb.connect(sys.argv[1])",
	"open(sys.argv[2], 'w').write('READY')",
	"sys.stdin.readline()",
	"c.close()",
);

// Read-only holder used as the module's "python" via a fixture wrapper
// executable: it opens the db read_only (taking the shared lock), signals the
// test through a barrier file, then stalls WITHOUT the module's ready
// handshake on stdout — so the module's handshake deadline must fire, kill
// the child and report busy. argv: [dbPath, barrierFile].
const STALL_PY = pythonScript(
	'import duckdb, sys, time',
	'c = duckdb.connect(sys.argv[1], read_only=True)',
	'open(sys.argv[2], "w").write("READY")',
	'time.sleep(30)',
);

async function makeStallPython(py: string, dbPath: string, barrierFile: string): Promise<string> {
	const wrapper = path.join(path.dirname(dbPath), "stall-python");
	// The module spawns: python -c <internal script> <dbPath>; the wrapper
	// discards the internal script and runs the read-only stall instead.
	const text = pythonScript("#!/bin/sh", `exec '${py}' -c '${STALL_PY}' "$3" '${barrierFile}'`, "");
	fs.writeFileSync(wrapper, text, { mode: 0o755 });
	return wrapper;
}

describe("c2 ro-lease", () => {
	test("C2 RO lease: probe on a free real index reports leased; release closes the child and frees the index", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-lease-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			const db = path.join(root, "seed", "free.db");
			await makeSeedDb(py, db);
			const before = fileShape(db);

			let lease: Awaited<ReturnType<typeof acquireRoLease>> | undefined;
			try {
				const outcome = await acquireRoLease(db);
				await check(t, "C2 free index probe reports leased with a held lock", outcome.kind === "leased");
				if (outcome.kind !== "leased") return;
				lease = outcome;
				const closedP = outcome.lease.closed;

				// While the RO lease is held a second writer must not be able to
				// open the index (copy coherence under the held read lock).
				const writerCode = await runPython(py, RW_OPEN_SCRIPT, [db]);
				await check(t, "C2 a second writer cannot open the index while the lease is held", writerCode === 3);

				const shapeWhileHeld = fileShape(db);
				await check(
					t,
					"C2 the lease leaves the source db bytes, mtime and content untouched",
					shapeWhileHeld.size === before.size &&
						shapeWhileHeld.mtimeMs === before.mtimeMs &&
						shapeWhileHeld.sha256 === before.sha256,
				);

				await outcome.lease.release();
				const closed = await closedP;
				await check(t, "C2 release closes the probe child (EOF)", closed.code === 0 && closed.signal === null);

				const afterRelease = await runPython(py, RW_OPEN_SCRIPT, [db]);
				await check(t, "C2 release frees the index for a writer", afterRelease === 0);

				const again = await acquireRoLease(db);
				await check(t, "C2 a later probe leases again after release", again.kind === "leased");
				if (again.kind === "leased") {
					const againClosedP = again.lease.closed;
					await again.lease.release();
					const againClosed = await againClosedP;
					await check(t, "C2 re-lease closes its probe child (EOF)", againClosed.code === 0 && againClosed.signal === null);
				}

				const shapeAfter = fileShape(db);
				await check(
					t,
					"C2 probe and release leave the source db bytes, mtime and content untouched",
					shapeAfter.size === before.size &&
						shapeAfter.mtimeMs === before.mtimeMs &&
						shapeAfter.sha256 === before.sha256,
				);
			} finally {
				if (lease && lease.kind === "leased") await lease.lease.release();
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 RO lease: an external kill of the leased child is observed and leaves no stale handle", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-lease-kill-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			const db = path.join(root, "seed", "kill.db");
			await makeSeedDb(py, db);

			let lease: Awaited<ReturnType<typeof acquireRoLease>> | undefined;
			try {
				const outcome = await acquireRoLease(db);
				await check(t, "C2 kill fixture: probe reports leased", outcome.kind === "leased");
				if (outcome.kind !== "leased") return;
				lease = outcome;
				const { lease: held } = outcome;

				let closed: { code: number | null; signal: string | null } | undefined;
				let closedError: unknown;
				held.closed.then(
					(r: { code: number | null; signal: string | null }) => {
						closed = r;
					},
					(e: unknown) => {
						closedError = e;
					},
				);

				process.kill(held.childPid, "SIGKILL");
				const sawClosed = await pollUntil(() => closed !== undefined || closedError !== undefined);
				await check(
					t,
					"C2 leased child death resolves closed with its signal",
					sawClosed && closed?.signal === "SIGKILL",
				);

				// The killed child's read lock is gone: a writer can open again, and
				// release() after death is safe (idempotent, never throws).
				const writerOk = await pollUntil(async () => (await runPython(py, RW_OPEN_SCRIPT, [db])) === 0);
				await check(t, "C2 the writer can open the index once the leased child is gone", writerOk);
				let releasedAfterDeath = false;
				try {
					await held.release();
					releasedAfterDeath = true;
				} catch {
					releasedAfterDeath = false;
				}
				await check(t, "C2 release after child death is safe and does not throw", releasedAfterDeath);
			} finally {
				if (lease && lease.kind === "leased") await lease.lease.release();
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 RO lease: a writer holding the index reports busy; the probe leases again after the writer releases", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-lease-busy-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			const db = path.join(root, "seed", "held.db");
			await makeSeedDb(py, db);
			const before = fileShape(db);

			const readyFile = path.join(root, "writer.ready");
			const writer = spawnHeldChild(py, RW_HOLD_SCRIPT, [db, readyFile]);
			try {
				await check(t, "C2 busy fixture: writer child holds the index", await waitForFile(readyFile));

				const outcome = await acquireRoLease(db);
				await check(t, "C2 writer-held index reports busy", outcome.kind === "busy" && outcome.reason === "probe");

				const shapeBusy = fileShape(db);
				await check(
					t,
					"C2 busy rejection leaves the source db bytes, mtime and content untouched",
					shapeBusy.size === before.size &&
						shapeBusy.mtimeMs === before.mtimeMs &&
						shapeBusy.sha256 === before.sha256,
				);
			} finally {
				writer.stdin?.end();
				await childExited(writer);
			}

			const again = await acquireRoLease(db);
			await check(t, "C2 the probe leases again once the writer releases", again.kind === "leased");
			if (again.kind === "leased") {
				const againClosedP = again.lease.closed;
				await again.lease.release();
				const againClosed = await againClosedP;
				await check(t, "C2 the post-release probe closes its child (EOF)", againClosed.code === 0 && againClosed.signal === null);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 RO lease: writer artifacts are busy-equivalent, missing python is ineligible, a stalled handshake times out", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-lease-reject-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			// Artifacts are rejected per artifact on a REAL db that first probes
			// leased — a garbage db must never satisfy the artifact leaves.
			const artifactDb = path.join(root, "artifacts", "art.db");
			await makeSeedDb(py, artifactDb);
			const before = fileShape(artifactDb);

			const cleanProbe = await acquireRoLease(artifactDb);
			await check(t, "C2 artifact fixture db probes leased when clean", cleanProbe.kind === "leased");
			if (cleanProbe.kind === "leased") {
				const cleanClosedP = cleanProbe.lease.closed;
				await cleanProbe.lease.release();
				const cleanClosed = await cleanClosedP;
				await check(t, "C2 the clean fixture probe closes its child (EOF)", cleanClosed.code === 0 && cleanClosed.signal === null);
			}

			for (const artifact of [".wal", ".compact_backup", ".compact_new"] as const) {
				fs.writeFileSync(`${artifactDb}${artifact}`, "writer");
				const outcome = await acquireRoLease(artifactDb);
				await check(
					t,
					`C2 ${artifact} beside the index is rejected busy`,
					outcome.kind === "busy" && outcome.reason === artifact.slice(1),
				);
				fs.rmSync(`${artifactDb}${artifact}`);
			}

			// Artifact rejection must happen before any probe spawn: with an
			// unusable python the artifact verdict still wins over ineligible.
			fs.writeFileSync(`${artifactDb}.wal`, "writer");
			const preSpawn = await acquireRoLease(artifactDb, { python: path.join(root, "no", "such", "python") });
			await check(t, "C2 artifact rejection happens before any probe spawn", preSpawn.kind === "busy");
			fs.rmSync(`${artifactDb}.wal`);

			const missingPy = await acquireRoLease(artifactDb, { python: path.join(root, "no", "such", "python") });
			await check(t, "C2 missing python resolves ineligible, never busy", missingPy.kind === "ineligible");

			const shapeArtifacts = fileShape(artifactDb);
			await check(
				t,
				"C2 artifact rejection leaves the source db bytes, mtime and content untouched",
				shapeArtifacts.size === before.size &&
					shapeArtifacts.mtimeMs === before.mtimeMs &&
					shapeArtifacts.sha256 === before.sha256,
			);

			// Stalled handshake: a python that holds the read lock but never
			// performs the module's ready handshake must hit the deadline.
			const stallDb = path.join(root, "stall", "stall.db");
			await makeSeedDb(py, stallDb);
			const stallBefore = fileShape(stallDb);
			const barrierFile = path.join(root, "stall", "stall.ready");
			const stallPython = await makeStallPython(py, stallDb, barrierFile);
			const stalled = await acquireRoLease(stallDb, { python: stallPython, handshakeTimeoutMs: 3_000 });
			await check(
				t,
				"C2 a stalled handshake times out busy",
				stalled.kind === "busy" && stalled.reason === "timeout",
			);
			const reachedLock = await waitForFile(barrierFile, 5_000);
			await check(t, "C2 the stalled probe reached the read-only lock before the timeout", reachedLock);
			// The timed-out probe child must be reaped: its read lock is gone, so
			// a writer can open the index again.
			const writerOk = await pollUntil(async () => (await runPython(py, RW_OPEN_SCRIPT, [stallDb])) === 0);
			await check(t, "C2 the timed-out probe child is reaped (its read lock is gone)", writerOk);
			const stallAfter = fileShape(stallDb);
			await check(
				t,
				"C2 the stalled handshake leaves the source db bytes, mtime and content untouched",
				stallAfter.size === stallBefore.size &&
					stallAfter.mtimeMs === stallBefore.mtimeMs &&
					stallAfter.sha256 === stallBefore.sha256,
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
