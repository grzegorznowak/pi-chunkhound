import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenizeArgs, WORKTREE_VALUE_FLAGS, MCP_VALUE_FLAGS } from "./args.js";
import { findRepoRoot, gitRootOrNull, runGit } from "./git.js";
import { listSandboxes, sandboxBranchLabel } from "./sandbox.js";
import { loadSettings } from "./settings.js";

/** Structural match for pi-tui's AutocompleteItem (avoids a pi-tui type import). */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Directory-oriented completion for the worktree path argument.
 * The returned `value` replaces the WHOLE argument text (pi's applyCompletion
 * for command args), so it always carries the typed base + the chosen entry.
 * Directories get a trailing "/" so the user can keep navigating.
 *
 * `quote: true` (command line): values with whitespace — or typed inside
 * quotes — are wrapped in quotes so the line survives parseArgs; quotes stay
 * OPEN on directories (drill-down keeps working) and close on files.
 */
export function dirCompletions(
	rawPrefix: string,
	cwd: string,
	opts: { includeFiles?: boolean; limit?: number; paramLabel?: string; quote?: boolean } = {},
): CompletionItem[] {
	const { includeFiles = false, limit = 50, quote = false } = opts;
	const trimmed = rawPrefix.trim();

	// Quote context: the user is typing INSIDE quotes — completion stays
	// inside them (values keep the opening quote).
	let quoteChar: string | null = null;
	let visible = trimmed;
	if (quote && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
		quoteChar = trimmed[0]!;
		visible = trimmed.slice(1);
	}

	let baseDisplay: string;
	let nameFilter: string;
	if (visible === "~") {
		baseDisplay = "~/";
		nameFilter = "";
	} else if (visible.startsWith("~/")) {
		baseDisplay = "~/";
		nameFilter = visible.slice(2);
	} else {
		const lastSlash = visible.lastIndexOf("/");
		if (lastSlash === -1) {
			baseDisplay = "";
			nameFilter = visible;
		} else {
			baseDisplay = visible.slice(0, lastSlash + 1);
			nameFilter = visible.slice(lastSlash + 1);
		}
	}

	const expandedBase = expandHome(baseDisplay || ".");
	const baseDir = path.isAbsolute(expandedBase) ? expandedBase : path.join(cwd, expandedBase);
	let names: string[];
	try {
		names = fs.readdirSync(baseDir);
	} catch {
		return [];
	}

	// Deterministic order — dirs first, then name. (The dialog's TAB accepts
	// items[0]; filesystem enumeration order must not decide the pick.)
	const entries: { name: string; isDir: boolean }[] = [];
	for (const name of names) {
		if (name.startsWith(".")) continue; // skip dotfiles, like pi's picker
		if (!name.startsWith(nameFilter)) continue;
		let isDir = false;
		try {
			isDir = fs.statSync(path.join(baseDir, name)).isDirectory();
		} catch {
			continue;
		}
		if (!isDir && !includeFiles) continue;
		entries.push({ name, isDir });
	}
	entries.sort((a, b) => (a.isDir === b.isDir ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDir ? -1 : 1));

	const out: CompletionItem[] = [];
	for (const { name, isDir } of entries) {
		if (out.length >= limit) break;
		const entry = baseDisplay + name;
		// Command-line values must survive parseArgs: quote entries containing
		// whitespace (a path with a space would otherwise split into two
		// positionals). Embedded `"` inside such entries is unsupported.
		let value: string;
		if (quoteChar) {
			value = isDir ? `${quoteChar}${entry}/` : `${quoteChar}${entry}${quoteChar}`;
		} else if (quote && /\s/.test(entry)) {
			value = isDir ? `"${entry}/` : `"${entry}"`;
		} else {
			value = entry + (isDir ? "/" : "");
		}
		const description = isDir ? opts.paramLabel : "file";
		out.push({
			value,
			label: name + (isDir ? "/" : ""),
			...(description ? { description } : {}),
		});
	}
	return out;
}

