import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { baselineDbDirFor, baselineDirFor, listBaselines, resolveBaselineRef } from "../../chhound/baseline.js";
import { runGit } from "../../chhound/git.js";
import { readSandboxMeta, sandboxDbDir, sandboxStateDir } from "../../chhound/sandbox.js";
import { createIndexedWorktree } from "../../worktree/command.js";
import { branchDeleteIntent } from "../../worktree/manage.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, restoreEnv, snapshotEnv } from "../lib/isolation.js";

/**
 * Anchor policy obligations for worktree creates (operator decision
 * 2026-09-15): a baseline is ALWAYS the repo's default ref (or the explicit
 * `settings.baseline.ref`); the branch a worktree is cut from must never mint
 * or refresh its own baseline.
 *
 * The engine is stubbed through CHHOUND_BINARY (command tier): the fake writes
 * the db FILE at `database.path` (the field is a path, not a dir — pinned by
 * the shape checks) and appends one JSON line per `index` invocation to
 * `fake-chhound.log`. So the REAL create path runs — git worktree add, baseline
 * ensure/prime, hot-start db copy + top-up, sandbox meta — and assertions can
 * use the exact baseline directory on disk AND the engine-invocation record
 * (which baseline db was primed vs. topped up, and whether a "reused" baseline
 * was secretly re-primed).
 *
 * RED until the policy lands (three kinds):
 * - behavioral anchors — derived/existing-branch/config/origin/shared/refresh
 *   scenarios anchor `feature/x` or `feature/y` instead of the default ref;
 * - the Option A field — `createdBranch` is absent from meta everywhere;
 * - a safety regression the old heuristic would swallow — a remote-ref
 *   identity (`origin/release`) recorded against the default `baseRef` must
 *   NOT read as "branch created here" (`branch !== baseRef` says it is).
 * Green regression pins that must stay green: the detached/PR-slot baseline
 * anchors, meta.baseCommit/copiedFrom on all paths, and pull/N deletion intent.
 * The remote/PR wrapper call sites themselves are sealed when
 * `CreateIndexedWorktreeOptions.baseRef` is removed and those callers stop
 * compiling.
 */

async function git(args: string[], cwd: string): Promise<string> {
	const r = await runGit(args, { cwd });
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout.trim();
}

/**
 * Minimal chunkhound stand-in. Strict on purpose: only `--version` and
 * `index … --config <cfg>` are accepted; the db is a regular file at
 * `database.path` (parent dirs created); every index run is logged.
 */
function writeFakeEngine(root: string): string {
	const script = [
		`#!${process.execPath}`,
		`const fs = require("node:fs");`,
		`const path = require("node:path");`,
		`const args = process.argv.slice(2);`,
		`if (args.includes("--version")) { process.stdout.write("chunkhound 0.0.0-fake\\n"); process.exit(0); }`,
		`if (args[0] !== "index") { process.stderr.write("fake engine: unsupported command: " + args.join(" ") + "\\n"); process.exit(2); }`,
		`const ci = args.indexOf("--config");`,
		`if (ci < 0 || typeof args[ci + 1] !== "string") { process.stderr.write("fake engine: missing --config\\n"); process.exit(3); }`,
		`let cfg;`,
		`try { cfg = JSON.parse(fs.readFileSync(args[ci + 1], "utf8")); } catch (err) { process.stderr.write("fake engine: bad config: " + err + "\\n"); process.exit(4); }`,
		`const dbPath = cfg && cfg.database && cfg.database.path;`,
		`if (typeof dbPath !== "string" || !dbPath) { process.stderr.write("fake engine: missing database.path\\n"); process.exit(5); }`,
		`fs.mkdirSync(path.dirname(dbPath), { recursive: true });`,
		`fs.writeFileSync(dbPath, "fake-db-bytes");`,
		`fs.appendFileSync(path.join(path.dirname(__filename), "fake-chhound.log"), JSON.stringify({ dbPath }) + "\\n");`,
		`process.exit(0);`,
	].join("\n") + "\n";
	const p = path.join(root, "fake-chhound");
	fs.writeFileSync(p, script);
	fs.chmodSync(p, 0o755);
	return p;
}

/** db paths the fake engine was invoked with, in order (one per `index` run). */
function engineInvocations(root: string): string[] {
	const p = path.join(root, "fake-chhound.log");
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { dbPath: string }).dbPath);
}

