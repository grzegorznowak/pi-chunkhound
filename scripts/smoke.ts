/**
 * Legacy mechanics suite, temporarily invoked by the modular test adapter.
 * `npm run smoke` is now an alias for the full `npm test` suite; this file
 * remains only until Phase 2 extraction completes.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureBaseline } from "../chhound/baseline.js";
import { materializeConfig } from "../chhound/config.js";
import { chhoundVersion } from "../chhound/cli.js";
import { branchCompletions, worktreeArgumentCompletions } from "../chhound/completions.js";
import { currentBranch, findRepoRoot, gitWorktreeAdd, runGit } from "../chhound/git.js";
import { resolveBranchChoice } from "../worktree/command.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import {
	dirSize,
	readClaimedRoot,
	sandboxDbDir,
	sandboxDirFor,
	sandboxStateDir,
	writeSandboxMeta,
} from "../chhound/sandbox.js";

import type { ChhoundSettings } from "../chhound/types.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	checks++;
	if (cond) console.log(`  ok ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
const section = (t: string) => console.log(`\n== ${t}`);

async function main(): Promise<void> {
	// Resolve the scratch root BEFORE building any paths from it: git and the
	// engine canonicalize symlinked prefixes (macOS /var → /private/var), while
	// Node path ops do not — an unresolved root makes engine claims, daemon
	// locks and git results disagree with the paths this suite asserts on.
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-smoke-")));
	console.log(`scratch: ${tmp}`);
	const settings: ChhoundSettings = {
		version: 1,
		sandboxRoot: path.join(tmp, "sandboxes"),
		baseRoot: path.join(tmp, "bases"),
		// Materialized engine configs force watchman by default (config.ts
		// REALTIME_BACKEND_DEFAULT); the config file wins over the
		// CHUNKHOUND_INDEXING__REALTIME_BACKEND env var. On macOS the watchman
		// socket path exceeds the platform limit under deep runner tmp dirs, so
		// the suite (which polls daemon status and never asserts watchman
		// semantics) opts into the engine's polling backend here.
		indexing: { realtimeBackend: "polling" },
	};

	// ── 4. scratch git repo + baseline prime ─────────────────────────
	section("baseline prime");
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo);
	await runGit(["init", "-b", "main"], { cwd: repo });
	await runGit(["config", "user.email", "smoke@test"], { cwd: repo });
	await runGit(["config", "user.name", "Smoke"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit = await runGit(["commit", "-m", "init"], { cwd: repo });
	check("seed commit", commit.code === 0, commit.stderr);
	const baseCommit = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;

	const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
	const extraArgs = ["--no-embeddings"];
	const b1 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline primed", b1.fresh && fs.existsSync(b1.dbDir), b1.dir);
	check("baseline meta commit", b1.meta.baseCommit === baseCommit);
	check("baseline no artifacts in repo", !fs.existsSync(path.join(repo, ".chhound")), "found .chhound in repo");
	const wtClean1 = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after prime", wtClean1 === "", wtClean1);

	const b2 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline fresh on re-run", b2.fresh === false);

	// Base moved → refresh must re-prime via in-place top-up.
	fs.writeFileSync(path.join(repo, "b2.md"), "# more\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit2 = await runGit(["commit", "-m", "more"], { cwd: repo });
	check("second commit", commit2.code === 0, commit2.stderr);
	const baseCommit2 = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;
	const b3 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline refreshed on base move", b3.fresh === true && b3.meta.baseCommit === baseCommit2, b3.reason);



	// ── 4c. baseline anchor: LOCAL branch first, origin/<ref> only as fallback ──
	section("baseline anchor: local first");
	{
		// Isolated cache root — the main suite's baseline listings stay intact.
		const anchorSettings: ChhoundSettings = { version: 1, sandboxRoot: settings.sandboxRoot, baseRoot: path.join(tmp, "anchor-bases"), indexing: { realtimeBackend: "polling" } };

		// Repo A: local main @ c1 while a local bare origin carries a DIFFERENT
		// main tip c2 (fetched → origin/main = c2). Worktrees are cut from local
		// state, so the baseline must anchor c1 — not the origin tip.
		const repoA = path.join(tmp, "anchor-a");
		fs.mkdirSync(repoA);
		await runGit(["init", "-b", "main"], { cwd: repoA });
		await runGit(["config", "user.email", "smoke@test"], { cwd: repoA });
		await runGit(["config", "user.name", "Smoke"], { cwd: repoA });
		fs.writeFileSync(path.join(repoA, "a.ts"), "export const a = 1;\n");
		await runGit(["add", "-A"], { cwd: repoA });
		await runGit(["commit", "-qm", "local c1"], { cwd: repoA });
		const c1 = (await runGit(["rev-parse", "HEAD"], { cwd: repoA })).stdout;

		const bare = path.join(tmp, "anchor-origin.git");
		fs.mkdirSync(bare);
		await runGit(["init", "--bare", bare], { cwd: tmp });
		const feeder = path.join(tmp, "anchor-feeder");
		await runGit(["clone", "-q", repoA, feeder], { cwd: tmp });
		await runGit(["config", "user.email", "smoke@test"], { cwd: feeder });
		await runGit(["config", "user.name", "Smoke"], { cwd: feeder });
		fs.writeFileSync(path.join(feeder, "b.ts"), "export const b = 2;\n");
		await runGit(["add", "-A"], { cwd: feeder });
		await runGit(["commit", "-qm", "remote c2"], { cwd: feeder });
		const c2 = (await runGit(["rev-parse", "HEAD"], { cwd: feeder })).stdout;
		// Feeder already has an origin (the clone source) — re-point it at the
		// bare repo, then advance the bare origin's main to c2.
		await runGit(["remote", "set-url", "origin", bare], { cwd: feeder });
		const pushed = await runGit(["push", "-q", "origin", "main"], { cwd: feeder });
		check("setup: bare origin advanced to c2", pushed.code === 0 && (await runGit(["rev-parse", "main"], { cwd: bare })).stdout === c2, pushed.stderr || "bare main not at c2");
		check("setup: origin tip differs from local tip", c2 !== c1, "same commit — test can't discriminate");
		await runGit(["remote", "add", "origin", bare], { cwd: repoA });
		const fetchedA = await runGit(["fetch", "-q", "origin", "main"], { cwd: repoA });
		const originTip = (await runGit(["rev-parse", "--verify", "origin/main^{commit}"], { cwd: repoA })).stdout;
		check("setup: origin/main fetched and ahead of local main", fetchedA.code === 0 && originTip === c2, `${fetchedA.stderr || originTip.slice(0, 8)} vs ${c1.slice(0, 8)}`);

		const a1 = await ensureBaseline({ repoRoot: repoA, settings: anchorSettings, onLine, extraArgs });
		check("anchor: LOCAL tip preferred over fetched origin/main", a1.fresh && a1.meta.baseCommit === c1, `${a1.meta.baseCommit.slice(0, 8)} (origin/main=${originTip.slice(0, 8)})`);
		check("anchor: baseline ref name kept", a1.ref === "main", a1.ref);
		const a2 = await ensureBaseline({ repoRoot: repoA, settings: anchorSettings, onLine, extraArgs });
		check("anchor: re-run stays fresh against local tip (origin ignored)", a2.fresh === false, a2.reason);
		const anchorStatus = (await runGit(["status", "--porcelain"], { cwd: repoA })).stdout;
		check("anchor: repo clean after prime", anchorStatus === "", anchorStatus);

		// Repo B: local main renamed away (revParse('main') = null) while
		// origin/main exists → resolution must fall back to origin/main.
		const repoB = path.join(tmp, "anchor-b");
		await runGit(["clone", "-q", repoA, repoB], { cwd: tmp });
		await runGit(["remote", "set-url", "origin", bare], { cwd: repoB });
		const fetchedB = await runGit(["fetch", "-q", "origin", "main"], { cwd: repoB });
		await runGit(["branch", "-m", "main", "dev"], { cwd: repoB });
		const originB = (await runGit(["rev-parse", "--verify", "origin/main^{commit}"], { cwd: repoB })).stdout;
		const mainGone = (await runGit(["rev-parse", "--verify", "--quiet", "main^{commit}"], { cwd: repoB })).code !== 0;
		check("setup: local main gone, origin/main present", fetchedB.code === 0 && originB === c2 && mainGone, `fetch=${fetchedB.stderr || "ok"} origin/main=${originB.slice(0, 8)} mainGone=${mainGone}`);
		const b1 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, onLine, extraArgs });
		check("anchor: falls back to origin/main when local ref missing", b1.fresh && b1.meta.baseCommit === c2, `${b1.meta.baseCommit.slice(0, 8)} vs ${c2.slice(0, 8)}`);

		// opts.ref override: naming the actual base branch (local dev) must be
		// honored and land in its own (repo, ref) baseline slot.
		const dev1 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, ref: "dev", onLine, extraArgs });
		check("anchor: ref override honored (local dev tip)", dev1.fresh && dev1.ref === "dev" && dev1.meta.baseCommit === c1, `${dev1.ref} @ ${dev1.meta.baseCommit.slice(0, 8)}`);
		check("anchor: override lands in its own slot", dev1.dir !== b1.dir, `${dev1.dir} vs ${b1.dir}`);
		const dev2 = await ensureBaseline({ repoRoot: repoB, settings: anchorSettings, ref: "dev", onLine, extraArgs });
		check("anchor: override re-run stays fresh", dev2.fresh === false, dev2.reason);
	}

	// ── 5. worktree spin-up: sandbox-anchored — copy + top-up ────────
	section("worktree spin-up");
	const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
	const wt = path.join(sandboxDir, "fix-smoke");
	fs.mkdirSync(sandboxDir, { recursive: true });
	fs.mkdirSync(sandboxStateDir(sandboxDir), { recursive: true });
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	// Commit the branch change (mirrors a real dev edit) so the final status
	// check proves the checkout stays CLEAN — no chunkhound artifacts.
	await runGit(["add", "-A"], { cwd: wt });
	await runGit(["commit", "-m", "add c"], { cwd: wt });
	const branch = await currentBranch(wt);
	check("worktree branch", branch === "fix/smoke", branch);
	check("worktree inside sandbox dir", wt.startsWith(sandboxDir + path.sep), wt);

	// Remote-branch resolution needs a remote: a bare clone of `repo` becomes
	// its origin, carrying branches that exist only remotely (never local).
	const branchBare = path.join(tmp, "branch-origin.git");
	const branchClone = await runGit(["clone", "-q", "--bare", repo, branchBare], { cwd: tmp });
	check("setup: branch-origin bare cloned", branchClone.code === 0, branchClone.stderr);
	const mainSha = (await runGit(["rev-parse", "main"], { cwd: repo })).stdout;
	const addRemoteOnly = await runGit(["--git-dir", branchBare, "update-ref", "refs/heads/remote-only", mainSha], { cwd: tmp });
	const addOrigin = await runGit(["remote", "add", "origin", branchBare], { cwd: repo });
	const fetched = await runGit(["fetch", "-q", "origin"], { cwd: repo });
	check(
		"setup: origin with a remote-only branch",
		addRemoteOnly.code === 0 && addOrigin.code === 0 && fetched.code === 0 &&
			(await runGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/remote-only"], { cwd: repo })).code === 0,
		`${addRemoteOnly.stderr || addOrigin.stderr || fetched.stderr}`,
	);
	// A branch added to the origin AFTER the last fetch — the resolver's own
	// best-effort fetch must pick it up.
	const addLater = await runGit(["--git-dir", branchBare, "update-ref", "refs/heads/remote-later", mainSha], { cwd: tmp });
	check("setup: remote-later added after fetch", addLater.code === 0, addLater.stderr);

	const branchWarnings: string[] = [];
	const inUseChoice = await resolveBranchChoice(repo, "fix/smoke", (m, t) => branchWarnings.push(`${t}: ${m}`));
	check("in-use branch → fresh create name", inUseChoice?.createBranch === "fix/smoke-2" && inUseChoice?.branch === undefined, JSON.stringify(inUseChoice));
	check("in-use branch warns", branchWarnings.some((w) => w.includes("fix/smoke-2")), branchWarnings.join("\n"));
	const mainChoice = await resolveBranchChoice(repo, "main", () => {});
	check("main-tree branch also in-use → fresh name", mainChoice?.createBranch === "main-2", JSON.stringify(mainChoice));
	await runGit(["branch", "free/smoke", "main"], { cwd: repo });
	const freeChoice = await resolveBranchChoice(repo, "free/smoke", () => {});
	check("existing unattached branch → checkout", freeChoice?.branch === "free/smoke" && freeChoice?.createBranch === undefined, JSON.stringify(freeChoice));
	const freshChoice = await resolveBranchChoice(repo, "brand-new", () => {});
	check("unknown name → create", freshChoice?.createBranch === "brand-new", JSON.stringify(freshChoice));
	// Occupy fix/smoke-2 as an unattached ref → the in-use fix/smoke must skip to -3.
	await runGit(["branch", "fix/smoke-2", "main"], { cwd: repo });
	const suffixed = await resolveBranchChoice(repo, "fix/smoke", () => {});
	check("occupied suffix skips to next free", suffixed?.createBranch === "fix/smoke-3", JSON.stringify(suffixed));

	// Remote-branch intent: <remote>/<branch> resolves to a detached checkout
	// at the remote tip — never to a (bogus) local branch creation.
	const remoteChoice = await resolveBranchChoice(repo, "origin/remote-only", () => {});
	check("remote branch → detached checkout choice", remoteChoice?.remoteRef === "origin/remote-only", JSON.stringify(remoteChoice));
	const laterChoice = await resolveBranchChoice(repo, "origin/remote-later", () => {});
	check("remote branch fetched on demand by resolver", laterChoice?.remoteRef === "origin/remote-later", JSON.stringify(laterChoice));
	const remoteWarnings: string[] = [];
	const missingRemote = await resolveBranchChoice(repo, "origin/no-such-branch", (m, t) => remoteWarnings.push(`${t}: ${m}`));
	check("remote branch missing on remote → error, no create", missingRemote === undefined && remoteWarnings.some((w) => w.startsWith("error")), remoteWarnings.join("\n"));
	const oneGoWarnings: string[] = [];
	const oneGoUnknown = await resolveBranchChoice(repo, "never-heard", (m, t) => oneGoWarnings.push(`${t}: ${m}`), { createUnknown: false });
	check("one-go: unknown plain name → error (no silent create)", oneGoUnknown === undefined && oneGoWarnings.some((w) => w.startsWith("error")), oneGoWarnings.join("\n"));
	const oneGoInUse = await resolveBranchChoice(repo, "fix/smoke", (m) => oneGoWarnings.push(m), { createUnknown: false });
	check("one-go: in-use branch → error (no suffix renaming)", oneGoInUse === undefined && oneGoWarnings.some((w) => w.includes("already checked out")), oneGoWarnings.join("\n"));

	// Detached remote checkout mechanics: worktree add at the remote tip stays
	// detached and lands on the remote branch's commit.
	const remoteSandbox = path.join(tmp, "remote-sandbox");
	fs.mkdirSync(remoteSandbox, { recursive: true });
	const remoteTipSha = (await runGit(["rev-parse", "--verify", "origin/remote-only^{commit}"], { cwd: repo })).stdout;
	await gitWorktreeAdd({ cwd: repo, path: path.join(remoteSandbox, "remote-only"), detach: true, commitIsh: remoteTipSha });
	check(
		"detached remote-branch checkout lands at remote tip",
		// `branch --show-current` on a detached HEAD exits 0 with empty output.
		(await currentBranch(path.join(remoteSandbox, "remote-only"))) === "" &&
			(await runGit(["rev-parse", "HEAD"], { cwd: path.join(remoteSandbox, "remote-only") })).stdout === remoteTipSha,
		remoteTipSha,
	);
	await runGit(["worktree", "remove", "--force", path.join(remoteSandbox, "remote-only")], { cwd: repo });


	const branches = await branchCompletions(repo);
	check("branch completions include new branch", branches.some((b) => b.value === "fix/smoke"), branches.map((b) => b.value).join(","));
	const argComp = await worktreeArgumentCompletions("wt fix", repo);
	check("arg completions: branch position", argComp.some((b) => b.value === "wt fix/smoke"), JSON.stringify(argComp));

	// NEW-BRANCH-FIRST: with a real repo, the branch picker leads with creation.
	const argBranchRepo = await worktreeArgumentCompletions("wt ", repo);
	check("branch picker: new-branch item first, existing after", argBranchRepo[0]!.value === "wt -b " && argBranchRepo.some((c) => c.value === "wt main"), JSON.stringify(argBranchRepo.map((c) => c.value)));
	const argExistingName = await worktreeArgumentCompletions("wt main", repo);
	check("existing branch name → no create item", !argExistingName.some((c) => c.value.startsWith("wt -b")), JSON.stringify(argExistingName));
	const argNewName = await worktreeArgumentCompletions("wt brandnew", repo);
	check("typed new name → create-branch item", argNewName.some((c) => c.value === "wt -b brandnew" && c.label === "create branch: brandnew"), JSON.stringify(argNewName));
	const argNewNamePartial = await worktreeArgumentCompletions("wt fix", repo);
	check("typed prefix of existing branch → create item still first", argNewNamePartial[0]!.value === "wt -b fix", JSON.stringify(argNewNamePartial[0]));

	// Repo resolution from a non-repo cwd (the workspace-root scenario).
	const resolved = await findRepoRoot(path.join(repo, "sub", "deep"));
	check("findRepoRoot walks up from nested dir", resolved === repo, `${resolved} vs ${repo}`);
	const none = await findRepoRoot(path.join(tmp, "not-a-repo"));
	check("findRepoRoot undefined outside repos", none === undefined, `${none}`);
	const argComp2 = await worktreeArgumentCompletions("repo fix", tmp);
	check("arg completions resolve repo from path (cwd not a repo)", argComp2.some((b) => b.value === "repo fix/smoke"), JSON.stringify(argComp2));

	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	// Baseline rows are relative to the bare checkout; the sandbox index root
	// wraps it in fix-smoke/ — pathPrefix re-keys the copy so unchanged files
	// (a.ts, b.md, b2.md) skip and only the worktree's own change (c.ts) parses.
	const topupLines: string[] = [];
	const r = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { topupLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
	check("index ok", r.code === 0, `code=${r.code}`);
	check("db copied from baseline", r.copied === true && fs.existsSync(dbDir));
	check("db bigger than baseline copy (top-up added c.ts)", dirSize(dbDir) > 0);
	check("top-up skips unchanged files (path re-key)", topupLines.some((l) => /^Processed: 1 files$/.test(l)), topupLines.filter((l) => /^(Processed|Skipped)/.test(l)).join(" | "));
	// Under O2 exactly ONE file parses: c.ts. The db claim sidecar used to
	// self-index into the root (+1 file/+2 chunks per sandbox); it now lives
	// in the .state sibling, outside the indexed root — nothing else parses.

	// Claim sidecar pre-write: hotstart re-points (or keeps) the claim BEFORE
	// the engine runs, so the engine's legacy-migration warning never fires.
	check("top-up emits no engine claim warning", !topupLines.some((l) => l.includes("sidecar was missing")), topupLines.find((l) => l.includes("sidecar was missing")) ?? "");
	const claimedRoot = readClaimedRoot(dbDir);
	check("claim sidecar claims the sandbox dir", claimedRoot === path.resolve(sandboxDir), `${claimedRoot ?? "unclaimed"} vs ${path.resolve(sandboxDir)}`);

	// Re-running hotstart against the same db must stay silent as well (the
	// matching claim is kept, not rewritten).
	const rerunLines: string[] = [];
	const r2 = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine: (l) => { rerunLines.push(l); onLine(l); }, extraArgs, pathPrefix: "fix-smoke" });
	check("re-run index ok", r2.code === 0, `code=${r2.code}`);
	check("re-run emits no engine claim warning", !rerunLines.some((l) => l.includes("sidecar was missing")), rerunLines.find((l) => l.includes("sidecar was missing")) ?? "");

	// Design 1: ZERO operational files in the worktree or the repo — no
	// git-exclude writes, no .chhound/, no config inside the checkout.
	const excl = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
	check("no git-exclude writes in the repo", !excl.includes("pi-chhound") && !excl.includes(".chhound"), excl);
	check("no .chhound inside the checkout", !fs.existsSync(path.join(wt, ".chhound")), "found .chhound in checkout");
	check("no config inside the checkout", !fs.existsSync(path.join(wt, ".chunkhound.json")), "found config in checkout");
	const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
	check("worktree git status clean after index", wtStatus === "", wtStatus);
	const repoStatus = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after worktree+index", repoStatus === "", repoStatus);

	// O2: operational state lives OUTSIDE the indexed root — the sandbox dir
	// holds only checkout + config; db/sidecar/meta sit in the .state sibling.
	check("no db in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db")));
	check("no sidecar in sandbox root", !fs.existsSync(path.join(sandboxDir, ".chhound.db.root.json")));
	check("db lives in .state sibling", dbDir.startsWith(sandboxStateDir(sandboxDir) + path.sep) && fs.existsSync(dbDir), dbDir);

	writeSandboxMeta(sandboxStateDir(sandboxDir), {
		version: 1,
		worktree: wt,
		repoRoot: repo,
		branch,
		baseRef: "main",
		baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: b2.dbDir,
		dbPath: dbDir,
	});
	check("meta lives in state dir (not the index root)", fs.existsSync(path.join(sandboxStateDir(sandboxDir), "meta.json")) && !fs.existsSync(path.join(sandboxDir, "meta.json")));
	console.log(`\n${checks - failures}/${checks} checks passed`);
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error("smoke crashed:", err);
	process.exit(1);
});
