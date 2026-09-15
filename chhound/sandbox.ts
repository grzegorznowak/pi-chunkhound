import * as fs from "node:fs";
import path from "node:path";
import { sandboxRoot, shortHash, slugify } from "./paths.js";
import { CONFIG_FILE_NAME } from "./config.js";
import type { ChhoundSettings, SandboxMeta } from "./types.js";

/**
 * One managed pair of dirs per (repo, branch) under the sandbox library root:
 *
 *   <root>/<name>/           — sandbox dir = the daemon's project dir and the
 *                              INDEX ROOT (claimed by chunkhound). Holds ONLY
 *                              the worktree checkout <branch>/ + the material-
 *                              ized .chunkhound.json (name-excluded from
 *                              indexing) + the engine-pinned .chunkhound/ dir.
 *   <root>/.state/<name>/    — operational state OUTSIDE the indexed root:
 *                              .chhound.db (+ .root.json claim sidecar, .wal,
 *                              .compact_* followers) and meta.json. Nothing
 *                              in here is ever a scan candidate.
 *
 * The name is derived from repoRoot + branch ONLY — it must never depend on
 * the worktree path, which lives INSIDE the sandbox dir (circular other-
 * wise). The branch slug keeps the name readable; the hash over (repoRoot,
 * branch) makes it collision-free (e.g. `feature/foo` vs `feature-foo` both
 * slug to `feature-foo`). State dirs are derived from the RESOLVED sandbox
 * dir (never recomputed from settings) so --dest / env / XDG all hold.
 */
export function sandboxDirFor(repoRoot: string, branch: string, settings: ChhoundSettings): string {
	const name = `${slugify(path.basename(repoRoot))}-${slugify(branch)}-${shortHash(`${path.resolve(repoRoot)}\u0000${branch}`)}`;
	return path.join(sandboxRoot(settings), name);
}

/** Hidden sibling dir (`.state/<name>`) holding a sandbox's operational state — outside the index root. */
export const STATE_DIR_NAME = ".state";

export function sandboxStateDir(sandboxDir: string): string {
	return path.join(path.dirname(sandboxDir), STATE_DIR_NAME, path.basename(sandboxDir));
}

export function sandboxConfigPath(sandboxDir: string): string {
	return path.join(sandboxDir, CONFIG_FILE_NAME);
}

/** The engine duckdb lives in the state dir — NOT under the indexed root. */
export function sandboxDbDir(sandboxDir: string): string {
	return path.join(sandboxStateDir(sandboxDir), ".chhound.db");
}

function metaPath(dir: string): string {
	return path.join(dir, "meta.json");
}

export function writeSandboxMeta(dir: string, meta: SandboxMeta): string {
	fs.mkdirSync(dir, { recursive: true });
	const p = metaPath(dir);
	const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, p);
	return p;
}

export function readSandboxMeta(dir: string): SandboxMeta | undefined {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(metaPath(dir), "utf8"));
		if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) return undefined;
		return raw as SandboxMeta;
	} catch {
		return undefined;
	}
}

export interface SandboxEntry {
	/** Sandbox dir (project dir = index root; holds checkout + config). */
	dir: string;
	/** Hidden sibling dir with the operational state (db, meta) — outside the index root. */
	stateDir: string;
	meta: SandboxMeta;
	dbSizeBytes: number;
	/** chunkhound's claimed indexed root from the `<db>.root.json` sidecar (absent = not yet claimed). */
	claimedRoot?: string;
	/** The sandbox dir (index root) exists on disk. `listSandboxes` always
	 * sets it; absent on hand-built entries (tests) = assumed present. False
	 * means only the `.state` half survived (deleted sandbox dir) — /ch-status
	 * must flag that instead of reporting a clean claim. */
	dirExists?: boolean;
}

/**
 * chunkhound claims a duckdb dir for an indexed root via a sibling sidecar
 * (`<dbfile>.root.json`, written at index time). Returns the claimed root or
 * undefined when the db was never indexed (or the sidecar is unreadable).
 */
