import * as fs from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ProgressUI {
	setLine(line: string): void;
	setPhase(phase: string): void;
	/** Watch a db path whose byte size tracks index growth (file, .wal sibling, or dir). */
	setWatchDir(dir: string | undefined): void;
	done(): void;
	/** Elapsed milliseconds since the UI was created. */
	elapsed(): number;
}

export interface ProgressState {
	/** Batch progress parsed from chunkhound --verbose stderr. */
	batchCurrent?: number;
	batchTotal?: number;
	/** Chunks in the most recent batch line. */
	batchChunks?: number;
	/** Highest "Batch N completed" seen — the honest progress signal. */
	batchDone?: number;
	/** Bytes in the watched db path (last heartbeat sample). */
	dbBytes?: number;
	/** Bytes when the watch started — the delta shows live growth. */
	dbStartBytes?: number;
	phase: string;
	lastLine: string;
	elapsedMs: number;
}

const KEY = "chhound";
const MAX_WIDGET_LINES = 5;
const MAX_LINE_LEN = 140;
const HEARTBEAT_MS = 1000;

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Loguru stderr line shape: "2026-08-30 13:31:02 | DEBUG    | mod:fn:line - message". */
const LOGURU_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| (\w+)\s+\| .*? - (.*)$/;
/** Real per-batch progress, only emitted with chunkhound --verbose. */
const BATCH_RE = /Processing batch (\d+)\/(\d+)(?: with (\d+) chunks)?/;
const BATCH_DONE_RE = /Batch (\d+) completed: \d+ embeddings stored/;

/**
 * Extract progress signals from one chunkhound output line.
 * Returns null when the line carries no progress info.
 */
export function parseChhoundLine(line: string): { batchCurrent?: number; batchTotal?: number; batchChunks?: number; batchDone?: number } | null {
	const batch = BATCH_RE.exec(line);
	if (batch) {
		return {
			batchCurrent: Number(batch[1]),
			batchTotal: Number(batch[2]),
			...(batch[3] ? { batchChunks: Number(batch[3]) } : {}),
		};
	}
	const done = BATCH_DONE_RE.exec(line);
	if (done) {
		return { batchDone: Number(done[1]) };
	}
	return null;
}

/**
 * Decide whether a chunkhound output line is worth showing in the widget.
 * stdout formatter lines pass through; loguru stderr noise is dropped unless
 * it is a warning/error or real batch progress.
 */
export function surfaceChhoundLine(line: string): string | null {
	const m = LOGURU_RE.exec(line);
	if (!m) return line;
	const [_, level, msg] = m;
	if (level === "WARNING" || level === "ERROR" || level === "CRITICAL") return `${level}: ${msg}`;
	if (BATCH_RE.test(msg) || BATCH_DONE_RE.test(msg)) return msg;
	return null;
}

/** Single-line status text for the footer, driven by the best signal available. */
export function buildStatusText(state: ProgressState): string {
	const elapsed = formatElapsed(state.elapsedMs);
	const dbPart = (() => {
		if (state.dbBytes === undefined) return "";
		const delta = state.dbStartBytes !== undefined ? state.dbBytes - state.dbStartBytes : 0;
		if (delta > 64 * 1024) return ` · db ${formatBytes(state.dbBytes)} +${formatBytes(delta)}`;
		if (state.dbBytes > 0) return ` · db ${formatBytes(state.dbBytes)}`;
		return "";
	})();
	if (state.batchTotal) {
		if (state.batchDone) {
			return `embedding · ${state.batchDone}/${state.batchTotal}${dbPart} · ${elapsed}`;
		}
		const chunks = state.batchChunks ? ` (${state.batchChunks} chunks)` : "";
		return `embedding · batch ${state.batchCurrent}/${state.batchTotal}${chunks}${dbPart} · ${elapsed}`;
	}
	if (state.dbBytes !== undefined && state.dbBytes > 0) {
		return `${state.phase}${dbPart} · ${elapsed}`;
	}
	return state.lastLine && state.lastLine !== state.phase ? `${state.phase} · ${state.lastLine} · ${elapsed}` : `${state.phase} · ${elapsed}`;
}

