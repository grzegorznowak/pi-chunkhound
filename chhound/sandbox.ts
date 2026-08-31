import * as fs from "node:fs";
import path from "node:path";
import { sandboxRoot, shortHash, slugify } from "./paths.js";
import { CONFIG_FILE_NAME } from "./config.js";
import type { ChhoundSettings, SandboxMeta } from "./types.js";

/** One managed dir per worktree: config + duckdb + meta. */
export function sandboxDirFor(repoRoot: string, worktree: string, settings: ChhoundSettings): string {
	const wt = path.resolve(worktree);
	const name = `${slugify(path.basename(repoRoot))}-${slugify(path.basename(wt))}-${shortHash(wt)}`;
	return path.join(sandboxRoot(settings), name);
}

export function sandboxConfigPath(sandboxDir: string): string {
	return path.join(sandboxDir, CONFIG_FILE_NAME);
}

export function sandboxDbDir(sandboxDir: string): string {
	return path.join(sandboxDir, ".chhound.db");
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
	dir: string;
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

export function listSandboxes(settings: ChhoundSettings): SandboxEntry[] {
	const root = sandboxRoot(settings);
	if (!fs.existsSync(root)) return [];
	const out: SandboxEntry[] = [];
	for (const name of fs.readdirSync(root)) {
		const dir = path.join(root, name);
		if (!fs.statSync(dir).isDirectory()) continue;
		const meta = readSandboxMeta(dir);
		if (meta) {
			out.push({ dir, meta, dbSizeBytes: dirSize(meta.dbPath), claimedRoot: readClaimedRoot(meta.dbPath) });
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

export function pruneSandboxes(settings: ChhoundSettings): string[] {
	const removed: string[] = [];
	for (const entry of listSandboxes(settings)) {
		if (!fs.existsSync(entry.meta.worktree)) {
			fs.rmSync(entry.dir, { recursive: true, force: true });
			removed.push(entry.dir);
		}
	}
	return removed;
}

export function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
