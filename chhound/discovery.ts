/*
 * RED-phase C1 scaffolds. These signatures are driven by the modular C1
 * test files (test, feature label c1); implementation lands in the green
 * iteration.
 */
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
/** Re-triage an advisory catalog entry at use time; undefined means drop it. */
export async function retriageEntry(_entry: LibraryEntry, _options: DiscoveryOptions = {}): Promise<TriageResult | undefined> { throw new Error("RED shell (C1): retriageEntry not implemented — green next"); }
/** Only a current non-adoptable result is eligible for the tier-3 size question. */
export function sizeAskEligible(_result: TriageResult | undefined): boolean { throw new Error("RED shell (C1): sizeAskEligible not implemented — green next"); }
export async function triage(_candidate: DiscoveryCandidate, _options: DiscoveryOptions = {}): Promise<TriageResult> { throw new Error("RED shell (C1): triage not implemented — green next"); }
export async function fastPass(_repoRoot: string, _sessionCwd: string, _options: DiscoveryOptions = {}): Promise<DiscoveryCandidate[]> { throw new Error("RED shell (C1): fastPass not implemented — green next"); }
export async function deepSweep(_root: string, _options: DiscoveryOptions = {}): Promise<SweepResult> { throw new Error("RED shell (C1): deepSweep not implemented — green next"); }
export function isManagedContainment(_candidate: DiscoveryCandidate, _managedRoots: string[]): boolean { throw new Error("RED shell (C1): isManagedContainment not implemented — green next"); }
/** Return the first adoptable candidate in discovery fixed-spot order. */
export function selectAdoptable(_candidates: DiscoveryCandidate[], _triaged: TriageResult[]): DiscoveryCandidate | undefined { throw new Error("RED shell (C1): selectAdoptable not implemented — green next"); }
export async function runSetupDiscovery(_deps: SetupDeps, _options: SetupDiscoveryOptions = {}): Promise<SweepResult> { throw new Error("RED shell (C1): runSetupDiscovery not implemented — green next"); }