/** Git branch (and optionally tag) completions — value replaces the whole arg. */
export async function branchCompletions(cwd: string, includeTags = false): Promise<CompletionItem[]> {
	const refs = includeTags ? ["refs/heads", "refs/remotes", "refs/tags"] : ["refs/heads", "refs/remotes"];
	const r = await runGit(["for-each-ref", "--format=%(refname:short)", ...refs], { cwd });
	if (r.code !== 0) return [];
	return r.stdout
		.split("\n")
		.filter((b) => b && b !== "HEAD")
		.map((b) => ({
			value: b,
			label: b,
			description: b.includes("/") ? "remote" : includeTags && b.includes("/") ? "remote/tag" : "local",
		}));
}

/** Known /chworktree flags for flag-position completion. */
export const WORKTREE_FLAGS = [
	"--no-index",
	"--force-reindex",
	"--refresh-baseline",
	"--config",
	"--dest",
	"--from",
	"-b",
] as const;

/** /chworktree flags that take a value (space form AND `--flag=value` form). */
// (Set lives in args.ts as WORKTREE_VALUE_FLAGS — parser configuration.)

/**
 * Repo to complete branches from: the cwd's repo, or — when cwd is not inside
 * one — the nearest repo ancestor of the first positional (path) argument.
 */
async function resolveRepoForCompletions(cwd: string, positionals: string[]): Promise<string | null> {
	const fromCwd = await gitRootOrNull(cwd);
	if (fromCwd) return fromCwd;
	const first = positionals.find((p) => p.length > 0);
	if (first) {
		const p = path.resolve(cwd, first);
		const probe = fs.existsSync(p) ? p : path.dirname(p);
		const found = await findRepoRoot(probe);
		if (found) return found;
	}
	return null; // no repo anywhere — the command cannot run; show no branch items
}

/** Known /ch-mcp flags for flag-position completion. */
export const MCP_FLAGS = ["--disconnect", "--no-daemon", "--read-only", "--prefix"] as const;

/**
 * /ch-mcp argument completions: sandbox worktrees + sandbox dir names
 * (and the flag set when the current token starts with "-").
 *
 * The grammar has ONE positional (the target); everything after it is flags.
 * Values carry the typed base (pi replaces the WHOLE argument text with
 * item.value), and paths with whitespace are quoted.
 */
export async function mcpArgumentCompletions(argumentPrefix: string, cwd: string): Promise<CompletionItem[]> {
	const raw = argumentPrefix;
	const tokens = tokenizeArgs(raw, MCP_VALUE_FLAGS);
	const trailingSpace = /\s$/.test(raw) || raw === "";
	const current = !trailingSpace && tokens.length > 0 ? tokens[tokens.length - 1]! : null;
	const base = current ? raw.slice(0, current.start) : raw;
	const withBase = (items: CompletionItem[]): CompletionItem[] => items.map((i) => ({ ...i, value: base + i.value }));
	// Completed tokens (everything except the in-progress one).
	const done = current ? tokens.slice(0, -1) : tokens;
	const positionals = done.filter((t) => t.kind === "positional");
	const quote = (v: string): string => (/\s/.test(v) ? `"${v}"` : v);

	// The only /ch-mcp value flag: --prefix <pfx> (free typing).
	const lastIsPrefixValueSlot =
		done.length > 0 && done[done.length - 1]!.kind === "flag" && done[done.length - 1]!.flagName === "prefix";

	if (current && current.text === "--") {
		// Typing the separator itself → full flag set.
		return withBase(MCP_FLAGS.map((f) => ({ value: f, label: f })));
	}
	if (current && current.kind === "flag") {
		if (current.text.includes("=")) return []; // --prefix=… (or any --flag=…) is free typing
		const matches = MCP_FLAGS.filter((f) => f.startsWith(current.text));
		if (matches.length > 0) return withBase(matches.map((f) => ({ value: f, label: f })));
		return []; // unknown "-…" token — sandbox names never start with "-"
	}
	if (current && current.kind === "value") return [];
	if (trailingSpace && lastIsPrefixValueSlot) return [];
	// Target already given → only flags remain.
	if (positionals.length > 0) return [];

	// Item values REPLACE the whole argument text (pi-tui applyCompletion), so
	// they are full paths; typed fragments match against the last path segment
	// (no slash typed) or the path itself (slash typed).
	const cur = current ? current.unquoted : "";
	const matchesPath = (v: string): boolean => cur === "" || v.startsWith(cur) || (!cur.includes("/") && path.basename(v).startsWith(cur));

	const repoRoot = await gitRootOrNull(cwd);
	const settings = loadSettings(repoRoot ?? cwd).settings;
	const items: CompletionItem[] = [];
	for (const e of listSandboxes(settings)) {
		const wt = e.meta.worktree;
		if (matchesPath(wt)) {
			items.push({
				value: quote(wt),
				label: path.basename(wt),
				description: `storage ID ${path.basename(e.dir)} · ${sandboxBranchLabel(e.meta)}`,
			});
		}
		const name = path.basename(e.dir);
		if (name !== path.basename(wt) && name.startsWith(cur)) {
			items.push({ value: name, label: name, description: wt });
		}
	}
	return withBase(items.slice(0, 50));
}

