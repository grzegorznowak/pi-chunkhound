import * as fs from "node:fs";
import path from "node:path";
import { runChhound } from "./cli.js";

export interface HotStartOptions {
	/** Baseline duckdb dir to low-level copy; null/undefined → fresh index. */
	sourceDbDir?: string | null;
	/** Target duckdb dir — must match database.path in the materialized config. */
	targetDbDir: string;
	/** Directory to index. */
	indexDir: string;
	configPath: string;
	cwd?: string;
	forceReindex?: boolean;
	env?: Record<string, string | undefined>;
	onLine?: (line: string) => void;
	signal?: AbortSignal;
	/** Pass --verbose to chunkhound so it emits "Processing batch X/N" stderr lines (default true). */
	verbose?: boolean;
	/** Extra chunkhound index args (e.g. --no-embeddings in smoke tests). */
	extraArgs?: string[];
}

export interface HotStartResult {
	code: number;
	/** True when the db was copied from a source (top-up run). */
	copied: boolean;
	dbExists: boolean;
	/** Tail of captured stderr (for error surfacing). */
	stderrTail: string;
}

/**
 * CURe-style spin-up: low-level copy of the baseline duckdb (a DIRECTORY —
 * copy everything incl. .wal), then `chhound index` as an incremental top-up.
 * No source → plain (or forced) full index.
 */
/**
 * ChunkHound claims a duckdb dir for an indexed root via a sibling sidecar
 * (`<db>.root.json`). Our dbs are copied/moved between roots by design, so we
 * always clear the stale claim before indexing — chunkhound re-claims fresh.
 */
export function indexedRootSidecarPath(dbDir: string): string {
	return `${dbDir}.root.json`;
}

export async function hotStartIndex(opts: HotStartOptions): Promise<HotStartResult> {
	let copied = false;
	fs.rmSync(indexedRootSidecarPath(opts.targetDbDir), { force: true });
	if (opts.forceReindex) {
		// Explicit full rebuild: drop the target and index with --force-reindex.
		if (fs.existsSync(opts.targetDbDir)) fs.rmSync(opts.targetDbDir, { recursive: true, force: true });
	} else if (opts.sourceDbDir && fs.existsSync(opts.sourceDbDir)) {
		// CURe-style spin-up: low-level copy of the baseline db, then top-up index.
		fs.mkdirSync(path.dirname(opts.targetDbDir), { recursive: true });
		fs.cpSync(opts.sourceDbDir, opts.targetDbDir, { recursive: true, force: true });
		copied = true;
	}
	// No source: plain index — incremental top-up in place when the db exists, fresh otherwise.

	const args = ["index", opts.indexDir, "--config", opts.configPath];
	if (opts.forceReindex) args.push("--force-reindex");
	// --verbose makes chunkhound emit "Processing batch X/N" progress lines on
	// stderr (the only real per-batch signal during embedding generation).
	if (opts.verbose !== false) args.push("--verbose");
	if (opts.extraArgs) args.push(...opts.extraArgs);
	const r = await runChhound(args, {
		cwd: opts.cwd ?? opts.indexDir,
		env: opts.env,
		onLine: opts.onLine,
		signal: opts.signal,
	});
	return { code: r.code, copied, dbExists: fs.existsSync(opts.targetDbDir), stderrTail: r.stderr.slice(-2000) };
}
