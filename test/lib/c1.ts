/**
 * C1 shared fixture construction (Stream 2 spec v1.2 §§1-2), used by the
 * modular C1 test files (feature label c1). Construction only — every caller
 * owns its fixture root and cleanup; helper modules have no side effects at
 * import time. Call AFTER env isolation (the helpers only write files under
 * caller-owned roots, but the product code under test may read env roots).
 *
 * The planted "engine-shaped" config/db/sidecar files are discovery-only
 * fixtures: they are never opened by the engine (triage/fast-pass/deep-sweep
 * verdicts come from file shape + claim sidecars, per the C1 tests).
 *
 * Adapted verbatim from the C1 fixture block of scripts/smoke.ts @ 9576fb1
 * (draft PR #3) into per-scenario factories — the legacy block shared mutable
 * env + constants across all C1 sections; here each scenario owns its root.
 */
import fs from "node:fs";
import path from "node:path";
import type { LibraryEntry } from "../../chhound/library.js";
import type { DiscoveryCandidate } from "../../chhound/discovery.js";

/** Secret-shaped canary that must never appear in catalog/settings/issues. */
export const C1_CANARY = "sk-chcanary-C1-fixture";

/** Minimal engine-shaped config text: database.path + a canary embedding key. */
export function c1ConfigText(dbPath: string): string {
	return JSON.stringify({ database: { path: dbPath }, embedding: { api_key: C1_CANARY } }) + "\n";
}

export interface PlantedCandidate extends DiscoveryCandidate {
	configPath: string;
	dbPath: string;
	layout: "file" | "dir";
	sidecarRoot: string;
}

/**
 * Plant a discovery candidate: config (+ sidecar claim + tiny db seed) that
 * mirrors an engine-made layout. `layout: "file"` puts the config at
 * <repoRoot>/<name> with db <repoRoot>/.chunkhound.db; `layout: "dir"` puts
 * the config at <repoRoot>/.chunkhound/<name> with db
 * <repoRoot>/.chunkhound/chunks.db. The claim sidecar is written at
 * <dbPath>.root.json claiming `claimRoot` (defaults to repoRoot). Fixture
 * files are created 0600.
 */
export function plantCandidate(
	repoRoot: string,
	name: string,
	layout: "file" | "dir" = "file",
	claimRoot = repoRoot,
): PlantedCandidate {
	fs.mkdirSync(repoRoot, { recursive: true });
	const configPath = layout === "file" ? path.join(repoRoot, name) : path.join(repoRoot, ".chunkhound", name);
	const dbPath = layout === "file" ? path.join(repoRoot, ".chunkhound.db") : path.join(repoRoot, ".chunkhound", "chunks.db");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, c1ConfigText(dbPath), { mode: 0o600 });
	fs.writeFileSync(dbPath, "tiny duckdb seed", { mode: 0o600 });
	fs.writeFileSync(`${dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: claimRoot }) + "\n", { mode: 0o600 });
	return { repoRoot, configPath, dbPath, layout, sidecarRoot: claimRoot };
}

/** Default advisory LibraryEntry for a planted candidate (smoke-era c1Entry shape). */
export function c1EntryFrom(candidate: PlantedCandidate, extra: Partial<LibraryEntry> = {}): LibraryEntry {
	return {
		repoRoot: candidate.repoRoot,
		configPath: candidate.configPath,
		dbPath: candidate.dbPath,
		layout: candidate.layout,
		sidecarRoot: candidate.sidecarRoot,
		verdict: "adoptable",
		source: "fast-pass",
		addedAt: "2026-01-01T00:00:00.000Z",
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		...extra,
	};
}

/**
 * The three managed roots (sandbox/base/mirror cache dirs) that C1
 * containment tests exclude from discovery, mirroring the smoke-era
 * CHHOUND_SANDBOX_ROOT / CHHOUND_BASE_ROOT / CHHOUND_MIRROR_ROOT overrides.
 */
export function c1ManagedRoots(root: string): [string, string, string] {
	return [path.join(root, "managed-sandboxes"), path.join(root, "managed-bases"), path.join(root, "managed-mirrors")];
}
