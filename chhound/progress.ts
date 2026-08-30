import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ProgressUI {
	setLine(line: string): void;
	setPhase(phase: string): void;
	done(): void;
	/** Elapsed milliseconds since the UI was created. */
	elapsed(): number;
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

/**
 * Live progress surface for a long-running chunkhound invocation:
 * - `setStatus` footer line, refreshed EVERY second by a heartbeat — chunkhound
 *   prints nothing between "Initial stats" and "Processing Complete", so the
 *   elapsed-time beat keeps the session visibly active even when the child is
 *   silent (this is exactly what happens during embedding generation).
 * - `setWidget` last-5-lines window above the editor (raw chunkhound output).
 * - `setPhase` labels the current phase (baseline prime vs worktree top-up).
 * Guarded by ctx.hasUI; RPC-safe (status/widget are fire-and-forget messages).
 */
export function createProgressUI(ctx: ExtensionCommandContext): ProgressUI {
	const hasUI = ctx.hasUI;
	const lines: string[] = [];
	const startedAt = Date.now();
	let phase = "indexing";
	let lastLine = "";
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const renderStatus = () => {
		if (!hasUI) return;
		const elapsed = formatElapsed(Date.now() - startedAt);
		const text = lastLine && lastLine !== phase ? `${phase} · ${lastLine} · ${elapsed}` : `${phase} · ${elapsed}`;
		ctx.ui.setStatus(KEY, text.length > MAX_LINE_LEN ? text.slice(0, MAX_LINE_LEN) + "…" : text);
	};

	if (hasUI) {
		heartbeat = setInterval(renderStatus, HEARTBEAT_MS);
	}

	const setLine = (line: string) => {
		const t = line.trim();
		if (!t) return;
		lastLine = t.length > MAX_LINE_LEN ? t.slice(0, MAX_LINE_LEN) + "…" : t;
		if (!hasUI) return;
		lines.push(lastLine);
		if (lines.length > MAX_WIDGET_LINES) lines.shift();
		ctx.ui.setWidget(KEY, [...lines], { placement: "aboveEditor" });
		renderStatus();
	};

	const setPhase = (next: string) => {
		phase = next;
		renderStatus();
	};

	const done = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (!hasUI) return;
		ctx.ui.setStatus(KEY, undefined);
		ctx.ui.setWidget(KEY, undefined);
	};

	return { setLine, setPhase, done, elapsed: () => Date.now() - startedAt };
}
