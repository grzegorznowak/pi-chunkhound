import { Container, Input, Spacer, Text, decodeKittyPrintable } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { dirCompletions, type CompletionItem } from "./completions.js";

/**
 * Plugin-owned text input with the command-line dir-picker completion
 * mechanism: same dirCompletions rules — dirs only, trailing "/", ~
 * expansion, drill-down. ↑/↓ (and PgUp/PgDn to page long listings) move the
 * ▸ row and MIRROR the highlighted entry into the field, so Enter always
 * confirms what the field shows — the highlighted row after navigating, the
 * typed/prefilled value otherwise (no silent "Enter ignores the ▸ row").
 * TAB accepts the selected item (whole-value replace, like pi's
 * applyCompletion) and drills into it, Esc cancels. The completion model
 * holds the FULL filtered list rendered through a 12-row scroll window:
 * no truncation, no wrap, every entry reachable.
 *
 * pi's own ctx.ui.input has NO completion support (plain
 * ExtensionInputComponent), so this component is the only plugin-side way to
 * get TAB completion in a dialog without touching pi core.
 *
 * PLACEMENT: deliberately NOT an overlay. The host's showExtensionCustom()
 * non-overlay branch replaces the editorContainer (the prompt field) with the
 * component and focuses it — exactly how pi's built-in input dialog behaves
 * (saved editor text restored on close). overlay:true would float a
 * chrome-less box over the chat instead of showing in the prompt field.
 */

/** Rows of the completion viewport (the model holds the full filtered list). */
const MAX_VISIBLE = 12;
/** Children before the completion list: border, title, spacer, input, spacer, hint. */
const FIXED_CHILDREN = 6;

/**
 * pi-tui's Input: setValue keeps the cursor at min(cursor, value.length) —
 * i.e. at 0 on a fresh field — and the typings mark `cursor` private even
 * though it is a public runtime field. Move it to the end so typing appends
 * to prefilled/mirrored values instead of requiring cursor juggling first.
 */
function caretToEnd(input: Input): void {
	(input as unknown as { cursor: number }).cursor = input.getValue().length;
}

export interface PathInputOptions {
	title: string;
	/** Base for relative paths (session cwd). */
	cwd: string;
	/** Prefill; empty lists the cwd's dirs. */
	startValue?: string;
	includeFiles?: boolean;
	paramLabel?: string;
}

/** Structural theme slice (pi's Theme satisfies it). */
export type ThemeLike = { fg(color: string, text: string): string };

