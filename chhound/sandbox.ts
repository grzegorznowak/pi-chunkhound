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

/** Sandbox identity lives with meta.json in the hidden state dir (`.state/<name>`). */
export function listSandboxes(settings: ChhoundSettings): SandboxEntry[] {
	const root = sandboxRoot(settings);
	const stateRoot = path.join(root, STATE_DIR_NAME);
	if (!fs.existsSync(stateRoot)) return [];
	const out: SandboxEntry[] = [];
	for (const name of fs.readdirSync(stateRoot)) {
		const stateDir = path.join(stateRoot, name);
		if (!fs.statSync(stateDir).isDirectory()) continue;
		const meta = readSandboxMeta(stateDir);
		if (meta) {
			out.push({
				dir: path.join(root, name),
				stateDir,
				meta,
				dbSizeBytes: dirSize(meta.dbPath),
				claimedRoot: readClaimedRoot(meta.dbPath),
			});
		}
	}
	return out.sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
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
			fs.rmSync(entry.stateDir, { recursive: true, force: true });
			removed.push(entry.stateDir);
			fs.rmSync(entry.dir, { recursive: true, force: true });
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