export function readClaimedRoot(dbPath: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(`${dbPath}.root.json`, "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const root = (raw as { indexed_root_path?: unknown }).indexed_root_path;
		return typeof root === "string" && root.length > 0 ? root : undefined;
	} catch {
		return undefined;
	}
}

/** Sidecar roots are as_posix'd and normalized; worktree paths may differ in separators/trailing slash. */
export function claimedRootMatches(claimedRoot: string, worktree: string): boolean {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
	return norm(claimedRoot) === norm(worktree);
}

export function dirSize(p: string): number {
	try {
		const st = fs.statSync(p);
		if (st.isFile()) return st.size;
		let total = 0;
		for (const entry of fs.readdirSync(p)) total += dirSize(path.join(p, entry));
		return total;
	} catch {
		return 0;
	}
}

/**
 * Total bytes under a path (files only; symlinks to FILES counted via stat,
 * symlinks to DIRECTORIES skipped — following them could loop/duplicate on
 * npm-style link trees). Fully SEQUENTIAL async walk: never blocks the event
 * loop (unlike the synchronous dirSize), yet issues one syscall at a time —
 * parallel stat/readdir streams return wrong metadata on flaky container
 * filesystems (observed: overlayfs under concurrent load reports stale
 * sizes), while sequential walks are deterministic everywhere.
 * Measurement honesty (D7): a missing ROOT path returns 0 — nothing is there,
 * the walk measured that (gone rows rely on it). An unreadable subtree
 * DIRECTORY returns `undefined`: the walk is incomplete, so the partial sum
 * is not a measurement and callers must render it as unknown rather than
 * inventing a number. A file that races away mid-walk still counts as 0 (it
 * was absent when measured) — only unreadable directories make the walk
 * incomplete.
 */
export async function dirSizeAsync(p: string): Promise<number | undefined> {
	const fsp = fs.promises;
	try {
		const st = await fsp.stat(p);
		if (st.isFile()) return st.size;
	} catch {
		return 0; // missing root — measured as "nothing here"
	}
	const walk = async (dir: string): Promise<number | undefined> => {
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return undefined; // unreadable subtree — the walk is incomplete
		}
		let total = 0;
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				const sub = await walk(full);
				if (sub === undefined) return undefined; // propagate incompleteness
				total += sub;
			} else if (e.isSymbolicLink()) {
				// One-level follow: count file symlinks, skip dir symlinks (npm
				// link trees would otherwise be counted repeatedly / loop).
				try {
					const st = await fsp.stat(full);
					total += st.isFile() ? st.size : 0;
				} catch {
					// dangling link — counts 0
				}
			} else if (e.isFile()) {
				try {
					total += (await fsp.stat(full)).size;
				} catch {
					// raced away — counts 0 (a file race is not incompleteness)
				}
			}
		}
		return total;
	};
	return walk(p);
}
/** Test seams for the library scan. Only `readdirSync` needs widening (the
 * race / unreadable-root pins); everything else hits the real filesystem, so a
 * seam never fakes the behavior under test wholesale. ESM namespace properties
 * (`import * as fs`) are read-only — patching the default `fs` object from a
 * test cannot reach this module, which is exactly why the seam is injected. */
export interface SandboxScanSeams {
	/** List the state root's entry names. Defaults to `fs.readdirSync`. */
	readdirSync?: (stateRoot: string) => string[];
}

/** A library listing plus the read failure that must be surfaced instead of
 * rendering as an empty library. */
export interface SandboxLibrary {
	entries: SandboxEntry[];
	/** Set when the state root exists but could not be read (EACCES/EPERM/…):
	 * `entries` is the part that survived, not the library. A missing state root
	 * (ENOENT) is NOT an issue — an absent library is an empty one. */
	issue?: string;
}

/** Library listing that keeps its failure distinguishable from an empty
 * library. Callers that render a count must render `issue` when set; the
 * convenience `listSandboxes` drops it (N-05). */
