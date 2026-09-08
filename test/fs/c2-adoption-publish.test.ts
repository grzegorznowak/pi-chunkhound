import { describe, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyAdoptedIndex } from "../../chhound/adoption.js";
import {
	adoptionEligibility,
	convergeAdoptedSlot,
	readSlotMeta,
	writePendingAdoptionMeta,
} from "../../chhound/adoption-publish.js";
import { enginePython } from "../../chhound/cli.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: C2 RED-first scenarios (feature label c2) encoding the
// adoption-publish obligations of the Stream-2 spec v1.2 §3.5 (PENDING-STATE
// meta {version:1, state:"pending-adopted", baseCommit:"adopted"-sentinel,
// chhoundVersion: current, repoRoot}; stale once the anchor resolves; crash
// retention: death after the copy but before convergence RETAINS the pending
// slot — the next run resumes via the existing top-up path with no re-copy;
// cleanup of db+config+claim+meta happens ONLY on a failed convergence;
// real meta written LAST; force bypasses adoption) plus the test-design
// group 8 "pending/publication" (pending visible to status/GC/reuse
// consumers; resolved SHA publishes; absent anchor never publishes; fail
// after each artifact before the real meta removes DB/config/claim/meta).
// The consumer integrations themselves (GC/supersession exclusion, tier-1
// reuse scan exclusion, /ch-status pending label) land with the tier-2
// prime wiring in the integration slice and consume the reader + eligibility
// helpers pinned here; this RED fixes their state surface.
// chhound/adoption-publish.ts is a C2 module and does not exist yet — this
// file is the RED encoding; the green pass implements it. Scenario titles
// and leaf names below are the inventory identity: keep verbatim in every
// future commit. Slot layout mirrors the baseline slot: <slot>/meta.json +
// <slot>/.chunkhound.json + <slot>/db/.chhound.db (+ <slot>/db/.chhound.db
// .root.json claim); convergence = one real engine top-up over a plain
// checkout whose claim is re-pointed before the engine opens the adopted
// db. Env: fake HOME; engine binary resolved BEFORE env isolation and
// re-injected via CHHOUND_BINARY (engine CLI runs inherit process env);
// enginePython yields the engine venv python (duckdb) for real db seeds and
// read-only row queries. Canonical user source layout: <root>/.chunkhound
// .json + <root>/.chunkhound.db + sidecar <db>.root.json {version:1,
// indexed_root_path}.

// Pinned module contract (RED obligations):
// - writePendingAdoptionMeta(slotDir, {repoRoot, chhoundVersion}): writes
//   <slot>/meta.json {version:1, state:"pending-adopted", baseCommit:
//   "adopted", chhoundVersion, repoRoot} atomically (tmp + rename).
// - readSlotMeta(slotDir): parsed meta when version === 1 (pending keeps its
//   state field, real meta has none), undefined otherwise.
// - adoptionEligibility(slotDir, {force}): {decision:"adopt"|"resume"|"skip",
//   reason?}. force -> skip("forced"); real meta present -> skip("already
//   primed"); pending meta OR a db file at <slot>/db/.chhound.db -> resume;
//   otherwise adopt. Real flows: adopt = copy + converge; resume = converge
//   only (crash retention; never re-copies).
// - convergeAdoptedSlot({slotDir, indexDir, anchorSha, baseRef, repoRoot,
//   chhoundVersion, extraArgs?, onPhase?}) -> Promise<{kind:"published"} |
//   {kind:"failed", reason}>. Guards run FIRST and never clean: empty
//   anchorSha -> failed("anchor not resolved"); primed slot -> failed("slot
//   already primed"); missing db -> failed("adopted db missing"). Then, when
//   no meta exists, the pending meta is written; onPhase("pendingWritten")
//   fires; the engine top-up runs over indexDir (config = <slot>/
//   .chunkhound.json, db = <slot>/db/.chhound.db, claim re-pointed to
//   indexDir); a non-zero engine exit or any thrown error -> cleanup of db
//   dir, config and meta -> failed. After a successful engine run
//   onPhase("converged") fires; then the REAL baseline meta {version:1,
//   repoRoot, baseRef, baseCommit: anchorSha, chhoundVersion, updatedAt} is
//   written LAST to <slot>/meta.json -> published.

