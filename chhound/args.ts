/** Minimal command-line arg parser for /ch-* command args. */

export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, string | true>;
}

/**
 * One whitespace-separated token, classified the way the command parser sees
 * it. The completion engine uses the SAME classification so that flag
 * positions, flag values and positionals never drift from runtime parsing.
 */
export interface ArgToken {
	/** Raw token text (quote characters included). */
	text: string;
	/** Token text with surrounding quotes stripped. */
	unquoted: string;
	/** Offset of the token in the input string. */
	start: number;
	/** Offset just past the token in the input string. */
	end: number;
	kind: "positional" | "flag" | "value" | "separator";
	/** kind==="flag": flag name without dashes ("dest", "b", …). */
	flagName?: string;
	/** kind==="flag": inline `--flag=value` value, or the unquoted value
	 *  token consumed as this flag's value; undefined when the flag carries
	 *  no value (boolean flag). */
	value?: string;
	/** kind==="value": name of the flag this token is the value of. */
	flagFor?: string;
}

function unquote(t: string): string {
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	// Unterminated quote (the user is still typing): the opening quote is part
	// of the token, not of the value.
	if (t.startsWith('"') || t.startsWith("'")) return t.slice(1);
	return t;
}

/**
 * Value-taking flag schemas per command (parser configuration): a flag NOT in
 * its command's set is boolean and never consumes the token after it.
 */
export const WORKTREE_VALUE_FLAGS: ReadonlySet<string> = new Set(["config", "dest", "from", "b"]);
export const MCP_VALUE_FLAGS: ReadonlySet<string> = new Set(["prefix"]);

/**
 * Split `input` into classified tokens. Same grammar as parseArgs (the two
 * never drift): quoted segments (including unterminated quotes — the user may
 * still be typing) are single tokens; `--` ends flag parsing; `--flag=value`
 * carries an inline value.
 *
 * Without `valueFlags` a flag consumes the next non-dash token as its value
 * (legacy behavior). With `valueFlags` (the command's known value-taking
 * flags), only those flags consume — a boolean flag never eats the token
 * after it (e.g. `--no-index wt main` keeps `wt main` positional).
 */
export function tokenizeArgs(input: string, valueFlags?: ReadonlySet<string>): ArgToken[] {
	const rawTokens: { text: string; start: number }[] = [];
	for (const m of input.matchAll(/(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g)) {
		rawTokens.push({ text: m[0], start: m.index });
	}
	const tokens: ArgToken[] = [];
	let separatorSeen = false;
	const consumeValue = (token: ArgToken, i: number): number => {
		if (valueFlags !== undefined && !valueFlags.has(token.flagName!)) return i;
		const next = rawTokens[i + 1];
		if (next !== undefined && !next.text.startsWith("-")) {
			token.value = unquote(next.text);
			tokens.push({ text: next.text, unquoted: token.value, start: next.start, end: next.start + next.text.length, kind: "value", flagFor: token.flagName });
			return i + 1;
		}
		return i;
	};
	for (let i = 0; i < rawTokens.length; i++) {
		const { text, start } = rawTokens[i]!;
		const token: ArgToken = { text, unquoted: unquote(text), start, end: start + text.length, kind: "positional" };
		if (separatorSeen) {
			tokens.push(token);
			continue;
		}
		if (text === "--") {
			token.kind = "separator";
			separatorSeen = true;
			tokens.push(token);
			continue;
		}
		if (text.startsWith("--")) {
			token.kind = "flag";
			const eq = text.indexOf("=");
			token.flagName = eq !== -1 ? text.slice(2, eq) : text.slice(2);
			if (eq !== -1) {
				token.value = unquote(text.slice(eq + 1));
			} else {
				tokens.push(token);
				i = consumeValue(token, i);
				continue;
			}
			tokens.push(token);
			continue;
		}
		if (text.startsWith("-") && text.length > 1 && !/^-\d/.test(text)) {
			// Short flag: consume the next token as its value when present (e.g. -b name).
			token.kind = "flag";
			token.flagName = text.slice(1);
			tokens.push(token);
			i = consumeValue(token, i);
			continue;
		}
		tokens.push(token);
	}
	return tokens;
}

export function parseArgs(input: string, valueFlags?: ReadonlySet<string>): ParsedArgs {
	const flags: Record<string, string | true> = {};
	const positionals: string[] = [];
	for (const t of tokenizeArgs(input, valueFlags)) {
		if (t.kind === "flag") {
			flags[t.flagName!] = t.value ?? true;
		} else if (t.kind === "positional") {
			positionals.push(t.unquoted);
		}
	}
	return { positionals, flags };
}