export function listSandboxLibrary(settings: ChhoundSettings, seams: SandboxScanSeams = {}): SandboxLibrary {
	const root = sandboxRoot(settings);
	const stateRoot = path.join(root, STATE_DIR_NAME);
	const readdir = seams.readdirSync ?? ((dir: string): string[] => fs.readdirSync(dir));
	let names: string[];
	try {
		names = readdir(stateRoot);
	} catch (err) {
		// No library yet is a real empty library; anything else (EACCES, EPERM,
		// ENOTDIR, …) is a read failure — returning [] for those would print
		// "(no sandboxes …)" for a library that is merely unreadable.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
		return {
			entries: [],
			issue: `cannot read the worktree library ${root}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const out: SandboxEntry[] = [];
	for (const name of names) {
		const stateDir = path.join(stateRoot, name);
		try {
			// A concurrent rm/prune can delete the entry between readdir and
			// stat — skip it instead of aborting the whole listing.
			if (!fs.statSync(stateDir).isDirectory()) continue;
			const meta = readSandboxMeta(stateDir);
			if (!meta) continue;
			const dir = path.join(root, name);
			let dirExists = false;
			try {
				dirExists = fs.statSync(dir).isDirectory();
			} catch {
				dirExists = false; // storage dir half deleted — /ch-status must flag it
			}
			out.push({
				dir,
				stateDir,
				meta,
				dbSizeBytes: dirSize(meta.dbPath),
				claimedRoot: readClaimedRoot(meta.dbPath),
				dirExists,
			});
		} catch {
			// raced away / unreadable entry — skip it, never abort the listing
			continue;
		}
	}
	return { entries: out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt)) };
}

/** Sandbox identity lives with meta.json in the hidden state dir (`.state/<name>`). */
export function listSandboxes(settings: ChhoundSettings): SandboxEntry[] {
	return listSandboxLibrary(settings).entries;
}

/** Remove sandboxes whose worktree no longer exists. Returns removed dirs. */
/** Absolute worktree paths of every sandbox in the library (deduped). */
export function indexedWorktreePaths(settings: ChhoundSettings): string[] {
	return [...new Set(listSandboxes(settings).map((e) => e.meta.worktree).filter((w) => w && w.length > 0))];
}

/**
 * True when `location` would overlap an already-indexed worktree: same dir,
 * inside one, or containing one. Returns the conflicting worktree path.
 */
export function findConflictingIndexed(location: string, indexedWorktrees: string[]): string | undefined {
	const loc = path.resolve(location);
	for (const w of indexedWorktrees) {
		const wt = path.resolve(w);
		if (wt === loc || loc.startsWith(wt + path.sep) || wt.startsWith(loc + path.sep)) return wt;
	}
	return undefined;
}

/** Remove both halves (sandbox dir + hidden state dir) of sandboxes whose worktree no longer exists.
 * Returns the removed state dirs (one per sandbox — the sandbox dir is removed too when present). */
export function pruneSandboxes(settings: ChhoundSettings): string[] {
	const removed: string[] = [];
	for (const entry of listSandboxes(settings)) {
		if (!fs.existsSync(entry.meta.worktree)) {
			// Sandbox dir FIRST: the .state half is what makes the sandbox
			// discoverable, so it must survive a failed checkout removal.
			try {
				fs.rmSync(entry.dir, { recursive: true, force: true });
			} catch {
				continue; // still visible as a row — the next --prune retries
			}
			try {
				fs.rmSync(entry.stateDir, { recursive: true, force: true });
				removed.push(entry.stateDir);
			} catch {
				// first half is gone; the surviving state half keeps the row prunable
			}
		}
	}
	return removed;
}

/** Display label for a sandbox's branch slot — PR sandboxes carry head context
 * (head branch @ commit) on top of their pull/<n> identity. */
export function sandboxBranchLabel(meta: { branch: string; headRef?: string; headOid?: string }): string {
	let label = meta.branch;
	if (meta.headRef) {
		label += ` · head ${meta.headRef}${meta.headOid ? ` @ ${meta.headOid.slice(0, 8)}` : ""}`;
	}
	return label;
}

export function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
