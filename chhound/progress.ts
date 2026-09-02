import * as fs from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Live progress machinery for long-running chunkhound invocations
 * (`/chworktree` baseline prime + worktree top-up).
 *
 * A single run consists of two SEQUENTIAL passes, each with its own progress
 * signal inside `chhound index --verbose` output (both piped streams, see
 * runChhound in cli.ts):
 *
 *  - pass 1 — chunk generation: `Parsing N files with M workers` gives the
 *    work total; one `Batch inserted K chunks for file_id X` line per stored
 *    file and `Skipped file: …` lines count completion. Rail unit: files.
 *  - pass 2 — embeddings: `Processing batch X/N with K chunks` gives the
 *    batch total; `Batch X completed: …` lines count completion. Batches run
 *    CONCURRENTLY (acks arrive out of order), so completion is tracked as the
 *    count of DISTINCT completed batch numbers — max(X) would overcount and
 *    current X races ahead of real progress. Rail unit: batches.
 *
 * The rail (one bar) always shows the ACTIVE pass and resets between passes;
 * the stage word on the header line ("chunking" / "embedding" / "finalizing")
 * makes the reset readable. Stages without signals render a sweeping rail
 * instead of a fake percent.
 *
 * ONE surface, widget key "chhound" above the editor (`ctx.ui.setWidget`):
 * header + 40-cell rail + up to MAX_EVENTS warning/error lines. The footer
 * status stays untouched (the widget alone carries the progress — user
 * decision 2026-09-02).
 *
 * Engine stdout is CURATED, not echoed: everything except the two known stage
 * markers is suppressed (default-deny), loguru INFO/DEBUG noise is dropped,
 * and WARNING/ERROR/CRITICAL become display events. Surfaces re-render once
 * per second (HEARTBEAT_MS) — never per engine line — so the widget is stable
 * instead of churning through engine scrollback.
 *
 * Builders (`buildWidgetLines`) are pure and return the
 * plain canonical strings (optionally colorized through a ProgressPalette);
 * tests assert the plain form. Guarded by ctx.hasUI; RPC-safe.
 */

export interface ProgressUI {
	setLine(line: string): void;
	/** Start a new run/phase: resets all pass counters (each phase = one engine run). */
	setPhase(phase: string): void;
	/** Plugin-originated stage note (e.g. "copying baseline index…"); cleared by any engine output. */
	setNote(note: string | undefined): void;
	/** Watch a db path whose byte size tracks index growth (file, .wal sibling, or dir). */
	setWatchDir(dir: string | undefined): void;
	done(): void;
	/** Elapsed milliseconds since the UI was created. */
	elapsed(): number;
}

export interface ProgressState {
	phase: string;
	/** Plugin-originated stage note (shown until the engine speaks). */
	note?: string;
	/** Pass 1: files to parse ("Parsing N files …"), run-scoped. */
	filesTotal?: number;
	/** Pass 1: files stored or skipped, run-scoped (capped at filesTotal). */
	filesDone?: number;
	/** Pass 2: batch currently starting (X from "Processing batch X/N"). */
	batchCurrent?: number;
	/** Pass 2: total batches (N). */
	batchesTotal?: number;
	/** Pass 2: distinct completed batches (honest under concurrency). */
	batchesDone?: number;
	/** Bytes in the watched db path (last heartbeat sample). */
	dbBytes?: number;
	/** Bytes when the watch started — the delta shows live growth. */
	dbStartBytes?: number;
	/** Curated warning/error messages, oldest first, ≤ MAX_EVENTS. */
	events: string[];
	/** Animation frame counter — advanced once per heartbeat. */
	tick: number;
	elapsedMs: number;
}

export interface ProgressPalette {
	fill(text: string): string;
	empty(text: string): string;
	warn(text: string): string;
}

export const PLAIN_PALETTE: ProgressPalette = { fill: (s) => s, empty: (s) => s, warn: (s) => s };

