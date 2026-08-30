import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ProgressUI {
	setLine(line: string): void;
	done(): void;
}

const KEY = "chhound";
const MAX_WIDGET_LINES = 5;
const MAX_LINE_LEN = 140;

/**
 * Live progress surface for a long-running chunkhound invocation:
 * - `setStatus` footer line, throttled to ~4/sec
 * - `setWidget` last-5-lines window above the editor
 * - `notify` only at milestones (call sites do that)
 * Guarded by ctx.hasUI; RPC-safe (status/widget are fire-and-forget messages).
 */
export function createProgressUI(ctx: ExtensionCommandContext): ProgressUI {
	const hasUI = ctx.hasUI;
	const lines: string[] = [];
	let lastStatusAt = 0;

	const setLine = (line: string) => {
		const t = line.trim();
		if (!t || !hasUI) return;
		const short = t.length > MAX_LINE_LEN ? t.slice(0, MAX_LINE_LEN) + "…" : t;
		const now = Date.now();
		if (now - lastStatusAt >= 250) {
			ctx.ui.setStatus(KEY, short);
			lastStatusAt = now;
		}
		lines.push(short);
		if (lines.length > MAX_WIDGET_LINES) lines.shift();
		ctx.ui.setWidget(KEY, [...lines], { placement: "aboveEditor" });
	};

	const done = () => {
		if (!hasUI) return;
		ctx.ui.setStatus(KEY, undefined);
		ctx.ui.setWidget(KEY, undefined);
	};

	return { setLine, done };
}