const PENDING_STATE = "pending-adopted";
const PENDING_BASECOMMIT = "adopted";
const ANCHOR_SHA = "abcd1234abcd1234abcd1234abcd1234abcd1234";
const BASE_REF = "main";

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

// Read-only row count of a table inside the engine db (real convergence proof).
async function dbRowCount(py: string, dbPath: string, table: string): Promise<number | null> {
	return new Promise((resolve) => {
		const script = pythonScript(
			"import duckdb, sys",
			"c = duckdb.connect(sys.argv[1], read_only=True)",
			`print(c.execute('select count(*) from ${table}').fetchone()[0])`,
			"c.close()",
		);
		const child: ChildProcess = spawn(py, ["-c", script, dbPath], { stdio: ["ignore", "pipe", "ignore"] });
		const out: string[] = [];
		child.stdout?.on("data", (d: Buffer) => out.push(String(d)));
		child.on("error", () => resolve(null));
		// 'close' (not 'exit') guarantees stdout has been fully drained.
		child.on("close", () => {
			const text = out.join("").trim();
			const m = /(\d+)\s*$/.exec(text);
			resolve(m ? Number.parseInt(m[1], 10) : null);
		});
	});
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

// Parsed JSON or undefined (missing/malformed — leaf-safe).
function readJsonSafe(p: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function writeConfig(configPath: string, dbPath: string): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ database: { provider: "duckdb", path: dbPath } }), { mode: 0o600 });
}

