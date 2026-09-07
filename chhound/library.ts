/*
 * Advisory catalog library (Stream 2 spec v1.2 §1): a personal, versioned,
 * secret-free catalog of discovered index layouts, stored as library.json
 * beside the global settings file. All mutation runs under a short
 * exclusive lock (a .lock file next to library.json, acquired with an
 * exclusive create and a bounded acquisition timeout) and writes via atomic
 * temp-and-rename, so concurrent writers (test children or extension
 * instances) can never tear the catalog or lose each other's updates.
 *
 * Schema v1 entries carry exactly the nine LibraryEntry fields; entries
 * with unknown or mistyped fields are dropped on read with a sanitized
 * issue. Raw file content never appears in issues (no canary exposure).
 * Unsupported catalog versions read as an empty advisory catalog and are
 * never overwritten (writers refuse them).
 */
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Verdict } from "./discovery.js";
import { globalSettingsPath } from "./paths.js";

export const LIBRARY_VERSION = 1 as const;
export type LibrarySource = "fast-pass" | "deep-sweep" | "manual";
export type LibraryLayout = "file" | "dir";

export interface LibraryEntry {
	repoRoot: string;
	configPath: string;
	dbPath: string;
	layout: LibraryLayout;
	sidecarRoot: string;
	verdict: Verdict;
	source: LibrarySource;
	addedAt: string;
	lastSeenAt: string;
}

export interface LibraryCatalog {
	version: typeof LIBRARY_VERSION;
	entries: LibraryEntry[];
}

export interface LibraryOptions {
	/** Awaitable test seam; production uses it only around the short lock. */
	onPhase?: (phase: "locked" | "read" | "beforeRename") => void | Promise<void>;
	lockTimeoutMs?: number;
}

/** Future catalog versions are read as an empty advisory catalog with a sanitized issue;
 * writers must refuse to overwrite them in the green implementation. */
export interface LibraryReadResult {
	catalog: LibraryCatalog;
	issue?: string;
}

const LIBRARY_FILENAME = "library.json";
const LOCK_SUFFIX = ".lock";
/** Must outlast the longest bounded holder park (writers worker: 30 s). */
const DEFAULT_LOCK_TIMEOUT_MS = 40_000;
const LOCK_POLL_MS = 5;
const VERDICTS: readonly Verdict[] = ["adoptable", "layout-not-supported", "unresolved-path", "busy", "unusable"];
const LAYOUTS: readonly LibraryLayout[] = ["file", "dir"];
const SOURCES: readonly LibrarySource[] = ["fast-pass", "deep-sweep", "manual"];

/** library.json lives beside the global settings file under the home dir. */
export function libraryPath(): string {
	return path.join(path.dirname(globalSettingsPath()), LIBRARY_FILENAME);
}

