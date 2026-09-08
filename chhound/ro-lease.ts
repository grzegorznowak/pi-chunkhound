import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { enginePython } from "./cli.js";
import { WRITER_ARTIFACTS } from "./discovery.js";

/**
 * RO lease (Stream-2 spec §3.2, RO-LEASE step; module chhound/ro-lease.ts):
 * the TS extension spawns a python/duckdb read_only child against an
 * adoptable source index and keeps the connection open while the source is
 * copied. The child signals lock-held on stdout after the read_only connect
 * succeeds; while it lives, new writers fail on the source (copy coherence).
 * Release closes the child via stdin EOF (the child closes duckdb and exits
 * 0). Death and timeouts are monitored; the source db is never modified.
 *
 * Outcomes:
 *  - leased: the read_only handle is held until release()/death.
 *  - busy "probe": the read_only open failed (per spec: RO open fails ⇒ BUSY
 *    — typically a writer holding the index; also unreadable/corrupt db).
 *  - busy "timeout": the child never signaled lock-held before the deadline;
 *    it is killed and reaped before this resolves.
 *  - busy "wal" | "compact_backup" | "compact_new": the writer artifact sits
 *    beside the db — rejected BEFORE any probe spawn (busy-equivalent).
 *  - ineligible "no-python": the engine python (duckdb) is not resolvable or
 *    cannot be spawned — the caller notes it and falls through (adoption
 *    ineligible this round, never busy).
 */

export interface RoLeaseExit {
	code: number | null;
	signal: string | null;
}

export interface RoLease {
	readonly dbPath: string;
	/** Probe child pid (diagnostics; kill tests). */
	readonly childPid: number;
	/** Resolves when the probe child exits, for any cause (release, timeout kill, external death). */
	readonly closed: Promise<RoLeaseExit>;
	/**
	 * Closes the lease: stdin EOF makes the child close duckdb and exit 0.
	 * Idempotent; safe after the child already died (never throws).
	 */
	release(): Promise<void>;
}

export type RoLeaseOutcome =
	| { kind: "leased"; lease: RoLease }
	| {
			kind: "busy";
			reason: RoLeaseBusyReason;
	  }
	| { kind: "ineligible"; reason: "no-python" };

type RoLeaseBusyReason = "probe" | "timeout" | "wal" | "compact_backup" | "compact_new";

export interface RoLeaseOptions {
	/** Interpreter for the probe child; defaults to the engine python (enginePython()). */
	python?: string;
	/** Lock-held handshake deadline (default 10 s); the child is killed on expiry. */
	handshakeTimeoutMs?: number;
}

export const RO_LEASE_HANDSHAKE_TIMEOUT_MS = 10_000;
const RO_LEASE_TIMEOUT_KILL_GRACE_MS = 1_500;
const RO_LEASE_RELEASE_GRACE_MS = 5_000;
const READY_LINE = "READY";

const PROBE_SCRIPT = [
	"import duckdb, sys",
	"c = duckdb.connect(sys.argv[1], read_only=True)",
	`print("${READY_LINE}", flush=True)`,
	"sys.stdin.readline()",
	"c.close()",
].join("\n");

function awaitExit(child: ChildProcess, exit: Promise<RoLeaseExit>, graceMs: number): Promise<RoLeaseExit> {
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, graceMs);
	timer.unref();
	return exit.finally(() => clearTimeout(timer));
}

function spawnProbeChild(python: string, dbPath: string): { child: ChildProcess; exit: Promise<RoLeaseExit> } {
	const child = spawn(python, ["-c", PROBE_SCRIPT, dbPath], { stdio: ["pipe", "pipe", "pipe"] });
	const exit = new Promise<RoLeaseExit>((resolveExit) => {
		let resolved = false;
		const once = (code: number | null, signal: string | null): void => {
			if (resolved) return;
			resolved = true;
			resolveExit({ code, signal });
		};
		child.on("exit", (code, signal) => once(code, signal));
		child.on("error", () => once(null, null));
	});
	return { child, exit };
}

export function acquireRoLease(dbPath: string, options: RoLeaseOptions = {}): Promise<RoLeaseOutcome> {
	const python = options.python ?? enginePython();
	return new Promise<RoLeaseOutcome>((resolve) => {
		// Writer artifacts mean the engine is using the db right now; reject
		// before resolving python or spawning anything.
		for (const artifact of WRITER_ARTIFACTS) {
			if (existsSync(`${dbPath}${artifact}`)) {
				return void resolve({ kind: "busy", reason: artifact.slice(1) as RoLeaseBusyReason });
			}
		}
		if (!python) return void resolve({ kind: "ineligible", reason: "no-python" });

		const { child, exit } = spawnProbeChild(python, dbPath);
		let settled = false;
		let readySeen = false;
		let killedForTimeout = false;
		let handshakeTimer: NodeJS.Timeout | undefined;
		let stdoutBuffer = "";

		const settle = (outcome: RoLeaseOutcome): void => {
			if (settled) return;
			settled = true;
			if (handshakeTimer) clearTimeout(handshakeTimer);
			resolve(outcome);
		};

		const makeLease = (): RoLease => {
			let releasePromise: Promise<void> | undefined;
			return {
				dbPath,
				childPid: child.pid ?? -1,
				closed: exit,
				release: () => {
					// One close/reap operation; every caller awaits the same one.
					releasePromise ??= (async () => {
						if (child.exitCode !== null || child.signalCode !== null) return;
						try {
							child.stdin?.end();
						} catch {
							/* pipe already closed */
						}
						await awaitExit(child, exit, RO_LEASE_RELEASE_GRACE_MS);
					})();
					return releasePromise;
				},
			};
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			if (!readySeen && !killedForTimeout && stdoutBuffer.includes(READY_LINE)) {
				readySeen = true;
				if (handshakeTimer) clearTimeout(handshakeTimer);
				settle({ kind: "leased", lease: makeLease() });
			}
		});
		child.stderr?.resume(); // drain; connect errors surface through the exit path

		child.on("error", (err: NodeJS.ErrnoException) => {
			if (!readySeen && !killedForTimeout) {
				settle(
					err.code === "ENOENT"
						? { kind: "ineligible", reason: "no-python" }
						: { kind: "busy", reason: "probe" },
				);
			}
		});

		exit.then(({ code, signal }) => {
			if (readySeen || settled || killedForTimeout) return; // leased, settled, or the timeout path owns this exit
			if (handshakeTimer) clearTimeout(handshakeTimer);
			if (code === null && signal === null) return; // spawn error path settles via 'error'
			// The child ran but never signaled lock-held: the read_only open
			// failed — busy per spec (typically a writer holds the index).
			settle({ kind: "busy", reason: "probe" });
		});

		handshakeTimer = setTimeout(() => {
			if (readySeen || settled) return;
			killedForTimeout = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			void awaitExit(child, exit, RO_LEASE_TIMEOUT_KILL_GRACE_MS).then(() => {
				settle({ kind: "busy", reason: "timeout" });
			});
		}, options.handshakeTimeoutMs ?? RO_LEASE_HANDSHAKE_TIMEOUT_MS);
		handshakeTimer.unref();
	});
}