/** Structural slice of ctx.ui used by promptPath (real ui satisfies it). */
export interface PathPromptUI {
	custom?<T>(
		factory: (
			tui: TUI,
			theme: ThemeLike,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
	): Promise<T>;
	input?(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * Ask for a path with TAB completion (TUI). Falls back to plain ctx.ui.input
 * where ctx.ui.custom is unavailable (RPC/print modes).
 */
export async function promptPath(ui: PathPromptUI, opts: PathInputOptions): Promise<string | undefined> {
	if (typeof ui.custom === "function") {
		try {
			return await ui.custom<string | undefined>(
				(tui, theme, keybindings, done) => new PathInputComponent(tui, theme, keybindings, opts, done),
			);
		} catch {
			// custom failed (non-TUI) — fall through to plain input
		}
	}
	return ui.input?.(opts.title, opts.startValue);
}

export interface TextPromptOptions {
	title: string;
	/** Prefill — shown IN the field (pi's ui.input second arg is only a dimmed placeholder). */
	startValue?: string;
	/** Optional dim hint line (e.g. 'leave empty to keep the stored key'). */
	hint?: string;
}

/**
 * Generic prefilled text prompt (TUI). Same chrome as promptPath but no dir
 * completions — TAB is a plain character. Enter confirms, Esc cancels.
 * Falls back to ctx.ui.input (placeholder) where custom is unavailable.
 */
export async function promptText(ui: PathPromptUI, opts: TextPromptOptions): Promise<string | undefined> {
	if (typeof ui.custom === "function") {
		try {
			return await ui.custom<string | undefined>(
				(_tui, theme, keybindings, done) => new TextPromptComponent(theme, keybindings, opts, done),
			);
		} catch {
			// custom failed (non-TUI) — fall through to plain input
		}
	}
	return ui.input?.(opts.title, opts.startValue);
}

export class TextPromptComponent extends Container {
	private readonly input = new Input();
	private readonly theme: ThemeLike;
	private readonly kb: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;
	private readonly startValue: string;
	private _focused = false;
	/** While the prefill is untouched, printable keys build this replacement buffer. */
	private typed = "";
	private pristine = true;
	/** Bracketed-paste buffering while pristine (paste chunks replace the prefill). */
	private pasteMode = false;
	private pasteBuf = "";

	constructor(
		theme: ThemeLike,
		keybindings: KeybindingsManager,
		opts: TextPromptOptions,
		done: (value: string | undefined) => void,
	) {
		super();
		this.theme = theme;
		this.kb = keybindings;
		this.done = done;
		this.startValue = opts.startValue ?? "";
		this.addChild(new BorderLine(theme));
		this.addChild(new Text(theme.fg("accent", opts.title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", opts.hint ?? "TAB skips (keeps current) · Enter confirms · Esc cancels"), 1, 0));
		this.input.setValue(this.startValue);
	}

	/** Focusable — propagate to the inner Input (IME cursor). */
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Current input value (exposed for tests). */
	getValue(): string {
		return this.input.getValue();
	}

	handleInput(keyData: string): void {
		if (this.kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.done(this.input.getValue());
			return;
		}
		if (this.kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		// TAB = skip: keep the ORIGINAL value (discards any typed edits) and move
		// on — re-running /ch-setup with everything already answered becomes a
		// TAB-through. (PathInputComponent keeps TAB for completions.)
		if (this.kb.matches(keyData, "tui.input.tab") || keyData === "\t") {
			this.done(this.startValue);
			return;
		}
		// Prefill ergonomics (pi-tui Input has no select-all/cursor-end API and
		// setValue leaves the cursor at 0): while the default is untouched, the
		// first printable input REPLACES it (type-to-replace); backspace clears.
		// "Printable" is decided AFTER terminal decoding — kitty CSI-u
		// ("\x1b[97u"), plain Unicode and bracketed paste are all typing; cursor
		// movement and editing keys mark the prefill as touched and fall through.
		if (this.pristine && this.startValue) {
			const kitty = decodeKittyPrintable(keyData);
			if (kitty === "\x7f" || keyData === "\b" || keyData === "\x7f") {
				this.typed = "";
				this.input.setValue("");
				this.pristine = false;
				return;
			}
			// Bracketed paste while pristine: capture the WHOLE paste (it may
			// arrive across several chunks) and replace the prefill with it —
			// Input's own paste buffering would insert at cursor 0 instead.
			if (keyData.includes("\x1b[200~")) {
				this.pasteMode = true;
				this.pasteBuf = keyData.replace("\x1b[200~", "");
				this.flushPaste();
				return;
			}
			if (this.pasteMode) {
				this.pasteBuf += keyData;
				this.flushPaste();
				return;
			}
			const hasControlChars = [...keyData].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			const plain = kitty !== undefined || (keyData !== "" && !hasControlChars);
			if (plain) {
				this.typed += kitty ?? keyData;
				this.input.setValue(this.typed);
				return;
			}
			this.pristine = false;
		}
		this.input.handleInput(keyData);
	}

	/** Complete a pending paste: replace the prefill with its content. */
	private flushPaste(): void {
		const end = this.pasteBuf.indexOf("\x1b[201~");
		if (end === -1) return;
		const content = this.pasteBuf.slice(0, end);
		const remaining = this.pasteBuf.slice(end + 6); // 6 = length of \x1b[201~
		this.pasteMode = false;
		this.pasteBuf = "";
		if (content) {
			this.typed = content;
			this.input.setValue(content);
		}
		if (remaining) this.handleInput(remaining);
	}
}

/** Full-width border line (dialog chrome, like the built-in input dialog). */
class BorderLine implements Component {
	constructor(private readonly theme: ThemeLike) {}
	render(width: number): string[] {
		return [this.theme.fg("border", "─".repeat(Math.max(1, width)))];
	}
	invalidate(): void {}
}

export class PathInputComponent extends Container {
	private readonly input = new Input();
	private readonly tui: TUI;
	private readonly theme: ThemeLike;
	private readonly kb: KeybindingsManager;
	private readonly done: (value: string | undefined) => void;
	private readonly opts: PathInputOptions;
	private readonly hint: Text;
	private completions: CompletionItem[] = [];
	/** Currently selected completion (the ▸ row; navigation mirrors it into the field, TAB drills into it). */
	private selectedIndex = 0;
	/** First row of the viewport window (index into completions). */
	private scrollOffset = 0;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: ThemeLike,
		keybindings: KeybindingsManager,
		opts: PathInputOptions,
		done: (value: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.kb = keybindings;
		this.opts = opts;
		this.done = done;
		this.addChild(new BorderLine(theme));
		this.addChild(new Text(theme.fg("accent", opts.title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.hint = new Text("", 1, 0);
		this.addChild(this.hint);
		// Completions + bottom border are appended by refresh() (which keeps the
		// bottom border as the LAST child, after the live list).
		this.input.setValue(opts.startValue ?? "");
		caretToEnd(this.input);
		this.refresh();
	}

	/** Focusable — propagate to the inner Input (IME cursor). */
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Current input value (exposed for tests). */
	getValue(): string {
		return this.input.getValue();
	}

	/** Completions for the current value (exposed for tests). */
	currentCompletions(): CompletionItem[] {
		return [...this.completions];
	}

	handleInput(keyData: string): void {
		// ↑/↓ (and PgUp/PgDn) navigate the ▸ row; with an empty list they fall
		// through to the Input (inert there). Navigation does NOT re-filter the
		// list from the field — the list stays the current directory snapshot;
		// only typing or TAB (drill-down) recompute it.
		const down = this.kb.matches(keyData, "tui.select.down");
		const up = this.kb.matches(keyData, "tui.select.up");
		if (down || up) {
			if (this.completions.length > 0) this.moveSelection(down ? 1 : -1);
			return;
		}
		const pageDown = this.kb.matches(keyData, "tui.select.pageDown");
		const pageUp = this.kb.matches(keyData, "tui.select.pageUp");
		if (pageDown || pageUp) {
			if (this.completions.length > 0) this.moveSelection(pageDown ? MAX_VISIBLE : -MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// Enter always confirms what the field shows. ↑/↓/PgUp/PgDn mirror
			// the ▸ row into the field, so after navigating they agree; without
			// navigation Enter confirms the typed/prefilled value.
			this.done(this.input.getValue());
			return;
		}
		if (this.kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.kb.matches(keyData, "tui.input.tab") || keyData === "\t") {
			if (this.completions.length > 0) this.accept(this.selectedIndex);
			return;
		}
		// Anything else goes to the field editor. The completion snapshot
		// survives caret-only moves (←/→/Home/End — value unchanged): only a
		// real value change resets the selection + scroll and recomputes the
		// list from the edited value.
		const before = this.input.getValue();
		this.input.handleInput(keyData);
		if (this.input.getValue() !== before) {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			this.refresh();
		}
	}

	/**
	 * Move the ▸ row by `delta` (clamped at the ends — no wrap) and mirror the
	 * highlighted entry into the field. Mirroring even when the index did not
	 * move (single-row list / at an edge) makes Enter-after-↓ always commit the
	 * highlighted row, never stale field text.
	 */
	private moveSelection(delta: number): void {
		const last = this.completions.length - 1;
		this.selectedIndex = Math.min(last, Math.max(0, this.selectedIndex + delta));
		const item = this.completions[this.selectedIndex];
		if (item) {
			this.input.setValue(item.value);
			caretToEnd(this.input);
		}
		this.renderList();
	}

	/** Whole-value replace with the selected completion (drill-down, like pi's applyCompletion). */
	private accept(index: number): void {
		const item = this.completions[index];
		if (!item) return;
		this.input.setValue(item.value);
		caretToEnd(this.input);
		this.selectedIndex = 0;
		this.scrollOffset = 0;
		this.refresh();
	}

	/** Recompute the completion model from the field value (full list, no cap). */
	private refresh(): void {
		this.completions = dirCompletions(this.input.getValue(), this.opts.cwd, {
			includeFiles: this.opts.includeFiles,
			paramLabel: this.opts.paramLabel,
			// The dialog must not truncate: the 12-row cap is a VIEWPORT (see
			// renderList) — entries beyond it stay reachable via ↑/↓ + PgUp/PgDn.
			limit: Number.POSITIVE_INFINITY,
		});
		// Keep the selection valid when the list shrank (e.g. typing narrowed it).
		if (this.selectedIndex >= this.completions.length) this.selectedIndex = 0;
		this.renderList();
	}

	/** Rebuild the visible rows (12-row scroll window) + hint + bottom border. */
	private renderList(): void {
		// Drop the old completion lines AND the old bottom border (both live
		// after FIXED_CHILDREN), then rebuild window + bottom border.
		while (this.children.length > FIXED_CHILDREN) this.removeChild(this.children[this.children.length - 1]!);
		// Keep the ▸ row inside the window.
		if (this.completions.length <= MAX_VISIBLE) {
			this.scrollOffset = 0;
		} else if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + MAX_VISIBLE) {
			this.scrollOffset = this.selectedIndex - MAX_VISIBLE + 1;
		}
		const window = this.completions.slice(this.scrollOffset, this.scrollOffset + MAX_VISIBLE);
		window.forEach((c, i) => {
			const marker = this.scrollOffset + i === this.selectedIndex ? this.theme.fg("accent", "▸") : " ";
			this.addChild(new Text(`${marker} ${c.label}`, 1, 0));
		});
		this.addChild(new BorderLine(this.theme));
		const nav =
			this.completions.length > MAX_VISIBLE ? "↑/↓ scroll · PgUp/PgDn page" : "↑/↓ move";
		const selected = this.completions[this.selectedIndex];
		const tabWord = selected && !selected.value.endsWith("/") ? "TAB fills" : "TAB drills in";
		this.hint.setText(
			this.completions.length > 0
				? this.theme.fg(
						"dim",
						`▸ ${this.completions[this.selectedIndex]!.label.replace(/\/+$/, "")} · ${nav} · ${tabWord} · Enter confirms · Esc cancels`,
					)
				: this.theme.fg("dim", "Enter confirms · Esc cancels"),
		);
		this.tui.requestRender();
	}
}