/**
 * /chworktree argument completions (natural typing AND TAB — the plugin's
 * ChhoundArgumentProvider wrapper routes every request in this command's
 * argument position here, so pristine pi's file picker never shows there;
 * TAB-without-space stays command-name completion — a pi-tui behavior).
 *
 * pi's applyCompletion for command args REPLACES the whole argument string
 * with item.value, so every value carries the typed base (e.g. "wt fix-topic").
 *
 * Slot determination reuses the runtime parser's token classification
 * (tokenizeArgs), so flags anywhere — before, between or after positionals —
 * never shift the positional slots, `--flag=value` forms complete, and a
 * "-…" token that matches no known flag is treated as a dash-named path.
 */
export async function worktreeArgumentCompletions(argumentPrefix: string, cwd: string): Promise<CompletionItem[]> {
	const raw = argumentPrefix;
	const tokens = tokenizeArgs(raw, WORKTREE_VALUE_FLAGS);
	const trailingSpace = /\s$/.test(raw) || raw === "";
	const current = !trailingSpace && tokens.length > 0 ? tokens[tokens.length - 1]! : null;
	const base = current ? raw.slice(0, current.start) : raw;
	const withBase = (items: CompletionItem[]): CompletionItem[] => items.map((i) => ({ ...i, value: base + i.value }));
	// Completed tokens (everything except the in-progress one).
	const done = current ? tokens.slice(0, -1) : tokens;
	const positionals = done.filter((t) => t.kind === "positional").map((t) => t.unquoted);
	const flags = done.filter((t) => t.kind === "flag");
	const repo = await resolveRepoForCompletions(cwd, positionals);
	// The last completed flag without a value (space form) expects it next —
	// but only when it is a KNOWN value flag; a trailing boolean flag
	// ("wt --no-index ") just ends the flags and the next slot is positional.
	const lastNeedsValue =
		done.length > 0 &&
		done[done.length - 1]!.kind === "flag" &&
		done[done.length - 1]!.value === undefined &&
		WORKTREE_VALUE_FLAGS.has(done[done.length - 1]!.flagName!)
			? done[done.length - 1]!.flagName!
			: null;

	// Value slots: space form ("--dest src") and equals form ("--dest=src").
	// prefix is the "--flag=" text for the equals form ("" for the space form
	// — the flag token already sits in base).
	const flagValueCompletions = async (
		flagName: string,
		rawValuePart: string,
		unquotedValuePart: string,
		prefix: string,
	): Promise<CompletionItem[]> => {
		switch (flagName) {
			case "config":
				return withBase(
					dirCompletions(rawValuePart, cwd, { includeFiles: true, quote: true, paramLabel: "config file (optional)" }).map((i) => ({
						...i,
						value: prefix + i.value,
					})),
				);
			case "dest":
				return withBase(
					dirCompletions(rawValuePart, cwd, { quote: true, paramLabel: "worktree library root (worktrees + indexes land there)" }).map((i) => ({
						...i,
						value: prefix + i.value,
					})),
				);
			// -b takes a NEW branch name — free typing, no existing-branch
			// suggestions (git refuses -b with a name that already exists).
			case "b":
				return [];
			case "from": {
				if (!repo) return [];
				return withBase(
					(await branchCompletions(repo, true))
						.filter((b) => b.value.startsWith(unquotedValuePart))
						.map((i) => ({ ...i, value: prefix + i.value })),
				);
			}
			default:
				return [];
		}
	};

	// Positional slots: 0 = repo/path, 1 = branch, ≥2 = nothing more to type.
	const positionalCompletions = async (n: number): Promise<CompletionItem[]> => {
		if (n === 0) {
			const label = flags.some((f) => f.flagName === "dest")
				? "repo directory (optional — cwd's repo is used)"
				: "worktree path (required)";
			return withBase(dirCompletions(current ? current.unquoted : "", cwd, { quote: true, paramLabel: label }));
		}
		if (n === 1) {
			// No repo anywhere near cwd or the typed path → the command cannot
			// run; showing branch/new-branch items would advertise a dead end.
			if (!repo) return [];
			const currentName = current ? current.unquoted : "";
			// NEW-BRANCH-FIRST: creating a new worktree is the primary intent —
			// lead with a create-new-branch item; existing branches are secondary.
			const branches = (await branchCompletions(repo)).filter((b) => !currentName || b.value.startsWith(currentName));
			const existing = new Set(branches.map((b) => b.value));
			const items: CompletionItem[] = [];
			if (currentName === "") {
				items.push({ value: "-b ", label: "new branch (-b)", description: "create a NEW branch — TAB, then type its name" });
			} else if (!existing.has(currentName)) {
				items.push({ value: `-b ${currentName}`, label: `create branch: ${currentName}`, description: "this branch doesn't exist yet — git creates it" });
			}
			for (const b of branches) items.push({ ...b, description: `existing ${b.description} branch — check out` });
			return withBase(items);
		}
		// Two positionals is the grammar limit — only flags remain; offer them
		// after a trailing space, and never while a word is being typed.
		if (trailingSpace) return withBase(WORKTREE_FLAGS.map((f) => ({ value: f, label: f })));
		return [];
	};

	if (trailingSpace) {
		if (lastNeedsValue) return flagValueCompletions(lastNeedsValue, "", "", "");
		return positionalCompletions(positionals.length);
	}
	// Non-trailing input always ends in an in-progress token (raw !== "").
	if (!current) return positionalCompletions(positionals.length);

	// Typing inside the current token.
	if (current.kind === "separator" && current.text === "--") {
		// Typing the end-of-flags separator itself → full flag set.
		return withBase(WORKTREE_FLAGS.map((f) => ({ value: f, label: f })));
	}
	if (current.kind === "value") {
		return flagValueCompletions(current.flagFor!, current.text, current.unquoted, "");
	}
	if (current.kind === "flag") {
		const eq = current.text.indexOf("=");
		if (eq !== -1) {
			// --flag=<value> in progress (parseArgs supports the equals form).
			return flagValueCompletions(current.flagName!, current.text.slice(eq + 1), current.value ?? "", current.text.slice(0, eq + 1));
		}
		// Flag-name position — but ONLY when the typed prefix matches a known
		// flag; an unmatched "-…" token is a positional (a path starting with
		// "-", e.g. "-target") and must not be swallowed by flag completion.
		const matches = WORKTREE_FLAGS.filter((f) => f.startsWith(current.text));
		if (matches.length > 0) {
			return withBase(matches.map((f) => ({ value: f, label: f })));
		}
		// Dash-named path: only the first positional (repo path) can be one;
		// completed values get "-- " so the runtime parser treats them as
		// positionals, not flags.
		if (positionals.length === 0) {
			const items = dirCompletions(current.unquoted, cwd, { quote: true, paramLabel: "worktree path (required)" });
			if (items.length === 0) return [];
			const needSeparator = !done.some((t) => t.kind === "separator");
			return withBase(items.map((i) => ({ ...i, value: (needSeparator ? "-- " : "") + i.value })));
		}
		return [];
	}
	return positionalCompletions(positionals.length);
}
