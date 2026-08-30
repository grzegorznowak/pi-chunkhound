import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git.js";

/** Structural match for pi-tui's AutocompleteItem (avoids a pi-tui type import). */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

function expandHome(p: string): string {
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
	opts: { includeFiles?: boolean; limit?: number } = {},
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
		out.push({
			value: baseDisplay + name + (isDir ? "/" : ""),
			label: name + (isDir ? "/" : ""),
			...(isDir ? {} : { description: "file" }),
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
	"--from",
	"-b",
] as const;

/**
 * /chworktree argument completions (natural typing; TAB stays with pi's own
 * fd-based file picker, which is what makes the folder picker feel native).
 */
export async function worktreeArgumentCompletions(argumentPrefix: string, cwd: string): Promise<CompletionItem[]> {
	const tokens = argumentPrefix.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		// Fresh "/chworktree " — offer the cwd's directories.
		return dirCompletions("", cwd);
	}
	const current = tokens[tokens.length - 1]!;
	const prev = tokens.length >= 2 ? tokens[tokens.length - 2] : undefined;

	if (prev === "--config") return dirCompletions(current, cwd, { includeFiles: true });
	if (prev === "-b") return branchCompletions(cwd, false);
	if (prev === "--from") return branchCompletions(cwd, true);

	if (current.startsWith("-") && !prev) {
		return WORKTREE_FLAGS.filter((f) => f.startsWith(current)).map((f) => ({ value: f, label: f }));
	}

	if (tokens.length === 1) return dirCompletions(current, cwd);
	if (tokens.length === 2) return branchCompletions(cwd);
	return [];
}
