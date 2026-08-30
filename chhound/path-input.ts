import { Container, Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { dirCompletions, type CompletionItem } from "./completions.js";

/**
 * Plugin-owned text input with the command-line dir-picker completion
 * mechanism: same dirCompletions rules — dirs only, trailing "/", ~
 * expansion, drill-down — TAB accepts the first item (whole-value replace,
 * like pi's applyCompletion), Enter confirms, Esc cancels.
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

const MAX_VISIBLE = 12;
/** Children before the completion list: border, title, spacer, input, spacer, hint. */
const FIXED_CHILDREN = 6;

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
		if (this.kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.done(this.input.getValue());
			return;
		}
		if (this.kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.kb.matches(keyData, "tui.input.tab") || keyData === "\t") {
			if (this.completions.length > 0) {
				this.input.setValue(this.completions[0]!.value);
				this.refresh();
			}
			return;
		}
		this.input.handleInput(keyData);
		this.refresh();
	}

	private refresh(): void {
		this.completions = dirCompletions(this.input.getValue(), this.opts.cwd, {
			includeFiles: this.opts.includeFiles,
			paramLabel: this.opts.paramLabel,
			limit: MAX_VISIBLE,
		});
		// Drop the old completion lines AND the old bottom border (both live
		// after FIXED_CHILDREN), then rebuild list + bottom border.
		while (this.children.length > FIXED_CHILDREN) this.removeChild(this.children[this.children.length - 1]!);
		this.completions.forEach((c, i) => {
			const marker = i === 0 ? this.theme.fg("accent", "▸") : " ";
			this.addChild(new Text(`${marker} ${c.label}`, 1, 0));
		});
		this.addChild(new BorderLine(this.theme));
		this.hint.setText(
			this.completions.length > 0
				? this.theme.fg(
						"dim",
						`TAB accepts ${this.completions[0]!.label.replace(/\/+$/, "")} · Enter confirms · Esc cancels`,
					)
				: this.theme.fg("dim", "Enter confirms · Esc cancels"),
		);
		this.tui.requestRender();
	}
}
