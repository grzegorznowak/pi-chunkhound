/*
 * RED-phase C1 scaffolds. These signatures are driven by the modular C1
 * test files (test, feature label c1); implementation lands in the green
 * iteration.
 */
import type { Verdict } from "./discovery.js";

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

export function libraryPath(): string { throw new Error("RED shell (C1): libraryPath not implemented — green next"); }
export async function readLibrary(_options: LibraryOptions = {}): Promise<LibraryReadResult> { throw new Error("RED shell (C1): readLibrary not implemented — green next"); }
export async function writeLibrary(_catalog: LibraryCatalog, _options: LibraryOptions = {}): Promise<void> { throw new Error("RED shell (C1): writeLibrary not implemented — green next"); }
/** Lock, read/merge, then atomically write one advisory entry. */
export async function upsertLibraryEntry(_entry: LibraryEntry, _options: LibraryOptions = {}): Promise<LibraryCatalog> { throw new Error("RED shell (C1): upsertLibraryEntry not implemented — green next"); }
export function mergeLibraryEntry(_catalog: LibraryCatalog, _entry: LibraryEntry, _now = new Date()): LibraryCatalog { throw new Error("RED shell (C1): mergeLibraryEntry not implemented — green next"); }
export async function withLibraryLock<T>(_fn: () => Promise<T>, _options: LibraryOptions = {}): Promise<T> { throw new Error("RED shell (C1): withLibraryLock not implemented — green next"); }

/** Additive global-settings marker; project overlays must not satisfy it. */
export interface OnboardingSettings { discoveryOnboardingComplete?: boolean; }
export function hasDiscoveryOnboardingMarker(_settings: OnboardingSettings): boolean { throw new Error("RED shell (C1): hasDiscoveryOnboardingMarker not implemented — green next"); }
export function setDiscoveryOnboardingMarker<T extends OnboardingSettings>(_settings: T, _complete = true): T { throw new Error("RED shell (C1): setDiscoveryOnboardingMarker not implemented — green next"); }
export function clearDiscoveryOnboardingMarker<T extends OnboardingSettings>(_settings: T): T { throw new Error("RED shell (C1): clearDiscoveryOnboardingMarker not implemented — green next"); }
