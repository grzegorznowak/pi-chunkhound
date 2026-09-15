import { decodeKittyPrintable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { BorderLine, promptViaCustom, type CustomPromptUI, type ThemeLike } from "./path-input.js";

/**
 * Plugin-owned select dialog. pi's built-in ctx.ui.select highlights the
 * selected row with accent-colored text only (`getSelectListTheme()`:
 * selectedPrefix/selectedText = fg("accent")) and exposes no styling knobs, so
 * the wizard's repo picker looked nothing like the /ch-worktree manager panel.
 * This component keeps the built-in dialog chrome (border, title, hint) and
 * renders the cursor row like the manager does: accent arrow, bold label, and
 * the theme's selectedBg band across the full width. Keyboard behavior mirrors
 * the built-in select (↑/↓/j/k, PgUp/PgDn, Enter, Esc), with the same 12-row
 * viewport + `(i/n)` indicator. RPC/print modes fall back to ui.select.
 */

/** Rows in the scroll viewport (the full option list stays reachable). */
const MAX_VISIBLE = 12;

/** Structural theme slice the panel needs (pi's Theme satisfies it). */
export type PickTheme = ThemeLike;

export interface PickOptions {
	title: string;
	options: readonly string[];
	/** Dim footer hint; defaults to the built-in select wording. */
	hint?: string;
}

/** Structural slice of ctx.ui used by promptPick (real ui satisfies it). */
export interface PickPromptUI extends CustomPromptUI {
	select?(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Ask the user to pick one option (TUI). Falls back to ctx.ui.select where
 * ctx.ui.custom is unavailable — including hosts whose `custom()` resolves
 * without rendering (RPC/print), which the shared seam detects.
 */
export async function promptPick(ui: PickPromptUI, opts: PickOptions): Promise<string | undefined> {
	// An empty list has nothing to pick: never render a zero-row dialog whose
	// Enter would resolve `options[0] === undefined` (indistinguishable from a
	// cancel) — the caller treats undefined as "cancelled/nothing to pick".
	if (opts.options.length === 0) return undefined;
	const viaCustom = await promptViaCustom<string | undefined>(ui, (tui, theme, keybindings, done) => new PickPanelComponent(tui, theme, keybindings, opts, done));
	if (viaCustom.kind === "custom") return viaCustom.value;
	return ui.select?.(opts.title, [...opts.options]);
}

export class PickPanelComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: PickTheme;
	private readonly kb: KeybindingsManager;
	private readonly opts: PickOptions;
	private readonly done: (value: string | undefined) => void;
	private readonly border: BorderLine;
	private selectedIndex = 0;
	/** First visible row (option index) of the viewport window. */
	private scrollOffset = 0;

	constructor(
		tui: TUI,
		theme: PickTheme,
		keybindings: KeybindingsManager,
		opts: PickOptions,
		done: (value: string | undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.kb = keybindings;
		this.opts = opts;
		this.done = done;
		this.border = new BorderLine(theme);
	}

	/** Currently highlighted option index (exposed for tests). */
	get index(): number {
		return this.selectedIndex;
	}

	/** Static panel — no cached child state to invalidate. */
	invalidate(): void {}

	handleInput(keyData: string): void {
		// j/k join the arrows (the built-in select accepts them too). Printable
		// keys arrive as Kitty CSI-u under the negotiated keyboard protocol, so
		// decode before comparing.
		const text = decodeKittyPrintable(keyData) ?? (keyData.length === 1 ? keyData : undefined);
		if (this.kb.matches(keyData, "tui.select.down") || text === "j") {
			this.move(1);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.up") || text === "k") {
			this.move(-1);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.pageDown")) {
			this.move(MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.pageUp")) {
			this.move(-MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.done(this.opts.options[this.selectedIndex]);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	render(width: number): string[] {
		const count = this.opts.options.length;
		const start = this.scrollOffset;
		const end = Math.min(count, start + MAX_VISIBLE);
		const lines: string[] = [
			this.border.render(width)[0]!,
			"",
			` ${this.theme.bold(this.theme.fg("accent", this.opts.title))}`,
			"",
		];
		for (let index = start; index < end; index++) {
			lines.push(this.row(this.opts.options[index]!, index === this.selectedIndex, width));
		}
		if (count > MAX_VISIBLE) lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${count})`));
		const paging = count > MAX_VISIBLE ? " · PgUp/PgDn page" : "";
		lines.push("", ` ${this.theme.fg("dim", this.opts.hint ?? `↑↓/j/k navigate${paging} · Enter select · Esc cancel`)}`, "", this.border.render(width)[0]!);
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	/** The manager's cursor row: accent arrow, bold label, selectedBg band. */
	private row(option: string, selected: boolean, width: number): string {
		const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
		const label = selected ? this.theme.bold(option) : option;
		const line = `${marker}${label}`;
		if (!selected) return line;
		return this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
	}

	/** Move the cursor (clamped, no wrap) and keep it inside the viewport. */
	private move(delta: number): void {
		const last = this.opts.options.length - 1;
		this.selectedIndex = Math.min(last, Math.max(0, this.selectedIndex + delta));
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
		this.tui.requestRender();
	}
}
