import { describe, test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyAdoptedIndex } from "../../chhound/adoption.js";
import { enginePython } from "../../chhound/cli.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: C2 RED-first scenarios (feature label c2) encoding the
// adoption-copy obligations of the Stream-2 spec v1.2 §3.3 (LAYOUT
// NORMALIZATION: file- and dir-shaped sources land as a real duckdb file +
// its sibling .root.json copied separately; the slot stays file-shaped;
// revalidate config/claim + actual-file identity BEFORE copy; copy via
// copyTreeCoW with a same-device check — plain copy + EXPLICIT size warning
// cross-device; revalidate AFTER copy; fail closed → clean target, no meta)
// plus the test-design group 7 "copy/layout/identity" (healthy result
// file-shaped slot + sibling claim; mutate config/claim and replace/change
// DB independently before/after copy barriers → reject; source
// SHA256/dev/ino/size/mtime unchanged; target edits independent; forced
// plain-copy checks bytes; injected sameDevice=false checks the warning).
// chhound/adoption.ts is a C2 module and does not exist yet — this file is
// the RED encoding; the green pass implements it. Scenario titles and leaf
// names below are the inventory identity: keep verbatim in every future
// commit. Env: fake HOME; engine binary resolved BEFORE env isolation and
// re-injected via CHHOUND_BINARY so enginePython() yields the engine venv
// python (duckdb) for the real db seeds. Canonical source-layout names used
// by the fixtures (discovery fixed spots): file = <root>/.chunkhound.json +
// <root>/.chunkhound.db; dir = <root>/.chunkhound/config.json +
// <root>/.chunkhound/chunks.db; sidecar = <db>.root.json.

function pythonScript(...lines: string[]): string {
	return lines.join("\n");
}

// One-shot python run; resolves with its exit code (null on spawn error).
function runPython(py: string, script: string, args: string[]): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(py, ["-c", script, ...args], { stdio: ["ignore", "ignore", "ignore"] });
		child.on("error", () => resolve(null));
		child.on("exit", (code) => resolve(code));
	});
}

async function makeSeedDb(py: string, dbPath: string): Promise<void> {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const script = pythonScript(
		"import duckdb, sys",
		"c = duckdb.connect(sys.argv[1])",
		"c.execute('create table t (i integer)')",
		"c.execute('insert into t values (1),(2),(3)')",
		"c.close()",
	);
	const code = await runPython(py, script, [dbPath]);
	if (code !== 0) throw new Error(`seed db creation failed with exit ${code}`);
}

function contentSha256(p: string): string | null {
	try {
		if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
		return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
	} catch {
		return null;
	}
}

function statSafe(p: string): fs.Stats | null {
	try {
		return fs.statSync(p);
	} catch {
		return null;
	}
}

// Parsed claim or undefined (missing/malformed — leaf-safe).
function readClaim(p: string): { version?: number; indexed_root_path?: string; raw: string } | undefined {
	if (!fs.existsSync(p)) return undefined;
	try {
		const raw = fs.readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as { version?: number; indexed_root_path?: string };
		return { version: parsed.version, indexed_root_path: parsed.indexed_root_path, raw };
	} catch {
		return undefined;
	}
}

// Identity + content shape; null when the file is absent or unreadable (leaf-safe).
function fileShape(p: string): { dev: number; ino: number; size: number; mtimeMs: number; sha256: string | null; isFile: boolean } | null {
	const s = statSafe(p);
	if (!s) return null;
	return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, sha256: contentSha256(p), isFile: s.isFile() };
}

function writeConfig(configPath: string, dbPath: string): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ database: { provider: "duckdb", path: dbPath } }), { mode: 0o600 });
}

// File-shaped source: <root>/.chunkhound.json + <root>/.chunkhound.db + claim.
async function plantFileSource(py: string, root: string): Promise<{ root: string; configPath: string; dbPath: string }> {
	const configPath = path.join(root, ".chunkhound.json");
	const dbPath = path.join(root, ".chunkhound.db");
	await makeSeedDb(py, dbPath);
	fs.writeFileSync(`${dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: root }), { mode: 0o600 });
	writeConfig(configPath, dbPath);
	return { root, configPath, dbPath };
}

// Dir-shaped source: <root>/.chunkhound/config.json + <root>/.chunkhound/chunks.db + claim.
async function plantDirSource(py: string, root: string): Promise<{ root: string; configPath: string; dbPath: string }> {
	const configPath = path.join(root, ".chunkhound", "config.json");
	const dbPath = path.join(root, ".chunkhound", "chunks.db");
	await makeSeedDb(py, dbPath);
	fs.writeFileSync(`${dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: root }), { mode: 0o600 });
	writeConfig(configPath, dbPath);
	return { root, configPath, dbPath };
}

// Entries in the target dir whose name starts with the target db basename (db, sidecar, tmp, bak).
function targetResidue(targetDbPath: string): string[] {
	const dir = path.dirname(targetDbPath);
	try {
		const base = path.basename(targetDbPath);
		return fs.readdirSync(dir).filter((name) => name.startsWith(base));
	} catch {
		return [];
	}
}

