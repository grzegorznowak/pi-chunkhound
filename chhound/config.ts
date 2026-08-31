import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./args.js";
import type { ChhoundSettings, EmbeddingSettings, IndexingSettings, LlmSettings } from "./types.js";

/**
 * Canonical chunkhound config filename (chunkhound config.py discovery: CLI
 * args > --config > local .chunkhound.json in the target dir > globals > env).
 * The old non-dotfile name was not auto-discoverable by the chunkhound CLI.
 */
export const CONFIG_FILE_NAME = ".chunkhound.json";

/** Sensible baseline exclusions (from chunkhound's own config, trimmed). */
export const DEFAULT_EXCLUDES = [
	"**/.git/**",
	"**/node_modules/**",
	"**/__pycache__/**",
	"**/venv/**",
	"**/.venv/**",
	"**/dist/**",
	"**/build/**",
	"**/target/**",
	"**/.vscode/**",
	"**/.idea/**",
	"**/*.min.js",
	"**/*.min.css",
	"**/package-lock.json",
	"**/yarn.lock",
];

/**
 * MANDATORY: the daemon writes <indexed-root>/.chhound/daemon.log (CURe fails
 * closed without this exclusion). Also covers any db/artifacts under .chhound/.
 */
export const CHHOUND_DIR_EXCLUDE = "**/.chhound/**";

export interface AdoptedConfig {
	embedding?: EmbeddingSettings;
	llm?: LlmSettings;
	indexing?: IndexingSettings;
	research?: Record<string, unknown>;
}

export interface AdoptResult {
	adopted: AdoptedConfig;
	warnings: string[];
}

export interface MaterializeOptions {
	settings: ChhoundSettings;
	/** Absolute path where the duckdb dir lives — pinned into database.path. */
	dbDir: string;
	/** Extra exclusion patterns (merged, deduped). */
	extraExcludes?: string[];
	/** Config adopted from an existing chunkhound.json (--config). */
	adopted?: AdoptedConfig;
	/** Extra top-level sections preserved from an existing config (research, custom keys). */
	preserve?: Record<string, unknown>;
}

function dedupe(items: string[]): string[] {
	return [...new Set(items.filter((i) => i && i.trim()))];
}

/**
 * Read + validate an existing chunkhound.json / .chhound.json and fold it into
 * settings-shaped blocks. Secrets (api_key) are stripped with a warning.
 */