/** Bytes under a db path: a duckdb file (incl. its .wal sibling) or a directory tree. */
function watchBytes(p: string): number {
	try {
		const st = fs.statSync(p);
		if (st.isFile()) {
			try {
				return st.size + fs.statSync(`${p}.wal`).size;
			} catch {
				return st.size;
			}
		}
	} catch {
		// not a file (yet) — fall through to directory walk
	}
	let total = 0;
	try {
		for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
			const child = `${p}/${entry.name}`;
			if (entry.isDirectory()) total += watchBytes(child);
			else if (entry.isFile()) total += fs.statSync(child).size || 0;
		}
	} catch {
		// path not created yet — treat as empty
	}
	return total;
}

/**
 * Live progress surface for a long-running chunkhound invocation:
 * - `setStatus` footer line, refreshed every second by a heartbeat.
 * - Real progress signals: chunkhound --verbose emits "Processing batch X/N"
 *   on stderr (embedding phase), and the db dir grows as batches are written —
 *   the heartbeat samples the watched db path and reports size + growth.
 * - `setWidget` last-5-lines window above the editor (filtered output).
 * - `setPhase` labels the current phase (baseline prime vs worktree top-up).
 * Guarded by ctx.hasUI; RPC-safe (status/widget are fire-and-forget messages).
 */
export function createProgressUI(ctx: ExtensionCommandContext, opts: { watchPath?: string } = {}): ProgressUI {
	const hasUI = ctx.hasUI;
	const lines: string[] = [];
	const startedAt = Date.now();
	const state: ProgressState = { phase: "indexing", lastLine: "", elapsedMs: 0 };
	let watchPath = opts.watchPath;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const sampleDb = () => {
		if (!watchPath) {
			state.dbBytes = undefined;
			state.dbStartBytes = undefined;
			return;
		}
		const bytes = watchBytes(watchPath);
		if (state.dbStartBytes === undefined) state.dbStartBytes = bytes;
		state.dbBytes = bytes;
	};

	const renderStatus = () => {
		if (!hasUI) return;
		state.elapsedMs = Date.now() - startedAt;
		const text = buildStatusText(state);
		ctx.ui.setStatus(KEY, text.length > MAX_LINE_LEN ? text.slice(0, MAX_LINE_LEN) + "…" : text);
	};

	if (hasUI) {
		heartbeat = setInterval(() => {
			sampleDb();
			renderStatus();
		}, HEARTBEAT_MS);
	}

	const setLine = (line: string) => {
		const parsed = parseChhoundLine(line);
		if (parsed?.batchTotal) {
			state.batchCurrent = parsed.batchCurrent;
			state.batchTotal = parsed.batchTotal;
			if (parsed.batchChunks) state.batchChunks = parsed.batchChunks;
		}
		if (parsed?.batchDone !== undefined && parsed.batchDone > (state.batchDone ?? 0)) {
			state.batchDone = parsed.batchDone;
		}
		const t = line.trim();
		if (!t) return;
		const short = t.length > MAX_LINE_LEN ? t.slice(0, MAX_LINE_LEN) + "…" : t;
		// Only surfaced lines update the widget and the status fallback line —
		// loguru DEBUG noise never bleeds through.
		const shown = surfaceChhoundLine(short);
		if (!shown) return;
		state.lastLine = shown;
		if (!hasUI) return;
		lines.push(shown);
		if (lines.length > MAX_WIDGET_LINES) lines.shift();
		ctx.ui.setWidget(KEY, [...lines], { placement: "aboveEditor" });
		renderStatus();
	};

	const setPhase = (next: string) => {
		state.phase = next;
		renderStatus();
	};

	const setWatchDir = (dir: string | undefined) => {
		watchPath = dir;
		state.dbStartBytes = undefined;
		state.dbBytes = undefined;
		sampleDb();
		renderStatus();
	};

	const done = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (!hasUI) return;
		ctx.ui.setStatus(KEY, undefined);
		ctx.ui.setWidget(KEY, undefined);
	};

	return { setLine, setPhase, setWatchDir, done, elapsed: () => Date.now() - startedAt };
}