const KEY = "chhound";
const MAX_LINE_LEN = 140;
const HEARTBEAT_MS = 1000;
export const MAX_EVENTS = 2;
export const WIDGET_BAR_CELLS = 40;
const SWEEP_WINDOW = 4;
const FILL = "█";
const EMPTY = "░";

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

/** 1234 → "1,234" (locale-independent, so tests are stable). */
export function groupDigits(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Visible-width clip with ellipsis — safe on already-colored text. */
function clip(text: string, width = MAX_LINE_LEN): string {
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
}

// ── Engine line classification ───────────────────────────────────────────────

/** Loguru stderr line shape: "2026-08-30 13:31:02 | DEBUG | mod:fn:line - message". */
const LOGURU_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| (\w+)\s+\| .*? - (.*)$/;
const BATCH_RE = /^Processing batch (\d+)\/(\d+)(?: with (\d+) chunks)?$/;
const BATCH_DONE_RE = /^Batch (\d+) completed: \d+ embeddings stored$/;
const PARSE_TOTAL_RE = /^Parsing (\d+) files with \d+ workers/;
const FILE_STORED_RE = /^Batch inserted \d+ chunks for file_id \d+$/;
const FILE_SKIPPED_RE = /^Skipped file: .* \(reason: .*\)$/;
/** The only engine stdout lines we recognize (stage markers; no visual effect yet). */
const STDOUT_MARKERS = [/^\[DEBUG\] Discovering files\.\.\.$/, /^\[DEBUG\] Checking for missing embeddings\.\.\.$/];

export type ChhoundSignal =
	| { kind: "batch"; current: number; total: number; chunks?: number }
	| { kind: "batchDone"; n: number }
	| { kind: "parseTotal"; files: number }
	| { kind: "fileStored" }
	| { kind: "fileSkipped" }
	| { kind: "event"; level: "WARNING" | "ERROR" | "CRITICAL"; message: string }
	| { kind: "marker" }
	| { kind: "noise" };

/**
 * Classify one chunkhound output line (stdout+stderr merged).
 * Default-deny: anything that is not a known progress signal, marker or
 * warning/error is noise — engine banner/summary lines and loguru INFO/DEBUG
 * chatter never reach the surfaces.
 */
export function classifyChhoundLine(line: string): ChhoundSignal {
	const m = LOGURU_RE.exec(line);
	if (!m) {
		if (STDOUT_MARKERS.some((r) => r.test(line))) return { kind: "marker" };
		return { kind: "noise" };
	}
	const level = m[1]!;
	const msg = m[2]!.trim();
	if (level === "WARNING" || level === "ERROR" || level === "CRITICAL") {
		return { kind: "event", level, message: msg };
	}
	if (level !== "DEBUG") return { kind: "noise" }; // loguru INFO etc.
	const batch = BATCH_RE.exec(msg);
	if (batch) {
		return {
			kind: "batch",
			current: Number(batch[1]),
			total: Number(batch[2]),
			...(batch[3] ? { chunks: Number(batch[3]) } : {}),
		};
	}
	const done = BATCH_DONE_RE.exec(msg);
	if (done) return { kind: "batchDone", n: Number(done[1]) };
	const parsed = PARSE_TOTAL_RE.exec(msg);
	if (parsed) return { kind: "parseTotal", files: Number(parsed[1]) };
	if (FILE_STORED_RE.test(msg)) return { kind: "fileStored" };
	if (FILE_SKIPPED_RE.test(msg)) return { kind: "fileSkipped" };
	return { kind: "noise" };
}

// ── Track/stage derivation (pure) ────────────────────────────────────────────

export type Track = { unit: "files" | "batches"; done: number; total: number } | undefined;

/** The active track: the embedding pass wins once batch lines arrived; else the parse pass. */
export function activeTrack(state: ProgressState): Track {
	if (state.batchesTotal !== undefined) {
		return { unit: "batches", done: state.batchesDone ?? 0, total: state.batchesTotal };
	}
	if (state.filesTotal !== undefined) {
		return { unit: "files", done: state.filesDone ?? 0, total: state.filesTotal };
	}
	return undefined;
}

/** Stage word for the header: chunking → embedding → finalizing (or the plugin note / "indexing"). */
export function stageWord(state: ProgressState, track: Track): string {
	if (track) {
		if (track.done >= track.total) return "finalizing";
		return track.unit === "files" ? "chunking" : "embedding";
	}
	return state.note ?? "indexing";
}

function dbPart(state: ProgressState): string {
	if (state.dbBytes === undefined || state.dbBytes <= 0) return "";
	const delta = state.dbStartBytes !== undefined ? state.dbBytes - state.dbStartBytes : 0;
	if (delta > 64 * 1024) return ` · db ${formatBytes(state.dbBytes)} +${formatBytes(delta)}`;
	return ` · db ${formatBytes(state.dbBytes)}`;
}

/** "124/200 files" / "5/12 batches" (locale-stable grouping). */
function fractionText(done: number, total: number, unit: string): string {
	return `${groupDigits(done)}/${groupDigits(total)} ${unit}`;
}

/** Cells lit for a fraction (0..1), rounded to whole cells. */
export function filledCells(fraction: number, cells: number): number {
	const f = Math.max(0, Math.min(1, fraction));
	return Math.round(f * cells);
}

/** Determinate rail of `cells` blocks (footer: 10, widget: 40). */
function determinateRail(palette: ProgressPalette, done: number, total: number, cells: number): string {
	const f = filledCells(total > 0 ? done / total : 0, cells);
	return palette.fill(FILL.repeat(f)) + palette.empty(EMPTY.repeat(cells - f));
}

/** Indeterminate sweep: a moving window of lit cells (wraps around the rail). */
function sweepRail(palette: ProgressPalette, cells: number, tick: number): string {
	const out: string[] = [];
	const pos = ((tick % cells) + cells) % cells;
	for (let i = 0; i < cells; i++) {
		const lit = (i >= pos && i < pos + SWEEP_WINDOW) || (pos + SWEEP_WINDOW > cells && i < (pos + SWEEP_WINDOW) % cells);
		out.push(lit ? FILL : EMPTY);
	}
	// colorize in runs (fill run(s), empty run(s)) — up to 3 runs
	const runs: Array<{ ch: string; n: number }> = [];
	for (const ch of out) {
		const last = runs[runs.length - 1];
		if (last && last.ch === ch) last.n++;
		else runs.push({ ch, n: 1 });
	}
	let text = "";
	for (const r of runs) text += r.ch === FILL ? palette.fill(FILL.repeat(r.n)) : palette.empty(EMPTY.repeat(r.n));
	return text;
}

// ── Surfaces (pure builders; plain strings when no palette given) ────────────

/**
 * Single-line footer status (canonical plain form):
 *  determinate:  `worktree index (top-up) ██████░░░░ 124/200 files · db 5.1 MB +3.1 MB · 2:05`
/**
 * Widget lines above the editor:
 *  L1: `worktree index (top-up) — embedding · db 7.8 MB +4.1 MB · 1:42`
 *  L2: `██████████████████░░░░░░░░░░░░░░░░░░░░░░ 45% · 636/1,412 files` (or `done · 1,412/1,412 files`), sweep rail when indeterminate
 *  L3+: ≤ MAX_EVENTS `⚠ …` lines
 */
export function buildWidgetLines(state: ProgressState, palette: ProgressPalette = PLAIN_PALETTE): string[] {
	const elapsed = formatElapsed(state.elapsedMs);
	const track = activeTrack(state);
	const header = `${state.phase} — ${stageWord(state, track)}${dbPart(state)} · ${elapsed}`;
	const lines = [clip(header)];
	if (track) {
		const pct = track.total > 0 ? Math.min(100, Math.round((track.done / track.total) * 100)) : 0;
		const railText = determinateRail(palette, track.done, track.total, WIDGET_BAR_CELLS);
		const right = pct >= 100 ? `done · ${fractionText(track.done, track.total, track.unit)}` : `${pct}% · ${fractionText(track.done, track.total, track.unit)}`;
		lines.push(clip(`${railText} ${right}`));
	} else {
		lines.push(clip(sweepRail(palette, WIDGET_BAR_CELLS, state.tick)));
	}
	for (const event of state.events ?? []) {
		lines.push(clip(`${palette.warn("⚠")} ${event}`));
	}
	return lines;
}

// ── Db watch ─────────────────────────────────────────────────────────────────

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

// ── Live UI ──────────────────────────────────────────────────────────────────

/** Minimal structural ctx createProgressUI needs (real command ctx satisfies it). */
export interface ProgressUICtx {
	hasUI: boolean;
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: { placement: "aboveEditor" | "belowEditor" }): void;
		theme?: { fg(color: string, text: string): string };
	};
}

