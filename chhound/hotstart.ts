import * as fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { enginePython, runChhound } from "./cli.js";

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
	/**
	 * Relative POSIX path (no slashes at the ends) of the checkout subtree under
	 * indexDir (e.g. "fix-smoke"). When set AND the db is copied from a source
	 * whose `files.path` rows are relative to the SUBTREE root (a baseline built
	 * from a bare checkout), the copied rows are re-keyed with this prefix so
	 * the engine's unchanged-detection (keyed by relative path) matches — chunks
	 * and embeddings survive the top-up instead of a full re-parse + re-embed.
	 */
	pathPrefix?: string;
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
 * Best-effort re-key of a freshly copied db: prefix `files.path` rows so the
 * engine's unchanged-detection (keyed by relative path) matches files that the
 * top-up discovers under indexDir/<prefix>. Silent no-op when the engine's
 * python is unresolvable or the patch fails — the top-up then degrades to a
 * full re-parse (correct, just slower/more spend).
 */
async function rekeyCopiedDbPaths(dbPath: string, prefix: string): Promise<void> {
	const py = enginePython();
	if (!py) return;
	// duckdb cannot UPDATE files.path (UNIQUE) on rows with child chunks (its
	// UPDATE is delete+insert and FKs are eager, non-disableable) and cannot
	// DELETE a referenced row in the same transaction as the repoint. So:
	// insert a copy of each row with the prefixed path, repoint referencing
	// FKs (chunks.file_id) to the copy, and leave the old rows orphaned — the
	// engine's own cleanup deletes rows whose path is absent from the new
	// index at the end of the top-up.
	const script = [
		"import duckdb, sys, re",
		"db, prefix = sys.argv[1], sys.argv[2] + '/'",
		"con = duckdb.connect(db)",
		"try:",
		"    con.execute('BEGIN')",
		"    refs = []",
		"    for t, txt in con.execute(\"select table_name, constraint_text from duckdb_constraints() where constraint_type = 'FOREIGN KEY'\").fetchall():",
		"        m = re.match(r'FOREIGN KEY \\((\\w+)\\) REFERENCES files\\((\\w+)\\)', txt or '')",
		"        if m and m.group(2) == 'id':",
		"            refs.append((t, m.group(1)))",
		"    rows = con.execute('select id from files where not starts_with(path, ?)', [prefix]).fetchall()",
		"    for (old_id,) in rows:",
		"        new_id = con.execute(",
		"            'INSERT INTO files (path,name,extension,size,modified_time,content_hash,language,skip_reason,created_at,updated_at) '",
		"            + 'SELECT concat(?, path), name, extension, size, modified_time, content_hash, language, skip_reason, created_at, updated_at FROM files WHERE id = ? RETURNING id',",
		"            [prefix, old_id]).fetchone()[0]",
		"        for tbl, col in refs:",
		"            con.execute(f'UPDATE \"{tbl}\" SET \"{col}\" = ? WHERE \"{col}\" = ?', [new_id, old_id])",
		"    con.execute('COMMIT')",
		"    con.close()",
		"except Exception as e:",
		"    print('path re-key failed: %s' % e, file=sys.stderr)",
		"    sys.exit(2)",
	].join("\n");
	await new Promise<void>((resolve) => {
		const child = spawn(py, ["-c", script, dbPath, prefix], { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (d: Buffer) => (err += d.toString()));
		child.on("error", () => resolve());
		child.on("close", (code) => {
			if (code !== 0 && err) console.error(`pi-chhound: baseline path re-key failed — top-up will re-parse: ${err.trim().slice(0, 300)}`);
			resolve();
		});
	});
}

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
		// Re-key copied rows to the checkout subtree (see pathPrefix above).
		if (opts.pathPrefix) await rekeyCopiedDbPaths(opts.targetDbDir, opts.pathPrefix);
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