export function adoptConfigFile(file: string, cwd: string): AdoptResult {
	const warnings: string[] = [];
	const abs = path.resolve(cwd, file);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(abs, "utf8"));
	} catch (err) {
		throw new Error(`Could not read config ${abs}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof raw !== "object" || raw === null) throw new Error(`Config ${abs} is not a JSON object`);
	const obj = raw as Record<string, unknown>;
	const adopted: AdoptedConfig = {};

	const emb = obj.embedding as Record<string, unknown> | undefined;
	if (emb && typeof emb === "object") {
		const e: EmbeddingSettings = {};
		if (typeof emb.provider === "string") e.provider = emb.provider;
		if (typeof emb.model === "string") e.model = emb.model;
		if (typeof emb.rerank_model === "string") e.rerankModel = emb.rerank_model;
		if (typeof emb.api_key === "string" && emb.api_key) {
			e.apiKey = emb.api_key;
			warnings.push("embedding.api_key adopted — stored in settings.json and materialized .chunkhound.json (0600).");
		}
		if (Object.keys(e).length > 0) adopted.embedding = e;
	}

	const llm = obj.llm as Record<string, unknown> | undefined;
	if (llm && typeof llm === "object") {
		const l: LlmSettings = {};
		if (typeof llm.provider === "string") l.provider = llm.provider;
		if (typeof llm.model === "string") l.model = llm.model;
		if (typeof llm.api_key === "string" && llm.api_key) {
			l.apiKey = llm.api_key;
			warnings.push("llm.api_key adopted — stored in settings.json and materialized .chunkhound.json (0600).");
		}
		if (Object.keys(l).length > 0) adopted.llm = l;
	}

	const idx = obj.indexing as Record<string, unknown> | undefined;
	if (idx && typeof idx === "object") {
		const i: IndexingSettings = {};
		if (Array.isArray(idx.include) && idx.include.every((v) => typeof v === "string")) i.include = idx.include as string[];
		if (Array.isArray(idx.exclude) && idx.exclude.every((v) => typeof v === "string")) i.exclude = idx.exclude as string[];
		if (typeof idx.per_file_timeout_seconds === "number") i.perFileTimeoutSeconds = idx.per_file_timeout_seconds;
		if (typeof idx.per_file_timeout_min_size_kb === "number") i.perFileTimeoutMinSizeKb = idx.per_file_timeout_min_size_kb;
		if (Object.keys(i).length > 0) adopted.indexing = i;
	}

	if (obj.research && typeof obj.research === "object") adopted.research = obj.research as Record<string, unknown>;
	if (obj.database && typeof obj.database === "object") {
		warnings.push("database block ignored — pi-chhound pins the duckdb path per sandbox/baseline.");
	}
	return { adopted, warnings };
}

/** Fold an adopted config into settings (used by /ch-setup --config). */
export function foldAdoptedInto(settings: ChhoundSettings, adopted: AdoptedConfig): ChhoundSettings {
	const next: ChhoundSettings = { ...settings };
	if (adopted.embedding) next.embedding = { ...(settings.embedding ?? {}), ...adopted.embedding };
	if (adopted.llm) next.llm = { ...(settings.llm ?? {}), ...adopted.llm };
	if (adopted.indexing) next.indexing = { ...(settings.indexing ?? {}), ...adopted.indexing };
	if (adopted.research) next.research = { ...(settings.research ?? {}), ...adopted.research };
	return next;
}

function embeddingBlock(settings: ChhoundSettings): Record<string, unknown> | undefined {
	const e = settings.embedding;
	if (!e || (!e.provider && !e.model && !e.rerankModel && !e.apiKey)) return undefined;
	const out: Record<string, unknown> = {};
	if (e.provider) out.provider = e.provider;
	if (e.model) out.model = e.model;
	if (e.rerankModel) out.rerank_model = e.rerankModel;
	if (e.apiKey) out.api_key = e.apiKey;
	return out;
}

function llmBlock(settings: ChhoundSettings): Record<string, unknown> | undefined {
	const l = settings.llm;
	if (!l || (!l.provider && !l.model && !l.apiKey)) return undefined;
	const out: Record<string, unknown> = {};
	if (l.provider) out.provider = l.provider;
	if (l.model) out.model = l.model;
	if (l.apiKey) out.api_key = l.apiKey;
	return out;
}

/**
 * Materialize a chunkhound.json into `dir`. Never contains api_key; the duckdb
 * path is pinned absolute to `dbDir`; the .chhound exclusion pattern is guaranteed.
 * Returns the config file path.
 */
export function materializeConfig(dir: string, opts: MaterializeOptions): string {
	const settings = opts.settings;
	const idx = settings.indexing ?? {};
	const excludes = dedupe([
		...DEFAULT_EXCLUDES,
		...(idx.exclude ?? []),
		...(opts.adopted?.indexing?.exclude ?? []),
		...(opts.extraExcludes ?? []),
		CHHOUND_DIR_EXCLUDE,
	]);

	const indexing: Record<string, unknown> = {
		exclude: excludes,
		...(idx.include ? { include: idx.include } : {}),
		...(opts.adopted?.indexing?.include ? { include: [...(idx.include ?? []), ...opts.adopted.indexing.include] } : {}),
		...(idx.perFileTimeoutSeconds !== undefined ? { per_file_timeout_seconds: idx.perFileTimeoutSeconds } : {}),
		...(idx.perFileTimeoutMinSizeKb !== undefined ? { per_file_timeout_min_size_kb: idx.perFileTimeoutMinSizeKb } : {}),
	};

	const config: Record<string, unknown> = {
		...(embeddingBlock(settings) ? { embedding: embeddingBlock(settings) } : {}),
		...(llmBlock(settings) ? { llm: llmBlock(settings) } : {}),
		indexing,
		database: { provider: "duckdb", path: opts.dbDir },
		...(opts.preserve ?? {}),
	};
	const adoptedResearch = opts.adopted?.research ?? settings.research;
	if (adoptedResearch && Object.keys(adoptedResearch).length > 0) config.research = adoptedResearch;

	const p = path.join(dir, CONFIG_FILE_NAME);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
	// May contain the api key (v1) — restrict access.
	fs.chmodSync(p, 0o600);
	// Self-heal: remove the legacy non-dotfile name if a previous run wrote it.
	fs.rmSync(path.join(dir, "chhound.json"), { force: true });
	return p;
}

/** Materialize a throwaway config into a temp dir (for --verify preflight). Returns dir for cleanup. */
export function materializeTempConfig(settings: ChhoundSettings): { configPath: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-verify-"));
	const configPath = materializeConfig(dir, { settings, dbDir: path.join(dir, ".chhound.db") });
	return { configPath, dir };
}

/** Convenience: parse `--config <file>` out of raw command args. */
export function configFileFromArgs(args: string, cwd: string): AdoptResult | undefined {
	const parsed = parseArgs(args);
	const file = parsed.flags["config"];
	if (typeof file !== "string" || !file) return undefined;
	return adoptConfigFile(file, cwd);
}
