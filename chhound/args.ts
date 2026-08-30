/** Minimal command-line arg parser for /ch-* command args. */

export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, string | true>;
}

function unquote(t: string): string {
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
		return t.slice(1, -1);
	}
	return t;
}

export function parseArgs(input: string): ParsedArgs {
	const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	const flags: Record<string, string | true> = {};
	const positionals: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			if (eq !== -1) {
				flags[t.slice(2, eq)] = unquote(t.slice(eq + 1));
			} else {
				const next = tokens[i + 1];
				if (next !== undefined && !next.startsWith("-")) {
					flags[t.slice(2)] = unquote(next);
					i++;
				} else {
					flags[t.slice(2)] = true;
				}
			}
		} else if (t.startsWith("-") && t.length > 1 && !/^-\d/.test(t)) {
			// Short flag: consume the next token as its value when present (e.g. -b name).
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				flags[t.slice(1)] = unquote(next);
				i++;
			} else {
				flags[t.slice(1)] = true;
			}
		} else {
			positionals.push(unquote(t));
		}
	}
	return { positionals, flags };
}