// Same identity and bytes as captured before the copy (dev/ino/size/mtime/sha256).
function unchanged(shape: NonNullable<ReturnType<typeof fileShape>>, p: string): boolean {
	const now = fileShape(p);
	if (!now) return false;
	return (
		now.dev === shape.dev &&
		now.ino === shape.ino &&
		now.size === shape.size &&
		now.mtimeMs === shape.mtimeMs &&
		now.sha256 === shape.sha256
	);
}

describe("c2 adoption copy", () => {
	test("C2 adoption copy: file- and dir-shaped sources land as a file-shaped slot with its sibling claim", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-copy-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			// File-shaped source.
			const fileRoot = path.join(root, "file-repo");
			const fileSource = await plantFileSource(py, fileRoot);
			const fileDbBefore = fileShape(fileSource.dbPath);
			const fileConfigBefore = fileShape(fileSource.configPath);
			const fileClaimBefore = fileShape(`${fileSource.dbPath}.root.json`);
			const fileTarget = path.join(root, "slots", "file", ".chunkhound.db");

			const fileOutcome = await copyAdoptedIndex(
				{ configPath: fileSource.configPath, dbPath: fileSource.dbPath, expectedRoot: fileRoot },
				{ targetDbPath: fileTarget },
			);
			await check(
				t,
				"C2 file-shaped source copies into a file-shaped slot with its sibling claim",
				fileOutcome.kind === "copied" &&
					fileShape(fileTarget)?.isFile === true &&
					readClaim(`${fileTarget}.root.json`) !== undefined,
			);
			await check(
				t,
				"C2 the slot db is byte-identical to the source db",
				contentSha256(fileTarget) === (fileDbBefore ? fileDbBefore.sha256 : null),
			);
			const fileClaim = readClaim(`${fileTarget}.root.json`);
			const sourceClaim = readClaim(`${fileSource.dbPath}.root.json`);
			await check(
				t,
				"C2 the slot sidecar equals the source claim (version 1, same root, same bytes)",
				fileClaim?.version === 1 && fileClaim.indexed_root_path === fileRoot && fileClaim.raw === sourceClaim?.raw,
			);
			await check(t, "C2 same-device copy surfaces no warning", fileOutcome.kind === "copied" && fileOutcome.warnings.length === 0);

			// Dir-shaped source normalizes the same way.
			const dirRoot = path.join(root, "dir-repo");
			const dirSource = await plantDirSource(py, dirRoot);
			const dirDbBefore = fileShape(dirSource.dbPath);
			const dirConfigBefore = fileShape(dirSource.configPath);
			const dirClaimBefore = fileShape(`${dirSource.dbPath}.root.json`);
			const dirTarget = path.join(root, "slots", "dir", ".chunkhound.db");
			const dirOutcome = await copyAdoptedIndex(
				{ configPath: dirSource.configPath, dbPath: dirSource.dbPath, expectedRoot: dirRoot },
				{ targetDbPath: dirTarget },
			);
			await check(
				t,
				"C2 dir-shaped source normalizes to a file-shaped slot with its sibling claim",
				dirOutcome.kind === "copied" &&
					fileShape(dirTarget)?.isFile === true &&
					readClaim(`${dirTarget}.root.json`) !== undefined,
			);
			await check(
				t,
				"C2 the dir-shaped slot db is byte-identical to its source db",
				contentSha256(dirTarget) === (dirDbBefore ? dirDbBefore.sha256 : null),
			);
			const dirClaim = readClaim(`${dirTarget}.root.json`);
			const dirSourceClaim = readClaim(`${dirSource.dbPath}.root.json`);
			await check(
				t,
				"C2 the dir-shaped slot sidecar equals the source claim",
				dirClaim?.version === 1 &&
					dirClaim.indexed_root_path === dirRoot &&
					dirClaim.raw === dirSourceClaim?.raw,
			);

			// Sources untouched: identity (dev/ino) + size + mtime + sha256 on
			// db, config and claim of BOTH shapes.
			await check(
				t,
				"C2 the file-source db, config and claim keep their identity and bytes",
				!!fileDbBefore &&
					!!fileConfigBefore &&
					!!fileClaimBefore &&
					unchanged(fileDbBefore, fileSource.dbPath) &&
					unchanged(fileConfigBefore, fileSource.configPath) &&
					unchanged(fileClaimBefore, `${fileSource.dbPath}.root.json`),
			);
			await check(
				t,
				"C2 the dir-source db, config and claim keep their identity and bytes",
				!!dirDbBefore &&
					!!dirConfigBefore &&
					!!dirClaimBefore &&
					unchanged(dirDbBefore, dirSource.dbPath) &&
					unchanged(dirConfigBefore, dirSource.configPath) &&
					unchanged(dirClaimBefore, `${dirSource.dbPath}.root.json`),
			);
			fs.mkdirSync(path.dirname(fileTarget), { recursive: true });
			fs.writeFileSync(fileTarget, "slot-side edit");
			await check(
				t,
				"C2 editing the slot db leaves the source byte-identical",
				contentSha256(fileSource.dbPath) === (fileDbBefore ? fileDbBefore.sha256 : null),
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 adoption copy: source drift between validation and copy rejects fail-closed", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-drift-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			// Case 1: config swapped for garbage between validation and copy.
			{
				const source = await plantFileSource(py, path.join(root, "case-config", "repo"));
				const targetDbPath = path.join(root, "case-config", "slots", "slot", ".chunkhound.db");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase === "beforeCopy") fs.writeFileSync(source.configPath, "{not json");
						},
					},
				);
				await check(
					t,
					"C2 a config replaced between validation and copy rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0,
				);
			}

			// Case 2: claim swapped for a different root between validation and copy.
			{
				const source = await plantFileSource(py, path.join(root, "case-claim", "repo"));
				const targetDbPath = path.join(root, "case-claim", "slots", "slot", ".chunkhound.db");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase === "beforeCopy")
								fs.writeFileSync(`${source.dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: "/elsewhere" }));
						},
					},
				);
				await check(
					t,
					"C2 a claim replaced between validation and copy rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0,
				);
			}

			// Case 3: db replaced by another file with IDENTICAL bytes and mtime —
			// only the inode differs, proving actual-file identity revalidation.
			{
				const source = await plantFileSource(py, path.join(root, "case-db-identity", "repo"));
				const targetDbPath = path.join(root, "case-db-identity", "slots", "slot", ".chunkhound.db");
				const before = statSafe(source.dbPath);
				if (!before) throw new Error("seed db missing before the case");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase !== "beforeCopy") return;
							const bytes = fs.readFileSync(source.dbPath);
							fs.rmSync(source.dbPath);
							fs.writeFileSync(source.dbPath, bytes);
							fs.utimesSync(source.dbPath, before.atime, before.mtime);
						},
					},
				);
				const sameSizeMtimeDifferentIno = (() => {
					const after = statSafe(source.dbPath);
					return !!after && after.ino !== before.ino && after.size === before.size;
				})();
				await check(
					t,
					"C2 the db replaced with identical bytes and metadata rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0 && sameSizeMtimeDifferentIno,
				);
			}

			// Case 4: db rewritten in place between validation and copy.
			{
				const source = await plantFileSource(py, path.join(root, "case-db-changed", "repo"));
				const targetDbPath = path.join(root, "case-db-changed", "slots", "slot", ".chunkhound.db");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase === "beforeCopy") fs.writeFileSync(source.dbPath, "same file rewritten in place with longer bytes");
						},
					},
				);
				await check(
					t,
					"C2 the db changed in place between validation and copy rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0,
				);
			}

			// Case 5: source db mutated after the copy landed (incoherent copy).
			{
				const source = await plantFileSource(py, path.join(root, "case-source-after", "repo"));
				const targetDbPath = path.join(root, "case-source-after", "slots", "slot", ".chunkhound.db");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase === "afterCopy") fs.writeFileSync(source.dbPath, "source mutated while the copy was landing");
						},
					},
				);
				await check(
					t,
					"C2 a source db changed after the copy rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0,
				);
			}

			// Case 6: slot db corrupted after the copy (post-copy revalidation).
			{
				const source = await plantFileSource(py, path.join(root, "case-slot-corrupt", "repo"));
				const targetDbPath = path.join(root, "case-slot-corrupt", "slots", "slot", ".chunkhound.db");
				const outcome = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{
						targetDbPath,
						onPhase: async (phase: "beforeCopy" | "afterCopy") => {
							if (phase === "afterCopy") fs.writeFileSync(targetDbPath, "corrupted slot db bytes");
						},
					},
				);
				await check(
					t,
					"C2 a slot db corrupted after the copy rejects fail-closed",
					outcome.kind === "rejected" && targetResidue(targetDbPath).length === 0,
				);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 adoption copy: forced plain and injected cross-device copies stay byte-exact and warn explicitly", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-plain-");
		try {
			const { binary } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			const source = await plantFileSource(py, path.join(root, "repo"));
			const sourceSha = contentSha256(source.dbPath);

			const plainTarget = path.join(root, "slots", "plain", ".chunkhound.db");
			const plainOutcome = await copyAdoptedIndex(
				{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
				{ targetDbPath: plainTarget, forcePlainCopy: true },
			);
			await check(
				t,
				"C2 forced plain copy is byte-identical",
				plainOutcome.kind === "copied" && contentSha256(plainTarget) === sourceSha,
			);

			const crossTarget = path.join(root, "slots", "cross", ".chunkhound.db");
			const crossOutcome = await copyAdoptedIndex(
				{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
				{ targetDbPath: crossTarget, sameDevice: false },
			);
			await check(
				t,
				"C2 an injected cross-device copy is byte-identical and warns explicitly",
				crossOutcome.kind === "copied" &&
					contentSha256(crossTarget) === sourceSha &&
					crossOutcome.warnings.length > 0 &&
					crossOutcome.warnings[0]!.includes("cross-device"),
			);
			await check(t, "C2 the source stays untouched under forced plain copy", contentSha256(source.dbPath) === sourceSha);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