function invocationCount(root: string, dbPath: string): number {
	return engineInvocations(root).filter((p) => p === dbPath).length;
}

/** Repo fixture: `main` (a.ts) is the default tip; HEAD is the non-default `feature/x`. */
async function makeRepo(root: string): Promise<string> {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	await git(["init", "-b", "main"], repo);
	await git(["config", "user.email", "smoke@test"], repo);
	await git(["config", "user.name", "Smoke"], repo);
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-qm", "init"], repo);
	await git(["checkout", "-qb", "feature/x"], repo);
	fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 2;\n");
	await git(["add", "-A"], repo);
	await git(["commit", "-qm", "feature work"], repo);
	return repo;
}

interface CreateOpts {
	createBranch?: string;
	branch?: string;
	commitIsh?: string;
	branchLabel?: string;
	headRef?: string;
	headOid?: string;
	/** Worktree folder name — the path-derived branch name git uses. Default "checkout". */
	wtName?: string;
	flags?: Record<string, string | true>;
}

let sandboxSeq = 0;

async function runCreate(
	root: string,
	repo: string,
	settings: ChhoundSettings,
	opts: CreateOpts = {},
): Promise<{ ok: boolean; sandboxDir: string; notifications: string[] }> {
	const sandboxDir = path.join(root, "sandboxes", `wt-${++sandboxSeq}`);
	const notifications: string[] = [];
	const ctx = { cwd: repo, hasUI: false, pi: {}, ui: { notify: (msg: string) => { notifications.push(msg); } } };
	const result = await createIndexedWorktree(ctx as never, {} as never, {
		repoRoot: repo,
		sandboxDir,
		wtPath: path.join(sandboxDir, opts.wtName ?? "checkout"),
		settings,
		...(opts.createBranch ? { createBranch: opts.createBranch } : {}),
		...(opts.branch ? { branch: opts.branch } : {}),
		...(opts.commitIsh ? { commitIsh: opts.commitIsh } : {}),
		...(opts.branchLabel ? { branchLabel: opts.branchLabel } : {}),
		...(opts.headRef ? { headRef: opts.headRef } : {}),
		...(opts.headOid ? { headOid: opts.headOid } : {}),
		flags: opts.flags ?? {},
	});
	return { ok: result.ok, sandboxDir, notifications };
}

function baselineFacts(settings: ChhoundSettings): Array<{ dir: string; ref?: string; updatedAt?: string }> {
	return listBaselines(settings).filter((b) => b.meta !== undefined).map((b) => ({ dir: b.dir, ref: b.meta?.baseRef, updatedAt: b.meta?.updatedAt }));
}

