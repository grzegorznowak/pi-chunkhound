/*
 * Stream 2 discovery (spec v1.2 §2): fast-pass fixed spots, bounded
 * deep-sweep, layout triage + verdicts, managed-root containment and
 * fixed-spot selection. Advisory only — no adoption seeding happens here
 * (C2). runSetupDiscovery + the setup wiring land with setup/command.ts.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { LibraryEntry } from "./library.js";
export type Verdict = "adoptable" | "layout-not-supported" | "unresolved-path" | "busy" | "unusable";
export interface DiscoveryLimits { maxConfigBytes?: number; maxDirs?: number; maxFiles?: number; maxMs?: number; }
export interface DiscoveryFs { realpath?: (path: string) => string; }
export interface DiscoveryOptions {
	limits?: DiscoveryLimits;
	signal?: AbortSignal;
	fs?: DiscoveryFs;
	now?: () => number;
	managedRoots?: string[];
}
export interface DiscoveryCandidate {
	repoRoot: string;
	configPath: string;
	dbPath?: string;
	layout?: "file" | "dir";
	sidecarRoot?: string;
}
export interface TriageResult { candidate: DiscoveryCandidate; verdict: Verdict; issue?: string; }
export interface SweepResult {
	candidates: DiscoveryCandidate[];
	truncated: boolean;
	permissionErrors: number;
	cancelled: boolean;
	/** Human-readable, sanitized budget/non-regular-file notices. */
	issues?: string[];
}

/** Injectable setup boundary: no UI or command registration is coupled to discovery. */
export interface SetupDeps {
	verifyCombined: () => Promise<boolean>;
	discover: (options?: DiscoveryOptions) => Promise<SweepResult>;
	consent?: () => Promise<"fast-pass" | "deep-sweep" | "skip" | "cancel">;
	readGlobalMarker?: () => Promise<boolean>;
	writeGlobalMarker?: () => Promise<void>;
	writeCatalog?: (candidates: DiscoveryCandidate[]) => Promise<void>;
}
export interface SetupDiscoveryOptions extends DiscoveryOptions {
	uiAvailable?: boolean;
	verifyOnly?: boolean;
	projectOnly?: boolean;
	reset?: boolean;
	standalone?: boolean;
}

async function lstatSafe(file: string): Promise<fs.Stats | undefined> {
	try {
		return await fsp.lstat(file);
	} catch {
		return undefined;
	}
}
const DEFAULT_MAX_CONFIG_BYTES = 256 * 1024;
const DEFAULT_SWEEP_MAX_DIRS = 10_000;
const DEFAULT_SWEEP_MAX_FILES = 20_000;
const DEFAULT_SWEEP_MAX_MS = 15_000;
/** Name-based skip dirs for bounded recursion; containment is separate + path-based.
 * `.chunkhound` leaves are inspected only for their config.json and never descended. */
const SWEEP_SKIP_DIRS = new Set([".git", "node_modules", "dependency", "cache", ".chunkhound"]);
const WRITER_ARTIFACTS = [".wal", ".compact_backup", ".compact_new"] as const;

/** S4 verdict copy, spec v1.2 §2 — exact strings (unit/c1-verdict-copy is the contract). */
const VERDICT_COPY: Record<Verdict, string> = {
	adoptable: "Existing index for this repo found — will be reused",
	"layout-not-supported": "Index layout not supported (covers a different or multiple folders) — skipped",
	"unresolved-path": "Index location unclear — needs your answer or skip",
	busy: "Index in use by chunkhound right now — will copy when free",
	unusable: "Config or db missing/unreadable — skipped",
};