function emptyCatalog(): LibraryCatalog {
	return { version: LIBRARY_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function validLibraryEntry(value: unknown): value is LibraryEntry {
	return (
		isRecord(value) &&
		typeof value.repoRoot === "string" &&
		typeof value.configPath === "string" &&
		typeof value.dbPath === "string" &&
		isOneOf(value.layout, LAYOUTS) &&
		typeof value.sidecarRoot === "string" &&
		isOneOf(value.verdict, VERDICTS) &&
		isOneOf(value.source, SOURCES) &&
		typeof value.addedAt === "string" &&
		typeof value.lastSeenAt === "string"
	);
}

/** Rebuild an entry with exactly the nine schema fields (strips extras). */
function canonicalLibraryEntry(entry: LibraryEntry): LibraryEntry {
	return {
		repoRoot: entry.repoRoot,
		configPath: entry.configPath,
		dbPath: entry.dbPath,
		layout: entry.layout,
		sidecarRoot: entry.sidecarRoot,
		verdict: entry.verdict,
		source: entry.source,
		addedAt: entry.addedAt,
		lastSeenAt: entry.lastSeenAt,
	};
}

/** Parse the current catalog file without touching the lock. */
async function readLibraryFile(): Promise<LibraryReadResult> {
	let raw: string;
	try {
		raw = await fsp.readFile(libraryPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { catalog: emptyCatalog() };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Never echo the parse error: V8 embeds raw content (canaries).
		return { catalog: emptyCatalog(), issue: "library catalog is not valid JSON" };
	}
	if (!isRecord(parsed) || typeof parsed.version !== "number" || parsed.version !== LIBRARY_VERSION) {
		const version = isRecord(parsed) && typeof parsed.version === "number" ? String(parsed.version) : "unknown";
		return { catalog: emptyCatalog(), issue: `unsupported library catalog version ${version}` };
	}
	if (!Array.isArray(parsed.entries)) {
		return { catalog: emptyCatalog(), issue: "library catalog entries are not a list" };
	}
	const entries: LibraryEntry[] = [];
	let dropped = 0;
	for (const rawEntry of parsed.entries) {
		if (validLibraryEntry(rawEntry)) entries.push(canonicalLibraryEntry(rawEntry));
		else dropped += 1;
	}
	const issue = dropped > 0 ? `dropped ${dropped} malformed library entr${dropped === 1 ? "y" : "ies"}` : undefined;
	return { catalog: { version: LIBRARY_VERSION, entries }, issue };
}

interface HeldLock {
	release: () => Promise<void>;
}

/**
 * Exclusive-create lock with a bounded acquisition timeout. The lock file
 * carries an owner token; release unlinks only a file still carrying that
 * token (read, unlink, then close — the file exists until our own unlink, so
 * no other acquirer can slip in between), then closes the held descriptor.
 * A crashed holder can leave a stale lock; the bounded timeout bounds the
 * damage and the error names the path so the operator can remove it.
 */
async function acquireLibraryLock(lockPath: string, timeoutMs: number): Promise<HeldLock> {
	const token = `${process.pid}-${randomUUID()}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let handle: fsp.FileHandle | undefined;
		try {
			handle = await fsp.open(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`library lock still held after ${timeoutMs} ms: ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
			continue;
		}
		try {
			await handle.writeFile(token, "utf8");
		} catch (error) {
			await handle.close().catch(() => undefined);
			await fsp.unlink(lockPath).catch(() => undefined);
			throw error;
		}
		return {
			release: async () => {
				try {
					const content = await fsp.readFile(lockPath, "utf8");
					if (content === token) await fsp.unlink(lockPath);
				} catch {
					/* lock already gone */
				}
				await handle.close().catch(() => undefined);
			},
		};
	}
}

export async function withLibraryLock<T>(fn: () => Promise<T>, options: LibraryOptions = {}): Promise<T> {
	const file = libraryPath();
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const lock = await acquireLibraryLock(`${file}${LOCK_SUFFIX}`, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}

/** Writers refuse to overwrite a catalog file they cannot interpret. */
async function refuseForeignVersion(): Promise<void> {
	let raw: string;
	try {
		raw = await fsp.readFile(libraryPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("refusing to overwrite an unreadable library catalog");
	}
	if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version === LIBRARY_VERSION) return;
	const version = isRecord(parsed) && typeof parsed.version === "number" ? String(parsed.version) : "unknown";
	throw new Error(`refusing to overwrite unsupported library catalog version ${version}`);
}

/** Atomic temp-and-rename write; must run while the caller holds the lock. */
async function writeLibraryFile(catalog: LibraryCatalog, options: LibraryOptions): Promise<void> {
	await refuseForeignVersion();
	const file = libraryPath();
	const temp = `${file}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
	try {
		await fsp.writeFile(temp, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600 });
		await options.onPhase?.("beforeRename");
		await fsp.rename(temp, file);
	} catch (error) {
		await fsp.unlink(temp).catch(() => undefined);
		throw error;
	}
}

export async function readLibrary(options: LibraryOptions = {}): Promise<LibraryReadResult> {
	return withLibraryLock(async () => {
		await options.onPhase?.("locked");
		const result = await readLibraryFile();
		await options.onPhase?.("read");
		return result;
	}, options);
}

export async function writeLibrary(catalog: LibraryCatalog, options: LibraryOptions = {}): Promise<void> {
	return withLibraryLock(async () => {
		await options.onPhase?.("locked");
		await writeLibraryFile(catalog, options);
	}, options);
}

/** Lock, read/merge, then atomically write one advisory entry. */
export async function upsertLibraryEntry(entry: LibraryEntry, options: LibraryOptions = {}): Promise<LibraryCatalog> {
	return withLibraryLock(async () => {
		await options.onPhase?.("locked");
		const { catalog } = await readLibraryFile();
		await options.onPhase?.("read");
		const merged = mergeLibraryEntry(catalog, entry);
		await writeLibraryFile(merged, options);
		return merged;
	}, options);
}

export function mergeLibraryEntry(catalog: LibraryCatalog, entry: LibraryEntry, now = new Date()): LibraryCatalog {
	const entries = catalog.entries.map(canonicalLibraryEntry);
	const index = entries.findIndex((existing) => existing.repoRoot === entry.repoRoot);
	const refreshed: LibraryEntry = { ...canonicalLibraryEntry(entry), lastSeenAt: now.toISOString() };
	if (index >= 0) {
		// Dedup by repoRoot: keep the original addedAt, refresh the rest.
		refreshed.addedAt = entries[index]!.addedAt;
		entries[index] = refreshed;
	} else {
		entries.push(refreshed);
	}
	return { version: catalog.version === LIBRARY_VERSION ? LIBRARY_VERSION : catalog.version, entries };
}

/** Additive global-settings marker; project overlays must not satisfy it. */
export interface OnboardingSettings {
	discoveryOnboardingComplete?: boolean;
}

/** Only an explicit true satisfies the marker; false and absent do not. */
export function hasDiscoveryOnboardingMarker(settings: OnboardingSettings): boolean {
	return settings.discoveryOnboardingComplete === true;
}

/** Additive: returns a copy with the marker field set; never mutates. */
export function setDiscoveryOnboardingMarker<T extends OnboardingSettings>(settings: T, complete = true): T {
	return { ...settings, discoveryOnboardingComplete: complete };
}

/** Returns a copy with the marker field removed; never mutates. */
export function clearDiscoveryOnboardingMarker<T extends OnboardingSettings>(settings: T): T {
	const { discoveryOnboardingComplete: _removed, ...rest } = settings;
	void _removed;
	return rest as T;
}
