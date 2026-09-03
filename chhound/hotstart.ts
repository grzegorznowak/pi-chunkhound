import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
 * (`<db>.root.json`) holding `{"version": 1, "indexed_root_path": <root>}`.
 * Our dbs are copied/moved between roots by design, so before every engine
 * run we re-point the claim at the root we are about to index — see
 * writeIndexedRootClaim. Pre-writing the claim (instead of deleting it and
 * letting chunkhound re-claim) keeps the engine out of its legacy-DB
 * migration path, which would log a warning on every run.
 */
export function indexedRootSidecarPath(dbDir: string): string {
	return `${dbDir}.root.json`;
}

/** Claim value chunkhound would compute for `indexDir` (resolve + posix). */
function engineClaimValue(indexDir: string): string {
	return path.resolve(indexDir).split(path.sep).join("/");
}

/**
 * Re-point (or confirm) the claim sidecar of `dbDir` to `indexDir`, in the
 * engine's exact format and normalization. No-op when the sidecar already
 * claims the same root; otherwise rewritten atomically (tmp + rename). The
 * engine then sees a present + matching sidecar on open and stays silent —
 * while its fail-closed mismatch guard keeps protecting genuinely foreign
 * dbs (a sidecar claiming a DIFFERENT root still refuses the open).
 */