export function verdictCopy(verdict: Verdict): string {
	return VERDICT_COPY[verdict];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Hard-bounded file read: at most maxBytes+1 bytes are ever read through the
 * open handle (no stat-then-read window), and a longer file reports oversized
 * without parsing. Errors map to sanitized issues, never raw content.
 */
async function readBounded(
	file: string,
	maxBytes: number,
	label: string,
): Promise<{ ok: true; text: string } | { ok: false; issue: string }> {
	let handle: fsp.FileHandle;
	try {
		handle = await fsp.open(file, "r");
	} catch {
		return { ok: false, issue: `${label} unreadable` };
	}
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		if (bytesRead > maxBytes) return { ok: false, issue: `${label} exceeds ${maxBytes} bytes` };
		return { ok: true, text: buffer.toString("utf8", 0, bytesRead) };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Sync realpath with a lexical fallback (missing files keep their path). */
function realpathOrSelf(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/** Path-based containment: p is inside root (or is root), never name-based. */
function isInside(p: string, root: string): boolean {
	const normalized = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	return p === root || p.startsWith(normalized);
}

function isManagedContainedPath(p: string | undefined, managedRoots: readonly string[]): boolean {
	if (!p) return false;
	const resolved = realpathOrSelf(p);
	return managedRoots.some((root) => isInside(resolved, realpathOrSelf(root)));
}

/** Symlink aliases resolve via realpath: a candidate whose config/db/sidecar
 * lands inside a managed root (sandbox/base/mirror dirs, custom roots) is
 * never catalogued. Mirrors are managed roots — a mirror host never has user
 * configs and PR flows baseline through their own machinery. */
export function isManagedContainment(candidate: DiscoveryCandidate, managedRoots: string[]): boolean {
	const roots = managedRoots.filter(Boolean);
	if (roots.length === 0) return false;
	return (
		isManagedContainedPath(candidate.configPath, roots) ||
		isManagedContainedPath(candidate.dbPath, roots) ||
		isManagedContainedPath(candidate.sidecarRoot, roots)
	);
}

/**
 * Fixed-spot selection: return the first adoptable candidate in the order of
 * the candidates array (which is the fixed-spot order), correlating triage
 * results by candidate identity — parallel triage results may arrive in any
 * array order and must never reorder the pick.
 */
export function selectAdoptable(candidates: DiscoveryCandidate[], triaged: TriageResult[]): DiscoveryCandidate | undefined {
	for (const candidate of candidates) {
		// Correlate strictly by candidate identity: triage preserves the input
		// object, so a path-equivalent but untriaged candidate must never be
		// returned as if it had been adopted.
		const result = triaged.find((t) => t.candidate === candidate);
		if (result?.verdict === "adoptable") return candidate;
	}
	return undefined;
}

/** Only a current non-adoptable result (or a dropped entry) is eligible for
 * the tier-3 size question; unusable/busy history never suppresses retry. */
export function sizeAskEligible(result: TriageResult | undefined): boolean {
	return result === undefined || result.verdict !== "adoptable";
}

/**
 * Triage one discovered layout against current file state. Order matters:
 * relative db path in the config is "unresolved-path" and is detected BEFORE
 * any db/claim existence check; then db missing → unusable; claim missing /
 * not version 1 → unusable; claim root ≠ repo root → layout-not-supported;
 * writer artifacts (.wal/.compact_backup/.compact_new) → busy.
 */
export async function triage(candidate: DiscoveryCandidate, options: DiscoveryOptions = {}): Promise<TriageResult> {
	// Spec cap: config reads are bounded ≤256 KiB; callers may only shrink it.
	const maxConfigBytes = Math.min(options.limits?.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES, DEFAULT_MAX_CONFIG_BYTES);
	const unusable = (issue: string): TriageResult => ({ candidate, verdict: "unusable", issue });

	const configStat = await lstatSafe(candidate.configPath);
	if (!configStat) return unusable("config file missing");
	// Stat-skip non-regular files: a FIFO config would block forever on open,
	// and symlinks are never followed.
	if (!configStat.isFile()) return unusable("config is not a regular file");
	const configRead = await readBounded(candidate.configPath, maxConfigBytes, "config");
	if (!configRead.ok) return unusable(configRead.issue);
	let config: unknown;
	try {
		config = JSON.parse(configRead.text);
	} catch {
		// Never echo the parse error: V8 embeds raw content (secrets).
		return unusable("config is not valid JSON");
	}
	// The config is authoritative for the db location; a config without a
	// usable database.path is structurally invalid, never a dbPath fallback.
	const configuredPath = isRecord(config) && isRecord(config.database) ? config.database.path : undefined;
	if (typeof configuredPath !== "string") return unusable("config has no database path");
	if (!path.isAbsolute(configuredPath)) {
		return { candidate, verdict: "unresolved-path", issue: "config database path is relative" };
	}
	const dbPath = configuredPath;
	const dbStat = await lstatSafe(dbPath);
	if (!dbStat) return unusable("database file missing");
	if (!dbStat.isFile()) return unusable("database is not a regular file");

	// Claim sidecar (bounded read; malformed/unversioned sidecars are unusable).
	const claimPath = `${dbPath}.root.json`;
	const claimStat = await lstatSafe(claimPath);
	if (!claimStat) return unusable("index claim sidecar missing");
	if (!claimStat.isFile()) return unusable("index claim sidecar is not a regular file");
	const claimRead = await readBounded(claimPath, maxConfigBytes, "index claim sidecar");
	if (!claimRead.ok) return unusable(claimRead.issue);
	let claim: unknown;
	try {
		claim = JSON.parse(claimRead.text);
	} catch {
		return unusable("index claim sidecar is not valid JSON");
	}
	const claimRoot = isRecord(claim) ? claim.indexed_root_path : undefined;
	const claimVersion = isRecord(claim) ? claim.version : undefined;
	if (typeof claimRoot !== "string" || claimVersion !== 1) return unusable("index claim not recognized");
	if (claimRoot !== candidate.repoRoot) {
		return { candidate, verdict: "layout-not-supported", issue: "index claim covers a different or multiple folders" };
	}

	// Writer artifacts mean the engine is using the db right now.
	for (const artifact of WRITER_ARTIFACTS) {
		if (await lstatSafe(`${dbPath}${artifact}`)) {
			return { candidate, verdict: "busy", issue: `database has an active ${artifact} writer artifact` };
		}
	}
	return { candidate, verdict: "adoptable" };
}

/**
 * Re-triage an advisory catalog entry at use time; undefined means drop it.
 * The advisory history (verdict/source) never decides — current file state
 * does. A deleted config leaves nothing to re-ask about (drop); a moved db,
 * replaced sidecar or reappeared source re-triages from live files.
 */
export async function retriageEntry(entry: LibraryEntry, options: DiscoveryOptions = {}): Promise<TriageResult | undefined> {
	if (!(await lstatSafe(entry.configPath))) return undefined;
	const candidate: DiscoveryCandidate = {
		repoRoot: entry.repoRoot,
		configPath: entry.configPath,
		dbPath: entry.dbPath,
		layout: entry.layout,
		sidecarRoot: entry.sidecarRoot,
	};
	return triage(candidate, options);
}

/**
 * Fast pass: no recursion. Fixed spots on the SELECTED host root (never the
 * process cwd): <repoRoot>/.chunkhound.json (file layout), <repoRoot>/
 * .chunkhound/config.json (dir layout leaf, not descended into), the repo
 * parent dir, and the session cwd. Daemon artifacts (watchman.sock) and leaf
 * recursion (deep.json) are never inspected. Silent and callable without UI.
 */
export async function fastPass(repoRoot: string, sessionCwd: string, _options: DiscoveryOptions = {}): Promise<DiscoveryCandidate[]> {
	const found: DiscoveryCandidate[] = [];
	const seenSpots = new Set<string>();
	const push = (candidate: DiscoveryCandidate): void => {
		if (!found.some((existing) => existing.configPath === candidate.configPath)) found.push(candidate);
	};
	for (const spot of [repoRoot, path.dirname(repoRoot), sessionCwd]) {
		if (seenSpots.has(spot)) continue;
		seenSpots.add(spot);
		const fileConfig = path.join(spot, ".chunkhound.json");
		if ((await lstatSafe(fileConfig))?.isFile()) {
			push({ repoRoot: spot, configPath: fileConfig, dbPath: path.join(spot, ".chunkhound.db"), layout: "file" });
		}
		const leafConfig = path.join(spot, ".chunkhound", "config.json");
		if ((await lstatSafe(leafConfig))?.isFile()) {
			push({ repoRoot: spot, configPath: leafConfig, dbPath: path.join(spot, ".chunkhound", "chunks.db"), layout: "dir" });
		}
	}
	return found;
}

/**
 * Bounded recursion from root. Skips .git/node_modules/dependency/cache dirs
 * by name; prunes REAL managed subtrees (path-based, realpath-resolved —
 * never name-based) from options.managedRoots; never follows symlinks
 * (cycle-safe, outside links unreachable); inspects .chunkhound leaves only
 * for their config.json (daemon artifacts excluded) and never descends into
 * them. Unreadable dirs count as permissionErrors without cancelling; dir/
 * file/time budgets truncate; an aborted signal cancels promptly.
 */
export async function deepSweep(root: string, options: DiscoveryOptions = {}): Promise<SweepResult> {
	const maxDirs = options.limits?.maxDirs ?? DEFAULT_SWEEP_MAX_DIRS;
	const maxFiles = options.limits?.maxFiles ?? DEFAULT_SWEEP_MAX_FILES;
	const maxMs = options.limits?.maxMs ?? DEFAULT_SWEEP_MAX_MS;
	const signal = options.signal;
	const managedRoots = (options.managedRoots ?? []).filter(Boolean).map((r) => realpathOrSelf(r));
	const candidates: DiscoveryCandidate[] = [];
	const issues: string[] = [];
	const started = Date.now();
	let truncated = false;
	let cancelled = signal?.aborted ?? false;
	let permissionErrors = 0;
	let dirsVisited = 0;
	let filesSeen = 0;

	if (cancelled) return { candidates, truncated, permissionErrors, cancelled, issues };
	const stack: string[] = [root];
	while (stack.length > 0 && !cancelled && !truncated) {
		if (signal?.aborted) {
			cancelled = true;
			break;
		}
		if (dirsVisited >= maxDirs) {
			truncated = true;
			issues.push(`deep sweep truncated after ${maxDirs} directories`);
			break;
		}
		if (Date.now() - started >= maxMs) {
			truncated = true;
			issues.push(`deep sweep truncated after ${maxMs} ms`);
			break;
		}
		if (filesSeen >= maxFiles) {
			truncated = true;
			issues.push(`deep sweep truncated after ${maxFiles} config files`);
			break;
		}
		const dir = stack.pop()!;
		dirsVisited += 1;
		// Containment is checked on the directory itself: the whole subtree of a
		// real managed root is skipped, never reported.
		if (managedRoots.some((managedRoot) => isInside(realpathOrSelf(dir), managedRoot))) continue;
		const fileConfig = path.join(dir, ".chunkhound.json");
		const leafConfig = path.join(dir, ".chunkhound", "config.json");
		let entries: fs.Dirent[];
		try {
			if ((await lstatSafe(fileConfig))?.isFile()) {
				candidates.push({ repoRoot: dir, configPath: fileConfig, dbPath: path.join(dir, ".chunkhound.db"), layout: "file" });
				filesSeen += 1;
			}
			if ((await lstatSafe(leafConfig))?.isFile()) {
				candidates.push({ repoRoot: dir, configPath: leafConfig, dbPath: path.join(dir, ".chunkhound", "chunks.db"), layout: "dir" });
				filesSeen += 1;
			}
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM") {
				permissionErrors += 1;
				continue;
			}
			if (code === "ENOENT" || code === "ENOTDIR") continue;
			throw error;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isSymbolicLink()) continue; // never follow symlinks
			if (!entry.isDirectory()) continue;
			if (SWEEP_SKIP_DIRS.has(entry.name)) continue;
			stack.push(path.join(dir, entry.name));
		}
	}
	return { candidates, truncated, permissionErrors, cancelled, issues: issues.length > 0 ? issues : undefined };
}

/**
 * RED-phase C1 scaffold: the setup transaction wiring lands with the
 * setup/command.ts commit (verify-first consent, marker, bypass modes).
 */
export async function runSetupDiscovery(_deps: SetupDeps, _options: SetupDiscoveryOptions = {}): Promise<SweepResult> {
	throw new Error("RED shell (C1): runSetupDiscovery not implemented — green next");
}
