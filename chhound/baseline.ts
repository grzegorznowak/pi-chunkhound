import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chhoundApiKeyEnv, chhoundVersion } from "./cli.js";
import { CONFIG_FILE_NAME, materializeConfig } from "./config.js";
import { defaultRemoteBranch, fetchRef, gitWorktreeAdd, gitWorktreeRemove, remoteOrigin, revParse } from "./git.js";
import { hotStartIndex } from "./hotstart.js";
import { baseRoot, shortHash, slugify } from "./paths.js";
import type { BaselineMeta, ChhoundSettings } from "./types.js";

export interface BaselineInfo {
	dir: string;
	dbDir: string;
	configPath: string;
	meta: BaselineMeta;
	ref: string;
	/** True when this invocation primed/refreshed the baseline. */
	fresh: boolean;
	reason: string;
}

export interface EnsureBaselineOptions {
	repoRoot: string;
	settings: ChhoundSettings;
	onLine?: (line: string) => void;
	/** Plugin-originated stage notes ("baseline fresh…", "priming…") — surfaced as progress stages. Falls back to onLine. */
	onNote?: (note: string) => void;
	/** Anchor ref override — the LOCAL branch the worktree's tree comes from. Overrides
	 * settings.baseline.ref. Default resolution: settings.baseline.ref → default
	 * remote branch → "main". */
	ref?: string;
	/** Force full re-prime even when fresh. */
	force?: boolean;
	apiKey?: string;
	/** Extra args for the priming index (e.g. --no-embeddings in smoke tests). */
	extraArgs?: string[];
}

const LOCK_FILE = ".prime.lock";
const LOCK_MAX_AGE_MS = 30 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;

export function baselineDirFor(repoRoot: string, ref: string, settings: ChhoundSettings): string {
	const repoSlug = `${slugify(path.basename(repoRoot))}-${shortHash(path.resolve(repoRoot))}`;
	return path.join(baseRoot(settings), repoSlug, slugify(ref));
}

/** Duckdb dir of a baseline — matches what ensureBaseline computes internally. */
export function baselineDbDirFor(repoRoot: string, ref: string, settings: ChhoundSettings): string {
	return path.join(baselineDirFor(repoRoot, ref, settings), "db", ".chhound.db");
}

function baselineMetaPath(dir: string): string {
	return path.join(dir, "meta.json");
}

export function readBaselineMeta(dir: string): BaselineMeta | undefined {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(baselineMetaPath(dir), "utf8"));
		if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) return undefined;
		return raw as BaselineMeta;
	} catch {
		return undefined;
	}
}

