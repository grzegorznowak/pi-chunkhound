import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepoRoot, gitRootOrNull, runGit } from "./git.js";
import { listSandboxes } from "./sandbox.js";
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
 */
export function dirCompletions(
	rawPrefix: string,
	cwd: string,
	opts: { includeFiles?: boolean; limit?: number; paramLabel?: string } = {},
): CompletionItem[] {
	const { includeFiles = false, limit = 50 } = opts;
	const trimmed = rawPrefix.trim();

	let baseDisplay: string;
	let nameFilter: string;
	if (trimmed === "~") {
		baseDisplay = "~/";
		nameFilter = "";
	} else if (trimmed.startsWith("~/")) {
		baseDisplay = "~/";
		nameFilter = trimmed.slice(2);
	} else {
		const lastSlash = trimmed.lastIndexOf("/");
		if (lastSlash === -1) {
			baseDisplay = "";
			nameFilter = trimmed;
		} else {
			baseDisplay = trimmed.slice(0, lastSlash + 1);
			nameFilter = trimmed.slice(lastSlash + 1);
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

	const out: CompletionItem[] = [];
	for (const name of names) {
		if (out.length >= limit) break;
		if (name.startsWith(".")) continue; // skip dotfiles, like pi's picker
		if (!name.startsWith(nameFilter)) continue;
		let isDir = false;
		try {
			isDir = fs.statSync(path.join(baseDir, name)).isDirectory();
		} catch {
			continue;
		}
		if (!isDir && !includeFiles) continue;
		const desc = isDir ? opts.paramLabel : "file";
		out.push({
			value: baseDisplay + name + (isDir ? "/" : ""),
			label: name + (isDir ? "/" : ""),
			...(desc ? { description: desc } : {}),
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

/**
 * Repo to complete branches from: the cwd's repo, or — when cwd is not inside
 * one — the nearest repo ancestor of the first positional (path) argument.
 */
async function resolveRepoForCompletions(cwd: string, tokens: string[]): Promise<string | null> {
	const fromCwd = await gitRootOrNull(cwd);
	if (fromCwd) return fromCwd;
	const first = tokens.find((t) => t && !t.startsWith("-"));
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
 */
export async function mcpArgumentCompletions(argumentPrefix: string, cwd: string): Promise<CompletionItem[]> {
	const raw = argumentPrefix;
	const tokens = raw.split(/[ \t]+/);
	const current = tokens.length > 0 ? tokens[tokens.length - 1]! : "";
	const base = raw.slice(0, raw.length - current.length);
	const withBase = (items: CompletionItem[]): CompletionItem[] => items.map((i) => ({ ...i, value: base + i.value }));

	if (current.startsWith("-")) {
		return withBase(
			MCP_FLAGS.filter((f) => f.startsWith(current)).map((f) => ({ value: f, label: f, description: "" })),
		);
	}

	// Item values REPLACE the whole argument text (pi-tui applyCompletion), so
	// they are full paths; typed fragments match against the last path segment
	// (no slash typed) or the path itself (slash typed).
	const matchesPath = (v: string): boolean =>
		current === "" || v.startsWith(current) || (!current.includes("/") && path.basename(v).startsWith(current));

	const repoRoot = await gitRootOrNull(cwd);
	const settings = loadSettings(repoRoot ?? cwd).settings;
	const items: CompletionItem[] = [];
	for (const e of listSandboxes(settings)) {
		const wt = e.meta.worktree;
		if (matchesPath(wt)) {
			items.push({
				value: wt,
				label: path.basename(wt),
				description: `sandbox ${path.basename(e.dir)} · ${e.meta.branch}`,
			});
		}
		const name = path.basename(e.dir);
		if (name !== path.basename(wt) && name.startsWith(current)) {
			items.push({ value: name, label: name, description: wt });
		}
	}
	return items.slice(0, 50);
}

/**
 * /chworktree argument completions (natural typing AND TAB — the plugin's
 * ChhoundArgumentProvider wrapper routes every request in this command's
 * argument position here, so pristine pi's file picker never shows there;
 * TAB-without-space stays command-name completion — a pi-tui behavior).
 *
 * pi's applyCompletion for command args REPLACES the whole argument string
 * with item.value, so every value carries the typed base (e.g. "wt fix-topic").
 */
export async function worktreeArgumentCompletions(argumentPrefix: string, cwd: string): Promise<CompletionItem[]> {
	const raw = argumentPrefix;
	const tokens = raw.split(/[ \t]+/);
	const nonEmpty = tokens.filter((t) => t.length > 0);
	const current = tokens.length > 0 ? tokens[tokens.length - 1]! : "";
	const hasTrailingSpace = current === "";
	const prev = nonEmpty.length >= 2 ? nonEmpty[nonEmpty.length - 2] : undefined;
	// Everything up to and including the space before the token being completed.
	const base = raw.slice(0, raw.length - current.length);
	const withBase = (items: CompletionItem[]): CompletionItem[] => items.map((i) => ({ ...i, value: base + i.value }));
	const repo = await resolveRepoForCompletions(cwd, nonEmpty);
	const position = nonEmpty.length - (hasTrailingSpace ? 0 : 1);

	// Flag value positions — the flag may be the LAST token (trailing space:
	// "/chworktree wt -b ") or second-to-last ("/chworktree wt -b name").
	const valueFlag = hasTrailingSpace ? nonEmpty[nonEmpty.length - 1] : prev;
	if (valueFlag === "--config") return withBase(dirCompletions(current, cwd, { includeFiles: true, paramLabel: "config file (optional)" }));
	if (valueFlag === "--dest") return withBase(dirCompletions(current, cwd, { paramLabel: "worktree base folder (branch-named)" }));
	// -b takes a NEW branch name — free typing, no existing-branch suggestions
	// (git refuses -b with a name that already exists).
	if (valueFlag === "-b") return [];
	if (valueFlag === "--from") return repo ? withBase(await branchCompletions(repo, true)) : [];

	// Flag name position ("wt --f" → "wt --force-reindex")
	if (!hasTrailingSpace && current.startsWith("-")) {
		return withBase(WORKTREE_FLAGS.filter((f) => f.startsWith(current)).map((f) => ({ value: f, label: f })));
	}

	if (position <= 0) {
		// With --dest the first positional only resolves/names the repo — it is
		// optional (the cwd's repo is used when absent).
		const label = nonEmpty.includes("--dest") ? "repo directory (optional — cwd's repo is used)" : "worktree path (required)";
		return withBase(dirCompletions(current, cwd, { paramLabel: label }));
	}
	if (position === 1) {
		// No repo anywhere near cwd or the typed path → the command cannot run;
		// showing branch/new-branch items would advertise a dead end.
		if (!repo) return [];
		// NEW-BRANCH-FIRST: creating a new worktree is the primary intent — lead
		// with a create-new-branch item; existing branches are secondary.
		const branches = (await branchCompletions(repo)).filter((b) => !current || b.value.startsWith(current));
		const existing = new Set(branches.map((b) => b.value));
		const items: CompletionItem[] = [];
		if (current === "") {
			items.push({ value: "-b ", label: "new branch (-b)", description: "create a NEW branch — TAB, then type its name" });
		} else if (!existing.has(current)) {
			items.push({ value: `-b ${current}`, label: `create branch: ${current}`, description: "this branch doesn't exist yet — git creates it" });
		}
		for (const b of branches) items.push({ ...b, description: `existing ${b.description} branch — check out` });
		return withBase(items);
	}
	return withBase(WORKTREE_FLAGS.map((f) => ({ value: f, label: f })));
}