describe("baseline anchor policy", () => {
	test("a derived create on a non-default source branch anchors the default ref", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-derived-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root); // HEAD = feature/x, default = main
			const mainSha = await git(["rev-parse", "main"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { createBranch: "anchor-new" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "exactly one baseline is primed", baselines.length === 1, JSON.stringify(baselines));
			await check(t, "baseline ref is the default branch, not the source HEAD", baselines[0]?.ref === "main", JSON.stringify(baselines));
			await check(t, "the feature/x baseline dir is never created", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)));
			const mainDb = baselineDbDirFor(repo, "main", settings);
			await check(t, "the main baseline db is a regular non-empty file", fs.existsSync(mainDb) && fs.statSync(mainDb).isFile() && fs.statSync(mainDb).size > 0, mainDb);
			await check(t, "the main baseline was primed exactly once", invocationCount(root, mainDb) === 1, JSON.stringify(engineInvocations(root)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "sandbox meta records the default ref", meta?.baseRef === "main", JSON.stringify(meta));
			await check(t, "sandbox meta records the default ref's commit", meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "sandbox meta records the default baseline as its copy source", meta?.copiedFrom === mainDb, JSON.stringify(meta));
			await check(t, "sandbox meta records the flag that this branch was created here", meta?.createdBranch === true, JSON.stringify(meta));
			await check(t, "the created branch stays deletable on rm", meta !== undefined && branchDeleteIntent(meta) === true, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("checking out an existing non-default branch anchors the default ref", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-existing-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root);
			const mainSha = await git(["rev-parse", "main"], repo);
			await git(["checkout", "-q", "main"], repo); // feature/x is free to check out

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { branch: "feature/x" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "only the default baseline exists", baselines.length === 1 && baselines[0]?.ref === "main", JSON.stringify(baselines));
			await check(t, "no feature/x baseline dir", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)));
			const mainDb = baselineDbDirFor(repo, "main", settings);
			await check(t, "the default baseline was primed exactly once", invocationCount(root, mainDb) === 1, JSON.stringify(engineInvocations(root)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "sandbox meta records the default ref and commit", meta?.baseRef === "main" && meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "sandbox meta records the flag that this branch pre-existed", meta?.createdBranch === false, JSON.stringify(meta));
			await check(t, "a checked-out pre-existing branch is never marked for deletion", meta !== undefined && branchDeleteIntent(meta) === false, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a path-derived create reusing an existing <folder> branch records createdBranch:false (F2-01)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-reused-derived-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root); // HEAD = feature/x, default = main
			const mainSha = await git(["rev-parse", "main"], repo);
			// The branch git path-derives from the worktree folder already exists
			// (created elsewhere, checked out nowhere): git checks it out instead
			// of creating one, so rm must not own it.
			await git(["branch", "checkout", "main"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { wtName: "checkout" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta records the re-used branch as its identity", meta?.branch === "checkout", JSON.stringify(meta));
			await check(t, "meta anchors the default ref and commit", meta?.baseRef === "main" && meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "meta records createdBranch:false (the branch pre-existed the create)", meta?.createdBranch === false, JSON.stringify(meta));
			await check(t, "rm never considers the pre-existing branch a candidate", meta !== undefined && branchDeleteIntent(meta) === false, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a path-derived create of a fresh <folder> branch records createdBranch:true", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-fresh-derived-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root);
			const mainSha = await git(["rev-parse", "main"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { wtName: "fresh-wt" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta records the path-derived branch as its identity", meta?.branch === "fresh-wt", JSON.stringify(meta));
			await check(t, "meta anchors the default ref and commit", meta?.baseRef === "main" && meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "meta records createdBranch:true (this create made the branch)", meta?.createdBranch === true, JSON.stringify(meta));
			await check(t, "the created branch stays deletable on rm", meta !== undefined && branchDeleteIntent(meta) === true, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("settings.baseline.ref wins over both source HEAD and default branch", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-config-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases"), baseline: { ref: "release" } };
			const repo = await makeRepo(root);
			await git(["branch", "release", "main"], repo);
			const releaseSha = await git(["rev-parse", "release"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { createBranch: "anchor-new" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "the configured ref is the only baseline", baselines.length === 1 && baselines[0]?.ref === "release", JSON.stringify(baselines));
			await check(t, "no feature/x baseline dir", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta anchors the configured ref's commit", meta?.baseRef === "release" && meta?.baseCommit === releaseSha, JSON.stringify(meta));
			await check(t, "meta copies from the configured ref's baseline", meta?.copiedFrom === baselineDbDirFor(repo, "release", settings), JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("origin/HEAD decides the default ref when the source branch differs", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-origin-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], repo);
			await git(["config", "user.email", "smoke@test"], repo);
			await git(["config", "user.name", "Smoke"], repo);
			fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
			await git(["add", "-A"], repo);
			await git(["commit", "-qm", "init"], repo);
			const origin = path.join(root, "origin.git");
			await git(["init", "--bare", "-q", origin], root);
			await git(["remote", "add", "origin", origin], repo);
			await git(["push", "-q", "origin", "main"], repo);
			await git(["checkout", "-qb", "develop"], repo);
			fs.writeFileSync(path.join(repo, "c.md"), "# develop\n");
			await git(["add", "-A"], repo);
			await git(["commit", "-qm", "develop work"], repo);
			await git(["push", "-q", "origin", "develop"], repo);
			await git(["fetch", "-q", "origin"], repo);
			await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], repo);
			await git(["checkout", "-qb", "feature/x"], repo);
			fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 2;\n");
			await git(["add", "-A"], repo);
			await git(["commit", "-qm", "feature work"], repo);
			const developSha = await git(["rev-parse", "develop"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { createBranch: "anchor-new" });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "baseline ref is the repo default (develop)", baselines.length === 1 && baselines[0]?.ref === "develop", JSON.stringify(baselines));
			await check(t, "no feature/x baseline dir", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta anchors develop's commit", meta?.baseRef === "develop" && meta?.baseCommit === developSha, JSON.stringify(meta));
			await check(t, "meta copies from develop's baseline", meta?.copiedFrom === baselineDbDirFor(repo, "develop", settings), JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a remote-ref checkout keeps its identity but anchors the default ref (regression pin)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-remote-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root);
			const mainSha = await git(["rev-parse", "main"], repo);
			await git(["branch", "release", "main"], repo);
			const origin = path.join(root, "origin.git");
			await git(["init", "--bare", "-q", origin], root);
			await git(["remote", "add", "origin", origin], repo);
			await git(["push", "-q", "origin", "main", "release"], repo);
			await git(["fetch", "-q", "origin"], repo);
			await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repo);
			// Mirrors the one-go remote path: detached at the tracking ref's sha,
			// with the remote name as the sandbox identity (no explicit anchor).
			const remoteSha = await git(["rev-parse", "origin/release"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, {
				commitIsh: remoteSha,
				branchLabel: "origin/release",
			});

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "only the default baseline exists", baselines.length === 1 && baselines[0]?.ref === "main", JSON.stringify(baselines));
			await check(t, "no release or origin/release baseline dir", !fs.existsSync(baselineDirFor(repo, "release", settings)) && !fs.existsSync(baselineDirFor(repo, "origin/release", settings)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta keeps the remote identity as the branch label", meta?.branch === "origin/release", JSON.stringify(meta));
			await check(t, "meta still anchors the default ref and commit", meta?.baseRef === "main" && meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "a remote-ref checkout is not marked as a branch created here", meta?.createdBranch === false, JSON.stringify(meta));
			await check(t, "a remote-ref checkout is never marked for deletion", meta !== undefined && branchDeleteIntent(meta) === false, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a pull/N PR-slot create anchors the default ref (regression pin)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-pr-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root);
			const mainSha = await git(["rev-parse", "main"], repo);
			// Mirrors the PR path: detached at the PR head, pull/N identity, no
			// explicit base anchor (its removal is what seals the wrapper callers).
			const headSha = await git(["rev-parse", "feature/x"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, {
				commitIsh: headSha,
				branchLabel: "pull/7",
				headRef: "feature/x",
				headOid: headSha,
			});

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "only the default baseline exists", baselines.length === 1 && baselines[0]?.ref === "main", JSON.stringify(baselines));
			await check(t, "no pull/7 baseline dir", !fs.existsSync(baselineDirFor(repo, "pull/7", settings)));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "meta keeps the PR slot as the branch label", meta?.branch === "pull/7", JSON.stringify(meta));
			await check(t, "meta anchors the default ref and commit", meta?.baseRef === "main" && meta?.baseCommit === mainSha, JSON.stringify(meta));
			await check(t, "meta keeps the PR head fields", meta?.headRef === "feature/x" && meta?.headOid === headSha, JSON.stringify(meta));
			await check(t, "a PR slot is never marked for deletion", meta !== undefined && branchDeleteIntent(meta) === false, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a detached --from create stays on the default ref (regression pin)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-detached-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root);
			const sha = await git(["rev-parse", "feature/x"], repo);

			const { ok, sandboxDir, notifications } = await runCreate(root, repo, settings, { commitIsh: sha });

			await check(t, "create succeeds", ok, notifications.join(" | "));
			const baselines = baselineFacts(settings);
			await check(t, "baseline ref is the default branch", baselines.length === 1 && baselines[0]?.ref === "main", JSON.stringify(baselines));
			const meta = readSandboxMeta(sandboxStateDir(sandboxDir));
			await check(t, "a detached checkout is not marked as a branch created here", meta?.createdBranch === false, JSON.stringify(meta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("creates from different non-default branches share one default baseline", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-shared-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root); // HEAD = feature/x
			const mainDb = baselineDbDirFor(repo, "main", settings);

			const first = await runCreate(root, repo, settings, { createBranch: "anchor-one" });
			await check(t, "first create succeeds", first.ok, first.notifications.join(" | "));
			const before = baselineFacts(settings);
			await check(t, "one default baseline after the first create", before.length === 1 && before[0]?.ref === "main", JSON.stringify(before));
			await check(t, "the first create primed the default baseline once and topped up its sandbox", invocationCount(root, mainDb) === 1 && invocationCount(root, sandboxDbDir(first.sandboxDir)) === 1, JSON.stringify(engineInvocations(root)));

			await git(["checkout", "-qb", "feature/y"], repo);
			fs.writeFileSync(path.join(repo, "c.ts"), "export const c = 3;\n");
			await git(["add", "-A"], repo);
			await git(["commit", "-qm", "second feature"], repo);
			const second = await runCreate(root, repo, settings, { createBranch: "anchor-two" });
			await check(t, "second create succeeds", second.ok, second.notifications.join(" | "));

			const after = baselineFacts(settings);
			await check(t, "still exactly one baseline after the second create", after.length === 1, JSON.stringify(after));
			await check(t, "the same default baseline dir is reused", after[0]?.dir === before[0]?.dir, JSON.stringify({ before, after }));
			await check(t, "the second create did NOT re-prime the baseline (engine invoked once for the sandbox only)", invocationCount(root, mainDb) === 1 && invocationCount(root, sandboxDbDir(second.sandboxDir)) === 1, JSON.stringify(engineInvocations(root)));
			await check(t, "the reused baseline is not re-primed (updatedAt unchanged)", after[0]?.updatedAt === before[0]?.updatedAt, JSON.stringify({ before, after }));
			await check(t, "no feature/x or feature/y baseline dir", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)) && !fs.existsSync(baselineDirFor(repo, "feature/y", settings)));
			const secondMeta = readSandboxMeta(sandboxStateDir(second.sandboxDir));
			await check(t, "the second sandbox copies from the SAME default baseline", secondMeta?.copiedFrom === mainDb, JSON.stringify(secondMeta));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("--refresh-baseline re-primes the default baseline, never the source branch", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-anchor-refresh-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: writeFakeEngine(root) } }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = await makeRepo(root); // HEAD = feature/x
			const mainDb = baselineDbDirFor(repo, "main", settings);

			const first = await runCreate(root, repo, settings, { createBranch: "anchor-one" });
			await check(t, "first create succeeds", first.ok, first.notifications.join(" | "));
			const before = baselineFacts(settings);
			await check(t, "one default baseline after the first create", before.length === 1 && before[0]?.ref === "main", JSON.stringify(before));

			await git(["checkout", "-qb", "feature/y"], repo);
			fs.writeFileSync(path.join(repo, "c.ts"), "export const c = 3;\n");
			await git(["add", "-A"], repo);
			await git(["commit", "-qm", "second feature"], repo);
			const second = await runCreate(root, repo, settings, { createBranch: "anchor-two", flags: { "refresh-baseline": true } });
			await check(t, "second create succeeds", second.ok, second.notifications.join(" | "));

			const after = baselineFacts(settings);
			await check(t, "still exactly one baseline after the refresh", after.length === 1 && after[0]?.ref === "main", JSON.stringify(after));
			await check(t, "the refresh re-primed the DEFAULT baseline (not the source branch)", invocationCount(root, mainDb) === 2, JSON.stringify(engineInvocations(root)));
			await check(t, "no feature/x or feature/y baseline dir", !fs.existsSync(baselineDirFor(repo, "feature/x", settings)) && !fs.existsSync(baselineDirFor(repo, "feature/y", settings)));
		} finally {
			restoreEnv(env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("resolveBaselineRef: settings override, origin/HEAD, then main", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-resolve-ref-");
		try {
			const settings: ChhoundSettings = { version: 1 };
			const repo = await makeRepo(root);
			await check(t, "settings.baseline.ref wins", (await resolveBaselineRef(repo, { ...settings, baseline: { ref: "release" } })) === "release");
			await check(t, "no origin falls back to main", (await resolveBaselineRef(repo, settings)) === "main");

			const origin = path.join(root, "origin.git");
			await git(["init", "--bare", "-q", origin], root);
			await git(["remote", "add", "origin", origin], repo);
			await git(["push", "-q", "origin", "main"], repo);
			await git(["checkout", "-qb", "develop"], repo);
			await git(["push", "-q", "origin", "develop"], repo);
			await git(["fetch", "-q", "origin"], repo);
			await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], repo);
			await check(t, "origin/HEAD decides when settings are silent", (await resolveBaselineRef(repo, settings)) === "develop");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