/** True when a prime lock with a LIVE pid is present (a prime may be in flight). */
function hasLivePrimeLock(dir: string): boolean {
	try {
		const pid = Number(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8").trim());
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Baseline garbage collection (cache-safe, re-primable):
 * - dirs with no readable meta (crashed primes) — unless a live prime lock
 *   suggests a prime is still in flight there;
 * - dirs whose meta.repoRoot no longer exists on disk (repo moved/deleted);
 * - superseded duplicates: same (repoRoot, baseRef) in another dir with a
 *   newer updatedAt (e.g. after a ref-naming change).
 * Returns the removed dirs. Run automatically after baseline primes and via
 * /ch-status --prune.
 */
export function sweepBaselineGarbage(settings: ChhoundSettings): string[] {
	const root = baseRoot(settings);
	if (!fs.existsSync(root)) return [];
	const removed: string[] = [];
	const all: Array<{ dir: string; meta?: BaselineMeta }> = [];
	for (const repoDir of fs.readdirSync(root)) {
		const rd = path.join(root, repoDir);
		if (!fs.statSync(rd).isDirectory()) continue;
		for (const refDir of fs.readdirSync(rd)) {
			const d = path.join(rd, refDir);
			if (!fs.statSync(d).isDirectory()) continue;
			all.push({ dir: d, meta: readBaselineMeta(d) });
		}
	}
	for (const entry of all) {
		if (hasLivePrimeLock(entry.dir)) continue; // prime in flight — never touch
		const garbage =
			!entry.meta ||
			!entry.meta.repoRoot ||
			!fs.existsSync(entry.meta.repoRoot) ||
			all.some((o) => {
				if (o === entry || !entry.meta || !o.meta) return false;
				return o.meta.repoRoot === entry.meta.repoRoot && o.meta.baseRef === entry.meta.baseRef && o.meta.updatedAt > entry.meta.updatedAt;
			});
		if (garbage) {
			fs.rmSync(entry.dir, { recursive: true, force: true });
			removed.push(entry.dir);
		}
	}
	// Drop empty per-repo parent dirs (cosmetic).
	for (const repoDir of fs.readdirSync(root)) {
		const rd = path.join(root, repoDir);
		try {
			if (fs.statSync(rd).isDirectory() && fs.readdirSync(rd).length === 0) {
				fs.rmSync(rd, { recursive: true, force: true });
			}
		} catch {
			/* raced */
		}
	}
	return removed;
}

function writeBaselineMeta(dir: string, meta: BaselineMeta): void {
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${baselineMetaPath(dir)}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, baselineMetaPath(dir));
}

function isLockStale(lockPath: string): boolean {
	try {
		const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
		if (Number.isInteger(pid) && pid > 0) {
			try {
				process.kill(pid, 0);
			} catch {
				return true; // holder died
			}
		}
		return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_MAX_AGE_MS;
	} catch {
		return true;
	}
}

/** O_EXCL lock with pid + staleness detection (node has no flock). */
async function withPrimeLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = path.join(dir, LOCK_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			try {
				return await fn();
			} finally {
				fs.rmSync(lockPath, { force: true });
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
			if (isLockStale(lockPath)) {
				fs.rmSync(lockPath, { force: true });
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for baseline lock ${lockPath} (another process is priming)`);
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}
}

function staleReason(
	meta: BaselineMeta | undefined,
	opts: { version: string; baseCommit?: string; force?: boolean; settings: ChhoundSettings },
): string | null {
	if (!meta) return "missing";
	if (opts.force) return "forced";
	if (meta.chhoundVersion !== opts.version) return `chunkhound version changed (${meta.chhoundVersion} → ${opts.version})`;
	if (opts.baseCommit && meta.baseCommit !== opts.baseCommit) return "base ref moved";
	const maxAgeDays = opts.settings.baseline?.maxAgeDays ?? 1;
	const ageMs = Date.now() - new Date(meta.updatedAt).getTime();
	if (Number.isFinite(ageMs) && ageMs > maxAgeDays * 24 * 60 * 60_000) return `older than ${maxAgeDays}d`;
	return null;
}

function apiKeyEnv(apiKey?: string): Record<string, string> | undefined {
	return chhoundApiKeyEnv(apiKey);
}

/**
 * Ensure a fresh baseline index for the repo's base ref.
 *
 * The baseline anchors to the LOCAL branch tip — worktrees are cut from local
 * state, so origin/<ref> would mismatch local whenever the two drift.
 * origin/<ref> is only a fallback (best-effort fetch) when no local branch of
 * that name exists.
 *
 * Priming = temporary detached worktree at the resolved source ref, indexed
 * with the same hot-start machinery used for sandboxes (copy + top-up on
 * refresh, full index when missing/version-moved).
 */
export async function ensureBaseline(opts: EnsureBaselineOptions): Promise<BaselineInfo> {
	const emitNote = opts.onNote ?? opts.onLine;
	const ref = opts.ref ?? (opts.settings.baseline?.ref || (await defaultRemoteBranch(opts.repoRoot)) || "main");
	const version = await chhoundVersion();
	const dir = baselineDirFor(opts.repoRoot, ref, opts.settings);
	const dbDir = baselineDbDirFor(opts.repoRoot, ref, opts.settings);
	fs.mkdirSync(dir, { recursive: true });

	// LOCAL-first: the local branch is the anchor (worktrees branch from local
	// state). Only when no local branch of that name exists do we best-effort
	// fetch origin and fall back to origin/<ref> — no-remote repos never fetch.
	let sourceRef = ref;
	let baseCommit = await revParse(opts.repoRoot, ref);
	if (!baseCommit) {
		try {
			await fetchRef(opts.repoRoot, ref);
		} catch {
			// offline or no remote — continue with what we have
		}
		sourceRef = `origin/${ref}`;
		baseCommit = await revParse(opts.repoRoot, sourceRef);
	}

	let meta = readBaselineMeta(dir);
	let reason = staleReason(meta, { version, baseCommit, force: opts.force, settings: opts.settings });
	if (meta && !reason) {
		emitNote?.(`baseline fresh (${ref} @ ${meta.baseCommit.slice(0, 12)})`);
		sweepBaselineGarbage(opts.settings); // cheap GC — piggyback on every prime
		return { dir, dbDir, configPath: path.join(dir, CONFIG_FILE_NAME), meta, ref, fresh: false, reason: "fresh" };
	}

	await withPrimeLock(dir, async () => {
		// Re-check under the lock — another process may have primed meanwhile.
		const meta2 = readBaselineMeta(dir);
		const reason2 = staleReason(meta2, { version, baseCommit, force: opts.force, settings: opts.settings });
		if (meta2 && !reason2) return;

		emitNote?.(`priming ${ref} @ ${baseCommit?.slice(0, 12) ?? "unknown"}`);
		const tmp = path.join(os.tmpdir(), `pi-chhound-prime-${process.pid}-${Date.now()}`);
		let indexed = false;
		try {
			await gitWorktreeAdd({ cwd: opts.repoRoot, path: tmp, detach: true, commitIsh: sourceRef });
			const configPath = materializeConfig(dir, { settings: opts.settings, dbDir });
			// Baseline db path is stable: refresh = in-place top-up; version move = fresh.
			const reuse = !!meta2 && meta2.chhoundVersion === version && fs.existsSync(dbDir);
			if (!reuse) fs.rmSync(dbDir, { recursive: true, force: true });
			const r = await hotStartIndex({
				sourceDbDir: null,
				targetDbDir: dbDir,
				indexDir: tmp,
				configPath,
				forceReindex: opts.force,
				env: apiKeyEnv(opts.apiKey),
				onLine: opts.onLine,
				extraArgs: opts.extraArgs,
			});
			if (r.code !== 0) {
				throw new Error(`baseline index failed (code ${r.code}) — run /ch-setup --verify for configuration help`);
			}
			indexed = true;
		} finally {
			await gitWorktreeRemove(tmp, opts.repoRoot).catch(() => {});
			if (!indexed) {
				// Ensure a failed prime never leaves a half-written db behind.
				fs.rmSync(dbDir, { recursive: true, force: true });
				fs.rmSync(path.join(dir, CONFIG_FILE_NAME), { force: true });
			}
		}
		writeBaselineMeta(dir, {
			version: 1,
			repoRoot: path.resolve(opts.repoRoot),
			baseRef: ref,
			baseCommit: baseCommit ?? "unknown",
			chhoundVersion: version,
			updatedAt: new Date().toISOString(),
		});
	});

	meta = readBaselineMeta(dir);
	if (!meta) throw new Error(`baseline priming failed for ${ref} (no meta written)`);
	sweepBaselineGarbage(opts.settings); // cheap GC — piggyback on every prime
	return { dir, dbDir, configPath: path.join(dir, CONFIG_FILE_NAME), meta, ref, fresh: true, reason: reason ?? "primed" };
}

/** List baseline dirs (for /ch-status). One level deep: <root>/<repo>/<ref>. */
export function listBaselines(settings: ChhoundSettings): Array<{ dir: string; meta?: BaselineMeta }> {
	const root = baseRoot(settings);
	const out: Array<{ dir: string; meta?: BaselineMeta }> = [];
	if (!fs.existsSync(root)) return out;
	for (const repoDir of fs.readdirSync(root)) {
		const rd = path.join(root, repoDir);
		if (!fs.statSync(rd).isDirectory()) continue;
		for (const refDir of fs.readdirSync(rd)) {
			const d = path.join(rd, refDir);
			if (!fs.statSync(d).isDirectory()) continue;
			out.push({ dir: d, meta: readBaselineMeta(d) });
		}
	}
	return out;
}