export function createProgressUI(ctx: ProgressUICtx, opts: { watchPath?: string } = {}): ProgressUI {
	const hasUI = ctx.hasUI;
	const startedAt = Date.now();
	const completedBatches = new Set<number>();
	const state: ProgressState = { phase: "indexing", events: [], tick: 0, elapsedMs: 0 };
	let watchPath = opts.watchPath;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	// Colors are applied only at render time; the pure builders stay plain.
	const palette: ProgressPalette = ctx.ui.theme
		? {
				fill: (t) => ctx.ui.theme!.fg("accent", t),
				empty: (t) => ctx.ui.theme!.fg("dim", t),
				warn: (t) => ctx.ui.theme!.fg("warning", t),
			}
		: PLAIN_PALETTE;

	const render = () => {
		if (!hasUI) return;
		state.elapsedMs = Date.now() - startedAt;
		// The widget is the single progress surface (footer status is unused).
		ctx.ui.setWidget(KEY, buildWidgetLines(state, palette), { placement: "aboveEditor" });
	};

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

	if (hasUI) {
		heartbeat = setInterval(() => {
			state.tick++;
			sampleDb();
			render();
		}, HEARTBEAT_MS);
	}

	const setLine = (line: string) => {
		const sig = classifyChhoundLine(line);
		// Any engine output means the process is up — plugin stage notes (e.g.
		// "copying baseline index…") are obsolete from here on.
		if (state.note !== undefined) state.note = undefined;
		switch (sig.kind) {
			case "batch":
				state.batchesTotal = sig.total;
				state.batchCurrent = sig.current;
				return; // painted by the next heartbeat
			case "batchDone":
				completedBatches.add(sig.n);
				state.batchesDone = completedBatches.size;
				return;
			case "parseTotal":
				state.filesTotal = sig.files;
				state.filesDone = 0;
				return;
			case "fileStored":
			case "fileSkipped": {
				const prev = state.filesDone ?? 0;
				const cap = state.filesTotal ?? prev + 1;
				state.filesDone = Math.min(cap, prev + 1);
				return;
			}
			case "event": {
				const event = sig.message;
				const events = [...(state.events ?? [])];
				if (events[events.length - 1] !== event) {
					events.push(event);
					if (events.length > MAX_EVENTS) events.shift();
					state.events = events;
					render(); // anomalies are rare — surface them immediately
				}
				return;
			}
			default:
				return; // marker / noise — nothing to show
		}
	};

	const setPhase = (next: string) => {
		// Each phase runs its own engine process: reset all pass counters.
		state.phase = next;
		state.note = undefined;
		state.filesTotal = undefined;
		state.filesDone = undefined;
		state.batchCurrent = undefined;
		state.batchesTotal = undefined;
		state.batchesDone = undefined;
		completedBatches.clear();
		state.events = [];
		render();
	};

	const setNote = (note: string | undefined) => {
		state.note = note;
		render();
	};

	const setWatchDir = (dir: string | undefined) => {
		watchPath = dir;
		state.dbStartBytes = undefined;
		state.dbBytes = undefined;
		sampleDb();
		render();
	};

	const done = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (!hasUI) return;
		ctx.ui.setWidget(KEY, undefined);
	};

	return { setLine, setPhase, setNote, setWatchDir, done, elapsed: () => Date.now() - startedAt };
}
