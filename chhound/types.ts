/** Shared types for pi-chhound. */

export const SETTINGS_VERSION = 1;

export interface EmbeddingSettings {
	provider?: string;
	model?: string;
	/** camelCase twin of chunkhound's `rerank_model`. */
	rerankModel?: string;
	/**
	 * v1 decision (user): API key IS persisted — in settings.json and
	 * materialized into .chunkhound.json (files chmod 0600). Optional: keep it in
	 * the shell env instead and leave this unset.
	 */
	apiKey?: string;
}

/** chunkhound `llm` section — enables the research tools (code_research/websearch/fetchurl). */
export interface LlmSettings {
	provider?: string;
	/** Defaults both utility + synthesis models in chunkhound. */
	model?: string;
	apiKey?: string;
}

export interface IndexingSettings {
	include?: string[];
	exclude?: string[];
	perFileTimeoutSeconds?: number;
	perFileTimeoutMinSizeKb?: number;
}

export interface BaselineSettings {
	/** Base ref (e.g. "main"). Default: repo default branch via refs/remotes/origin/HEAD. */
	ref?: string;
	/** Refresh baseline when older than this many days (default 1). */
	maxAgeDays?: number;
}

export interface ChhoundSettings {
	version: typeof SETTINGS_VERSION;
	embedding?: EmbeddingSettings;
	llm?: LlmSettings;
	indexing?: IndexingSettings;
	research?: Record<string, unknown>;
	baseline?: BaselineSettings;
	/** Override sandbox library root. Default: $XDG_STATE_HOME/pi-chhound/sandboxes. */
	sandboxRoot?: string;
	/** Override baseline cache root. Default: $XDG_CACHE_HOME/pi-chhound/bases. */
	baseRoot?: string;
}

export interface SandboxMeta {
	version: 1;
	/** Absolute worktree path. */
	worktree: string;
	/** Absolute repo root (recorded since v0.5 — absent in older metas). */
	repoRoot?: string;
	branch: string;
	baseRef: string;
	/** Commit the baseline was primed at. */
	baseCommit: string;
	chhoundVersion: string;
	createdAt: string;
	/** Baseline db dir this sandbox was copied from. */
	copiedFrom: string;
	/** Absolute duckdb dir path (database.path in the sandbox config). */
	dbPath: string;
}

export interface BaselineMeta {
	version: 1;
	/** Absolute repo root (recorded since v0.5 — absent in older metas). */
	repoRoot?: string;
	baseRef: string;
	baseCommit: string;
	chhoundVersion: string;
	updatedAt: string;
}

/**
 * Per-session extension state.
 * `apiKey` lives in module memory ONLY — never written to disk or session entries.
 */
export interface PluginState {
	apiKey?: string;
}
