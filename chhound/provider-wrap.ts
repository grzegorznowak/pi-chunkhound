import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { worktreeArgumentCompletions } from "./completions.js";

/**
 * Commands whose argument position is owned by the plugin's completions.
 * (Only /chworktree registers argument completions today.)
 */
const COMMAND_RE = /^\/chworktree /u;

/**
 * Wraps pi's built-in autocomplete provider so that requests in the argument
 * position of the plugin's commands resolve through the plugin's own argument
 * completions — including TAB (force=true), which on pristine pi opens its
 * built-in file picker instead.
 *
 * Everything outside the plugin's command-argument context is delegated to
 * the wrapped provider untouched. Registered via ctx.ui.addAutocompleteProvider
 * on session_start: pi resets all provider wrappers on /reload, so
 * re-registering there is safe and self-healing.
 */
export class ChhoundArgumentProvider implements AutocompleteProvider {
	constructor(private readonly inner: AutocompleteProvider) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = COMMAND_RE.exec(textBeforeCursor);
		if (match) {
			const argumentText = textBeforeCursor.slice(match[0].length);
			const items = await worktreeArgumentCompletions(argumentText, process.cwd());
			if (items.length === 0) return null;
			return { items, prefix: argumentText };
		}
		return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		// pi's applyCompletion replaces the whole argument text with item.value
		// (values carry the typed base), so the inner provider's logic applies.
		return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}