export function writeIndexedRootClaim(dbDir: string, indexDir: string): void {
	const sidecar = indexedRootSidecarPath(dbDir);
	const want = engineClaimValue(indexDir);
	try {
		const raw = fs.readFileSync(sidecar, "utf8");
		const data: unknown = JSON.parse(raw);
		if (
			typeof data === "object" &&
			data !== null &&
			(data as { indexed_root_path?: unknown }).indexed_root_path === want
		) {
			return;
		}
	} catch {
		// missing or unreadable — (re)write below
	}
	fs.mkdirSync(path.dirname(sidecar), { recursive: true });
	const tmp = `${sidecar}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, indexed_root_path: want }), "utf8");
		fs.renameSync(tmp, sidecar);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * Copy a directory tree `src` → `dst`, preferring a copy-on-write (reflink)
 * clone: Linux `cp -R --reflink=always` (btrfs/XFS/OpenZFS ≥2.2 — exit 0 ⇔
 * every file was cloned; nonzero on unsupported fs / cross-device), macOS
 * `cp -c -R` (APFS clonefile — silently degrades to a full copy per file by
 * design, always exit 0, best-effort). Windows / other platforms, plus
 * CHHOUND_COPY_FORCE=1, skip the attempt entirely — the env var doubles as
 * the deterministic smoke seam for the plain-copy path.
 *
 * Failure semantics: the clone lands in a SIBLING tmp dir (same fs → the
 * promotion rename is atomic). A refused clone (unsupported fs — the routine
 * case on ext4 and overlayfs — cross-device, missing cp, killed child)
 * removes the tmp and falls back to the plain fs.cpSync recursive copy, the
 * exact previous behavior including its own failure profile. A real I/O
 * failure removes the tmp and rethrows.
 *
 * A pre-existing dst (retry after a failed run) is replaced rather than
 * merged: a previous FILE is overwritten atomically by the promotion rename
 * (rename(2) replaces files without a gap); a previous DIRECTORY is first
 * renamed aside to a `.cow-bak` sibling and only deleted after the new tree
 * is promoted, so a crash mid-swap leaves the prior db recoverable in the
 * bak (and the next run heals dst from scratch). Crash residue (tmp/bak
 * siblings, or a missing dst between the two renames) is swept at the start
 * of the next run — this function is the single writer for a given dst, so
 * stale siblings are always ours.
 */
export function copyTreeCoW(src: string, dst: string): void {
	// Overlap would corrupt or self-copy (this function is the single writer
	// for a given dst, so refuse rather than guess). A SHAPE mismatch is also
	// refused: the old plain copy (and cp(1)) refuse dir→file, and file→dir
	// would silently copy INTO the dir — neither is ever legit here (src and
	// dst derive from the same engine layout: a duckdb file, possibly a tree).
	const s = path.resolve(src);
	const d = path.resolve(dst);
	if (s === d || d.startsWith(s + path.sep) || s.startsWith(d + path.sep)) {
		throw new Error(`copyTreeCoW: source and destination overlap (${src} vs ${dst})`);
	}
	let srcIsDir: boolean;
	let dstIsDir: boolean;
	try {
		srcIsDir = fs.statSync(src).isDirectory();
	} catch {
		throw new Error(`copyTreeCoW: source does not exist: ${src}`);
	}
	try {
		dstIsDir = fs.statSync(dst).isDirectory();
	} catch {
		dstIsDir = false; // absent — will be created by the copy
	}
	if (dstIsDir !== srcIsDir && fs.existsSync(dst)) {
		throw new Error(`copyTreeCoW: source/destination shape mismatch (${src} is ${srcIsDir ? "a directory" : "a file"}, ${dst} is ${dstIsDir ? "a directory" : "not a directory"})`);
	}
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	// Sweep crash residue from a previous run for this dst (single-writer).
	const base = path.basename(dst);
	for (const name of fs.readdirSync(path.dirname(dst))) {
		if (name.startsWith(`${base}.`) && (name.endsWith(".cow-tmp") || name.endsWith(".cow-bak"))) {
			fs.rmSync(path.join(path.dirname(dst), name), { recursive: true, force: true });
		}
	}
	const plainCopy = () => fs.cpSync(src, dst, { recursive: true, force: true });
	if (process.env.CHHOUND_COPY_FORCE === "1" || (process.platform !== "linux" && process.platform !== "darwin")) {
		plainCopy();
		return;
	}
	const stamp = `${process.pid}.${Date.now()}`;
	const tmp = `${dst}.${stamp}.cow-tmp`;
	const bak = `${dst}.${stamp}.cow-bak`;
	try {
		const args = process.platform === "darwin" ? ["-c", "-R"] : ["-R", "--reflink=always"];
		const r = spawnSync("cp", [...args, src, tmp], { stdio: ["ignore", "ignore", "pipe"] });
		if (r.error || r.status !== 0) {
			// Clone refused — silent by design (routine on non-reflink fs): the
			// plain copy below is today's behavior.
			fs.rmSync(tmp, { recursive: true, force: true });
			plainCopy();
			return;
		}
		if (!fs.existsSync(dst)) {
			fs.renameSync(tmp, dst);
			return;
		}
		if (!srcIsDir) {
			// File over file: the rename atomically replaces the previous db —
			// no backup dance needed (rename(2) never leaves dst missing).
			fs.renameSync(tmp, dst);
			return;
		}
		// Whole-dir replace via bak: dst stays recoverable until promotion wins.
		fs.renameSync(dst, bak);
		try {
			fs.renameSync(tmp, dst);
		} catch (e) {
			try {
				fs.renameSync(bak, dst);
			} catch {
				/* dst missing until the next run re-copies — heal, don't half-restore */
			}
			throw e;
		}
		fs.rmSync(bak, { recursive: true, force: true });
	} catch (e) {
		fs.rmSync(tmp, { recursive: true, force: true });
		throw e;
	}
}

export async function hotStartIndex(opts: HotStartOptions): Promise<HotStartResult> {
	let copied = false;
	if (opts.forceReindex) {
		// Explicit full rebuild: drop the target and index with --force-reindex.
		if (fs.existsSync(opts.targetDbDir)) fs.rmSync(opts.targetDbDir, { recursive: true, force: true });
	} else if (opts.sourceDbDir && fs.existsSync(opts.sourceDbDir)) {
		// CURe-style spin-up: low-level copy of the baseline db, then top-up index.
		// CoW/reflink clone when the fs supports it (tmp + atomic rename — a
		// failed clone falls back to the plain recursive copy); see copyTreeCoW.
		copyTreeCoW(opts.sourceDbDir, opts.targetDbDir);
		copied = true;
		// Re-key copied rows to the checkout subtree (see pathPrefix above).
		if (opts.pathPrefix) await rekeyCopiedDbPaths(opts.targetDbDir, opts.pathPrefix);
	}
	// Claim the target db for THIS root before the engine ever opens it:
	// pre-writing the sidecar (re-point when stale) keeps chunkhound out of
	// its legacy-DB migration path — which would warn on every run — while
	// the engine's own mismatch guard stays fully active.
	writeIndexedRootClaim(opts.targetDbDir, opts.indexDir);

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