// File-shaped user source: <root>/.chunkhound.json + <root>/.chunkhound.db + claim.
async function plantUserSource(py: string, root: string): Promise<{ root: string; configPath: string; dbPath: string }> {
	const configPath = path.join(root, ".chunkhound.json");
	const dbPath = path.join(root, ".chunkhound.db");
	await makeSeedDb(py, dbPath);
	fs.writeFileSync(`${dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: root }), { mode: 0o600 });
	writeConfig(configPath, dbPath);
	return { root, configPath, dbPath };
}

// Plain checkout the convergence indexes (two supported files, no git).
function plantCheckout(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
}

// Baseline-style slot scaffold: <slot>/db/.chhound.db + <slot>/.chunkhound.json.
function makeSlot(root: string, name: string): { slotDir: string; dbDir: string; dbPath: string; configPath: string; metaPath: string } {
	const slotDir = path.join(root, name);
	const dbDir = path.join(slotDir, "db");
	fs.mkdirSync(dbDir, { recursive: true });
	return {
		slotDir,
		dbDir,
		dbPath: path.join(dbDir, ".chhound.db"),
		configPath: path.join(slotDir, ".chunkhound.json"),
		metaPath: path.join(slotDir, "meta.json"),
	};
}

// Top-level entries left under the slot (empty = fully cleaned).
function slotResidue(slotDir: string): string[] {
	try {
		return fs.readdirSync(slotDir).sort();
	} catch {
		return [];
	}
}

// Real baseline meta, fixture-written (as the prime path would leave it).
function plantRealMeta(slotDir: string, repoRoot: string, version: string): void {
	const meta = {
		version: 1,
		repoRoot,
		baseRef: BASE_REF,
		baseCommit: ANCHOR_SHA,
		chhoundVersion: version,
		updatedAt: new Date().toISOString(),
	};
	fs.writeFileSync(path.join(slotDir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
}

describe("c2 adoption publish", () => {
	test("C2 adoption publish: pending meta shape, eligibility verdicts, and pre-flight guards", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-pub-");
		try {
			const { binary, version } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const repoRoot = path.join(root, "repo");

			// Fresh slot: pending meta write + reader roundtrip.
			const fresh = makeSlot(root, "fresh");
			writePendingAdoptionMeta(fresh.slotDir, { repoRoot, chhoundVersion: version });
			const pendingMeta = readJsonSafe(fresh.metaPath);
			await check(
				t,
				"C2 pending meta carries the pinned shape (version 1, pending-adopted, adopted sentinel, engine version, repo root)",
				pendingMeta !== undefined &&
					pendingMeta.version === 1 &&
					pendingMeta.state === PENDING_STATE &&
					pendingMeta.baseCommit === PENDING_BASECOMMIT &&
					pendingMeta.chhoundVersion === version &&
					pendingMeta.repoRoot === repoRoot,
			);
			const readBack = readSlotMeta(fresh.slotDir);
			await check(
				t,
				"C2 the slot meta reader exposes the pending state verbatim for consumer decisions",
				readBack !== undefined &&
					readBack.state === PENDING_STATE &&
					readBack.baseCommit === PENDING_BASECOMMIT &&
					readBack.chhoundVersion === version &&
					readBack.repoRoot === repoRoot,
			);

			// Eligibility verdicts.
			const bare = makeSlot(root, "bare");
			const bareVerdict = adoptionEligibility(bare.slotDir, { force: false });
			await check(t, "C2 a slot without meta and without a db is adopt-eligible", bareVerdict.decision === "adopt");
			const forcedVerdict = adoptionEligibility(bare.slotDir, { force: true });
			await check(
				t,
				"C2 force bypasses adoption entirely (skip, reason forced)",
				forcedVerdict.decision === "skip" && forcedVerdict.reason === "forced",
			);

			const pendingSlot = makeSlot(root, "pending-db");
			writePendingAdoptionMeta(pendingSlot.slotDir, { repoRoot, chhoundVersion: version });
			fs.writeFileSync(pendingSlot.dbPath, "slot db");
			const pendingVerdict = adoptionEligibility(pendingSlot.slotDir, { force: false });
			await check(t, "C2 a pending slot resumes (converge only, never re-copy)", pendingVerdict.decision === "resume");

			const dbOnlySlot = makeSlot(root, "db-only");
			fs.writeFileSync(dbOnlySlot.dbPath, "slot db");
			const dbOnlyVerdict = adoptionEligibility(dbOnlySlot.slotDir, { force: false });
			await check(
				t,
				"C2 a copied db without meta (crash between copy and pending write) resumes",
				dbOnlyVerdict.decision === "resume",
			);

			const primedSlot = makeSlot(root, "primed");
			plantRealMeta(primedSlot.slotDir, repoRoot, version);
			fs.writeFileSync(primedSlot.dbPath, "slot db");
			const primedVerdict = adoptionEligibility(primedSlot.slotDir, { force: false });
			const primedRead = readSlotMeta(primedSlot.slotDir);
			await check(
				t,
				"C2 an already primed slot is skipped, and its real meta carries no pending state",
				primedVerdict.decision === "skip" &&
					primedVerdict.reason === "already primed" &&
					primedRead !== undefined &&
					primedRead.state === undefined &&
					primedRead.baseCommit === ANCHOR_SHA,
			);

			// Pre-flight guards: nothing written, nothing removed.
			const emptySlot = makeSlot(root, "empty-converge");
			const emptyOutcome = await convergeAdoptedSlot({
				slotDir: emptySlot.slotDir,
				indexDir: path.join(root, "empty-checkout"),
				anchorSha: ANCHOR_SHA,
				baseRef: BASE_REF,
				repoRoot,
				chhoundVersion: version,
				extraArgs: ["--no-embeddings"],
			});
			await check(
				t,
				"C2 convergence without an adopted db fails without writing any artifact",
				emptyOutcome.kind === "failed" &&
					emptyOutcome.reason === "adopted db missing" &&
					!fs.existsSync(emptySlot.metaPath) &&
					statSafe(emptySlot.dbPath) === null,
			);

			const noAnchorSlot = makeSlot(root, "no-anchor");
			writePendingAdoptionMeta(noAnchorSlot.slotDir, { repoRoot, chhoundVersion: version });
			fs.writeFileSync(noAnchorSlot.dbPath, "slot db");
			const noAnchorOutcome = await convergeAdoptedSlot({
				slotDir: noAnchorSlot.slotDir,
				indexDir: path.join(root, "no-anchor-checkout"),
				anchorSha: "",
				baseRef: BASE_REF,
				repoRoot,
				chhoundVersion: version,
				extraArgs: ["--no-embeddings"],
			});
			const noAnchorMeta = readJsonSafe(noAnchorSlot.metaPath);
			await check(
				t,
				"C2 an absent anchor never publishes and the pending slot is retained for a later resume",
				noAnchorOutcome.kind === "failed" &&
					noAnchorOutcome.reason === "anchor not resolved" &&
					noAnchorMeta !== undefined &&
					noAnchorMeta.state === PENDING_STATE &&
					noAnchorMeta.baseCommit === PENDING_BASECOMMIT &&
					statSafe(noAnchorSlot.dbPath)?.isFile() === true,
			);

			const primedConverge = makeSlot(root, "primed-converge");
			plantRealMeta(primedConverge.slotDir, repoRoot, version);
			fs.writeFileSync(primedConverge.dbPath, "slot db");
			const primedOutcome = await convergeAdoptedSlot({
				slotDir: primedConverge.slotDir,
				indexDir: path.join(root, "primed-checkout"),
				anchorSha: ANCHOR_SHA,
				baseRef: BASE_REF,
				repoRoot,
				chhoundVersion: version,
				extraArgs: ["--no-embeddings"],
			});
			const primedMetaAfter = readJsonSafe(primedConverge.metaPath);
			await check(
				t,
				"C2 convergence refuses a primed slot and leaves its real meta and db untouched",
				primedOutcome.kind === "failed" &&
					primedOutcome.reason === "slot already primed" &&
					primedMetaAfter !== undefined &&
					primedMetaAfter.state === undefined &&
					primedMetaAfter.baseCommit === ANCHOR_SHA &&
					statSafe(primedConverge.dbPath)?.isFile() === true,
			);

			// A primed slot with an empty anchor must still fail on the anchor
			// guard first (guard order: anchor before primed), untouched.
			const primedNoAnchor = makeSlot(root, "primed-no-anchor");
			plantRealMeta(primedNoAnchor.slotDir, repoRoot, version);
			fs.writeFileSync(primedNoAnchor.dbPath, "slot db");
			const primedNoAnchorOutcome = await convergeAdoptedSlot({
				slotDir: primedNoAnchor.slotDir,
				indexDir: path.join(root, "primed-no-anchor-checkout"),
				anchorSha: "",
				baseRef: BASE_REF,
				repoRoot,
				chhoundVersion: version,
				extraArgs: ["--no-embeddings"],
			});
			const primedNoAnchorMeta = readJsonSafe(primedNoAnchor.metaPath);
			await check(
				t,
				"C2 the anchor guard fires before the primed-slot guard and leaves the real meta untouched",
				primedNoAnchorOutcome.kind === "failed" &&
					primedNoAnchorOutcome.reason === "anchor not resolved" &&
					primedNoAnchorMeta !== undefined &&
					primedNoAnchorMeta.state === undefined &&
					primedNoAnchorMeta.baseCommit === ANCHOR_SHA &&
					statSafe(primedNoAnchor.dbPath)?.isFile() === true,
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 adoption publish: crash after copy or after pending write retains the slot and resume converges via top-up", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-pub-");
		try {
			const { binary, version } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			// Crash window A: the copy landed, the process died before any meta.
			{
				const source = await plantUserSource(py, path.join(root, "crash-a", "repo"));
				const checkout = path.join(root, "crash-a", "checkout");
				plantCheckout(checkout);
				const slot = makeSlot(path.join(root, "crash-a"), "slot");
				writeConfig(slot.configPath, slot.dbPath);
				const sourceShaBefore = contentSha256(source.dbPath);
				const copy = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{ targetDbPath: slot.dbPath },
				);
				if (copy.kind !== "copied") throw new Error(`fixture copy failed: ${JSON.stringify(copy)}`);
				await check(
					t,
					"C2 a crash after the copy leaves the slot db and its claim behind with no meta",
					statSafe(slot.dbPath)?.isFile() === true &&
						fs.existsSync(`${slot.dbPath}.root.json`) &&
						!fs.existsSync(slot.metaPath),
				);
				const outcome = await convergeAdoptedSlot({
					slotDir: slot.slotDir,
					indexDir: checkout,
					anchorSha: ANCHOR_SHA,
					baseRef: BASE_REF,
					repoRoot: source.root,
					chhoundVersion: version,
					extraArgs: ["--no-embeddings"],
				});
				await check(t, "C2 the crash-retained slot converges and publishes", outcome.kind === "published");
				const realMeta = readJsonSafe(slot.metaPath);
				await check(
					t,
					"C2 the real meta is written last with the resolved anchor and no pending state",
					realMeta !== undefined &&
						realMeta.version === 1 &&
						realMeta.state === undefined &&
						realMeta.baseCommit === ANCHOR_SHA &&
						realMeta.repoRoot === source.root &&
						realMeta.chhoundVersion === version &&
						typeof realMeta.updatedAt === "string",
				);
				const claim = readJsonSafe(`${slot.dbPath}.root.json`);
				await check(
					t,
					"C2 the slot claim is re-pointed at the converged checkout root",
					claim !== undefined && claim.indexed_root_path === checkout,
				);
				const rows = await dbRowCount(py, slot.dbPath, "files");
				await check(
					t,
					"C2 the engine top-up really converged the adopted db over the checkout",
					rows === 2,
				);
				await check(
					t,
					"C2 the user source stays untouched across copy and convergence",
					sourceShaBefore !== null && contentSha256(source.dbPath) === sourceShaBefore,
				);
			}

			// Crash window B: the pending meta was written, the process died before convergence.
			{
				const source = await plantUserSource(py, path.join(root, "crash-b", "repo"));
				const checkout = path.join(root, "crash-b", "checkout");
				plantCheckout(checkout);
				const slot = makeSlot(path.join(root, "crash-b"), "slot");
				writeConfig(slot.configPath, slot.dbPath);
				const copy = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{ targetDbPath: slot.dbPath },
				);
				if (copy.kind !== "copied") throw new Error(`fixture copy failed: ${JSON.stringify(copy)}`);
				writePendingAdoptionMeta(slot.slotDir, { repoRoot: source.root, chhoundVersion: version });
				await check(
					t,
					"C2 a crash after the pending write retains db, config, claim and the pending meta",
					statSafe(slot.dbPath)?.isFile() === true &&
						fs.existsSync(`${slot.dbPath}.root.json`) &&
						fs.existsSync(slot.configPath) &&
						readJsonSafe(slot.metaPath)?.state === PENDING_STATE,
				);
				// Delete the user source before the resume: a re-copy is then
				// impossible, so a successful convergence must run off the retained
				// slot db (crash retention + source-deleted-after-adoption).
				await fs.promises.rm(source.root, { recursive: true, force: true });
				let metaAtConvergedBarrier: Record<string, unknown> | undefined;
				const outcome = await convergeAdoptedSlot({
					slotDir: slot.slotDir,
					indexDir: checkout,
					anchorSha: ANCHOR_SHA,
					baseRef: BASE_REF,
					repoRoot: source.root,
					chhoundVersion: version,
					extraArgs: ["--no-embeddings"],
					onPhase: async (phase: "pendingWritten" | "converged") => {
						if (phase === "converged") metaAtConvergedBarrier = readJsonSafe(slot.metaPath);
					},
				});
				await check(t, "C2 the resume after a pending crash converges and publishes", outcome.kind === "published");
				await check(
					t,
					"C2 at the converged barrier the real meta is not written yet (real meta truly last)",
					metaAtConvergedBarrier !== undefined && metaAtConvergedBarrier.state === PENDING_STATE,
				);
				const filesRows = await dbRowCount(py, slot.dbPath, "files");
				await check(
					t,
					"C2 the resume converges the retained slot after the user source is gone (no re-copy possible)",
					filesRows === 2,
				);
				const finalMeta = readJsonSafe(slot.metaPath);
				await check(
					t,
					"C2 the resumed slot ends primed with the resolved anchor and no pending state",
					finalMeta !== undefined &&
						finalMeta.state === undefined &&
						finalMeta.baseCommit === ANCHOR_SHA &&
						finalMeta.version === 1,
				);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C2 adoption publish: any failure before the real meta removes every slot artifact", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c2-adopt-pub-");
		try {
			const { binary, version } = await resolveEngineBinary();
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: binary } }));
			const py = enginePython();
			if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");

			async function plantAdopted(rootName: string): Promise<{ source: { root: string; configPath: string; dbPath: string }; checkout: string; slot: ReturnType<typeof makeSlot> }> {
				if (!py) throw new Error("engine python not resolvable from CHHOUND_BINARY");
				const source = await plantUserSource(py, path.join(root, rootName, "repo"));
				const checkout = path.join(root, rootName, "checkout");
				plantCheckout(checkout);
				const slot = makeSlot(path.join(root, rootName), "slot");
				writeConfig(slot.configPath, slot.dbPath);
				const copy = await copyAdoptedIndex(
					{ configPath: source.configPath, dbPath: source.dbPath, expectedRoot: source.root },
					{ targetDbPath: slot.dbPath },
				);
				if (copy.kind !== "copied") throw new Error(`fixture copy failed: ${JSON.stringify(copy)}`);
				return { source, checkout, slot };
			}

			// Real engine failure: the slot config points the db under a path whose
			// parent is a file, so the engine top-up cannot open the database.
			{
				const planted = await plantAdopted("engine-fail");
				const brokenDbPath = path.join(planted.slot.configPath, "nested.duckdb");
				writeConfig(planted.slot.configPath, brokenDbPath);
				const outcome = await convergeAdoptedSlot({
					slotDir: planted.slot.slotDir,
					indexDir: planted.checkout,
					anchorSha: ANCHOR_SHA,
					baseRef: BASE_REF,
					repoRoot: planted.source.root,
					chhoundVersion: version,
					extraArgs: ["--no-embeddings"],
				});
				await check(
					t,
					"C2 a failed engine convergence reports failure",
					outcome.kind === "failed" && outcome.reason !== "",
				);
				await check(
					t,
					"C2 a failed engine convergence removes the db, claim, config and meta",
					slotResidue(planted.slot.slotDir).length === 0,
				);
			}

			// Injected failure right after the pending meta was written.
			{
				const planted = await plantAdopted("fail-pending");
				let pendingAtBarrier: Record<string, unknown> | undefined;
				const outcome = await convergeAdoptedSlot({
					slotDir: planted.slot.slotDir,
					indexDir: planted.checkout,
					anchorSha: ANCHOR_SHA,
					baseRef: BASE_REF,
					repoRoot: planted.source.root,
					chhoundVersion: version,
					extraArgs: ["--no-embeddings"],
					onPhase: async (phase: "pendingWritten" | "converged") => {
						if (phase === "pendingWritten") {
							pendingAtBarrier = readJsonSafe(planted.slot.metaPath);
							throw new Error("injected failure after the pending write");
						}
					},
				});
				await check(
					t,
					"C2 the pending meta is already in place when the pendingWritten barrier fires",
					pendingAtBarrier !== undefined &&
						pendingAtBarrier.state === PENDING_STATE &&
						pendingAtBarrier.baseCommit === PENDING_BASECOMMIT,
				);
				await check(
					t,
					"C2 a failure after the pending write reports failure",
					outcome.kind === "failed",
				);
				await check(
					t,
					"C2 a failure after the pending write removes every slot artifact",
					slotResidue(planted.slot.slotDir).length === 0,
				);
			}

			// Injected failure after the engine converged but before the real meta.
			{
				const planted = await plantAdopted("fail-before-real");
				let metaAtBarrier: Record<string, unknown> | undefined;
				const outcome = await convergeAdoptedSlot({
					slotDir: planted.slot.slotDir,
					indexDir: planted.checkout,
					anchorSha: ANCHOR_SHA,
					baseRef: BASE_REF,
					repoRoot: planted.source.root,
					chhoundVersion: version,
					extraArgs: ["--no-embeddings"],
					onPhase: async (phase: "pendingWritten" | "converged") => {
						if (phase === "converged") {
							metaAtBarrier = readJsonSafe(planted.slot.metaPath);
							throw new Error("injected failure before the real meta");
						}
					},
				});
				await check(
					t,
					"C2 a failure before the real meta reports failure",
					outcome.kind === "failed",
				);
				await check(
					t,
					"C2 the slot was still pending at the pre-real-meta barrier",
					metaAtBarrier !== undefined && metaAtBarrier.state === PENDING_STATE,
				);
				await check(
					t,
					"C2 a failure before the real meta removes the db, claim, config and pending meta",
					slotResidue(planted.slot.slotDir).length === 0,
				);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
