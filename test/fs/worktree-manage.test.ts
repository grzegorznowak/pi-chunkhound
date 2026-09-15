import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../chhound/git.js";
import { dirSize, dirSizeAsync, writeSandboxMeta } from "../../chhound/sandbox.js";
import type { SandboxEntry } from "../../chhound/sandbox.js";
import type { ChhoundSettings, SandboxMeta } from "../../chhound/types.js";
import type { ManagerLoadProgress } from "../../worktree/manager-core.js";
import { buildWorktreeListLines, collectWorktreeList, entryBadges, groupListInfos, probeWorktreeGit, removePreviewLines, removeWorktreeEntry } from "../../worktree/manage.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: fs-backed manager checks — the real-git probes and the async
// checkout walk over SELF-OWNED throwaway fixtures under os.tmpdir (never
// the operator's sandbox library): branch vs detached, dirty, upstream-less
// ahead/behind vs the recorded baseRef, last-commit date, checkout sizing
// parity with the sync walk, live/recorded liveness seams, gone worktrees,
// and a full group + render pass. HOME is fake and GIT_CONFIG_NOSYSTEM=1 so
// git never reads the operator's config. No gh is invoked: pull/N-shaped
// sandboxes live on local-only repos (no github identity).
describe("worktree manager (fs)", () => {
	test("collect + probe real worktrees over a fixture library", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-wt-manage-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };

			const git = async (args: string[], opts: { cwd: string }): Promise<string> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
				return r.stdout;
			};
			const cfg = async (cwd: string): Promise<void> => {
				await git(["config", "user.name", "wt-manage"], { cwd });
				await git(["config", "user.email", "wt-manage@test"], { cwd });
			};

			// ── Repo A: main with m1 (a.txt), m2 (b.txt); `fix` branches at m1
			// and later gains f1 — so fix vs main is +1/-1. ──
			const repoA = path.join(root, "fixture-a");
			fs.mkdirSync(repoA);
			await git(["init", "-b", "main"], { cwd: repoA });
			await cfg(repoA);
			fs.writeFileSync(path.join(repoA, "a.txt"), "aaa\n");
			await git(["add", "a.txt"], { cwd: repoA });
			await git(["commit", "-m", "m1"], { cwd: repoA });
			fs.writeFileSync(path.join(repoA, "b.txt"), "bbbb\n");
			await git(["add", "b.txt"], { cwd: repoA });
			await git(["commit", "-m", "m2"], { cwd: repoA });
			const m2 = (await git(["rev-parse", "HEAD"], { cwd: repoA })).trim();
			await git(["branch", "fix", "HEAD~1"], { cwd: repoA });

			// Worktree for the fix sandbox — a.txt + (later) c.txt.
			const wtFix = path.join(root, "sandboxes", "fix-wt");
			await git(["worktree", "add", wtFix, "fix"], { cwd: repoA });
			fs.writeFileSync(path.join(wtFix, "c.txt"), "ccccc\n");
			await git(["add", "c.txt"], { cwd: wtFix });
			await git(["commit", "-m", "f1"], { cwd: wtFix });
			fs.writeFileSync(path.join(wtFix, "dirty.txt"), "dirty\n"); // untracked → dirty
			const f1Date = (await git(["log", "-1", "--format=%cI"], { cwd: wtFix })).trim();

			// Second worktree: `other` checked out at main's tip (clean, 0/0).
			const wtOther = path.join(root, "sandboxes", "other-wt");
			await git(["worktree", "add", "-b", "other", wtOther, "main"], { cwd: repoA });
			const otherDate = (await git(["log", "-1", "--format=%cI"], { cwd: wtOther })).trim();

			// ── Repo B (local-only, no origin): a pull/N-shaped DETACHED sandbox
			// at c1 — gh is never invoked without a github identity. ──
			const repoB = path.join(root, "fixture-b");
			fs.mkdirSync(repoB);
			await git(["init", "-b", "main"], { cwd: repoB });
			await cfg(repoB);
			fs.writeFileSync(path.join(repoB, "seed.txt"), "seed\n");
			await git(["add", "seed.txt"], { cwd: repoB });
			await git(["commit", "-m", "c1"], { cwd: repoB });
			const c1 = (await git(["rev-parse", "HEAD"], { cwd: repoB })).trim();
			const wtPr = path.join(root, "sandboxes", "pr-wt");
			await git(["worktree", "add", "--detach", wtPr, c1], { cwd: repoB });

			const mkEntry = (over: { wt: string; repo: string; branch: string; baseCommit: string; id: string }): Parameters<typeof collectWorktreeList>[0]["entries"][number] => ({
				dir: path.join(settings.sandboxRoot!, over.id),
				stateDir: path.join(settings.sandboxRoot!, ".state", over.id),
				meta: {
					version: 1,
					worktree: over.wt,
					repoRoot: over.repo,
					branch: over.branch,
					baseRef: "main",
					baseCommit: over.baseCommit,
					chhoundVersion: "test-fixture",
					createdAt: "2026-09-07T00:00:00.000Z",
					copiedFrom: "",
					dbPath: path.join(settings.sandboxRoot!, ".state", over.id, "db"),
				},
				dbSizeBytes: 4096,
				claimedRoot: path.join(settings.sandboxRoot!, over.id),
			});
			const fixId = "sb-fix-00000001";
			const otherId = "sb-other-00000002";
			const prId = "sb-pr-00000003";
			const goneId = "sb-gone-00000004";
			const entries = [
				mkEntry({ wt: wtFix, repo: repoA, branch: "fix", baseCommit: m2, id: fixId }),
				mkEntry({ wt: wtOther, repo: repoA, branch: "other", baseCommit: m2, id: otherId }),
				mkEntry({ wt: wtPr, repo: repoB, branch: "pull/9", baseCommit: c1, id: prId }),
				// A gone sandbox: meta points at a checkout that does not exist.
				mkEntry({ wt: path.join(root, "sandboxes", "gone-wt"), repo: repoA, branch: "gone", baseCommit: m2, id: goneId }),
			];

			const reported: number[] = [];
			const result = await collectWorktreeList({
				entries,
				settings,
				records: new Map([[fixId, { sandboxId: fixId, state: "connected" }]]),
				livePrefixFor: (id) => (id === fixId ? undefined : id === otherId ? "chh_other" : undefined),
				onItem: (index) => { reported.push(index); },
			});
			await check(t, "four rows collected", result.infos.length === 4, String(result.infos.length));
			await check(t, "onItem reports every entry exactly once with its own index", reported.length === 4 && new Set(reported).size === 4 && reported.every((index) => entries[index] !== undefined), JSON.stringify(reported));

			const [fix, other, pr, gone] = result.infos;
			// Fix sandbox: dirty, on branch fix, +1/-1 vs recorded baseRef main.
			await check(t, "fix: not gone, dirty, branch fix", fix && !fix.gone && fix.git?.dirty === true && fix.git.branch === "fix", JSON.stringify(fix.git));
			await check(t, "fix: +1/-1 vs main (baseRef)", fix.git?.ahead === 1 && fix.git?.behind === 1 && fix.git.vsRef === "main", JSON.stringify(fix.git));
			await check(t, "fix: last commit date matches f1", fix.git?.lastCommit === f1Date, `${fix.git?.lastCommit} vs ${f1Date}`);
			await check(t, "fix: checkout size matches the sync walk", fix.checkoutBytes !== undefined && fix.checkoutBytes > 0 && fix.checkoutBytes === dirSize(wtFix), String(fix.checkoutBytes));
			await check(t, "fix: recorded-connected (no live) → ↻", fix.recordedConnected === true && fix.liveMcpPrefix === undefined);
			await check(t, "fix: badge renders +1/-1 and dirty", entryBadges(fix).join(" · ").includes("+1/-1 vs main") && entryBadges(fix).join(" · ").includes("dirty"), entryBadges(fix).join(" · "));

			// Other sandbox: clean, 0/0 (vsRef still resolves to main).
			await check(t, "other: clean branch other", other && !other.gone && other.git?.dirty === false && other.git.branch === "other", JSON.stringify(other.git));
			await check(t, "other: zero counts vs main", other.git?.ahead === 0 && other.git?.behind === 0 && other.git.vsRef === "main", JSON.stringify(other.git));
			await check(t, "other: live MCP prefix seam", other.liveMcpPrefix === "chh_other" && other.recordedConnected === false);
			await check(t, "other: no count badge at 0/0", !entryBadges(other).join(" · ").includes("vs main"), entryBadges(other).join(" · "));

			// pull/N sandbox: detached (by design — no badge), no gh identity.
			await check(t, "pr: detached, head present", pr && !pr.gone && pr.git?.branch === undefined && (pr.git?.headOid.length ?? 0) === 40, JSON.stringify(pr.git));
			await check(t, "pr: compares vs baseRef main", pr.git?.vsRef === "main", JSON.stringify(pr.git));
			await check(t, "pr: no gh attempt without a github identity", pr.pr === undefined && result.ghAttempted === 0 && result.ghFailed === 0, JSON.stringify(result));

			// Gone sandbox: no git data, zero checkout bytes, ✗ badge.
			await check(t, "gone: flagged, no git probe", gone && gone.gone === true && gone.git === undefined && gone.checkoutBytes === 0, JSON.stringify(gone));
			await check(t, "gone: badge", entryBadges(gone).includes("✗ gone"));

			// dirSizeAsync parity on a non-trivial tree (the fixture repo B has
			// .git — a real nested tree) and graceful degradation on a missing
			// path and on a non-git dir.
			await check(t, "size parity on repo B checkout", (await dirSizeAsync(wtPr)) === dirSize(wtPr));
			await check(t, "missing path sizes 0", (await dirSizeAsync(path.join(root, "nope"))) === 0);
			// V2-23 / D7: an unreadable subtree makes the async walk INCOMPLETE
			// (undefined — unmeasured, never a partial sum rendered as a size).
			// The stub keeps this deterministic on every platform/user (chmod is
			// a no-op for root and not portable), and only the DIRECTORY read is
			// failed — a raced FILE still counts 0, like before.
			const wrap = path.join(root, "blocked-wrap");
			const blockedSub = path.join(wrap, "blocked-sub");
			fs.mkdirSync(blockedSub, { recursive: true });
			fs.writeFileSync(path.join(wrap, "ok.txt"), "abc");
			fs.writeFileSync(path.join(blockedSub, "inner.txt"), "0123456789");
			const realReaddir = fs.promises.readdir;
			try {
				fs.promises.readdir = ((p: fs.PathLike, o?: unknown) => {
					if (path.resolve(String(p)) === path.resolve(blockedSub)) {
						return Promise.reject(Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" }));
					}
					return (realReaddir as unknown as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(p, o);
				}) as unknown as typeof fs.promises.readdir;
				const incomplete = await dirSizeAsync(wrap);
				await check(t, "unreadable subtree sizes undefined, never a partial sum", incomplete === undefined, String(incomplete));
			} finally {
				fs.promises.readdir = realReaddir;
			}
			// The other half of the contract: a raced FILE is not incompleteness —
			// it counts 0 and the walk stays a measurement.
			const raceDir = path.join(root, "file-race");
			fs.mkdirSync(raceDir);
			fs.writeFileSync(path.join(raceDir, "keep.txt"), "0123456789");
			fs.writeFileSync(path.join(raceDir, "raced.txt"), "abc");
			const realStat = fs.promises.stat;
			try {
				fs.promises.stat = ((p: fs.PathLike, o?: unknown) => {
					if (path.resolve(String(p)) === path.resolve(raceDir, "raced.txt")) {
						return Promise.reject(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));
					}
					return (realStat as unknown as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(p, o);
				}) as unknown as typeof fs.promises.stat;
				const raced = await dirSizeAsync(raceDir);
				await check(t, "a raced file counts 0 and keeps the walk measured", raced === 10, String(raced));
			} finally {
				fs.promises.stat = realStat;
			}
			const plainDir = path.join(root, "plain-dir");
			fs.mkdirSync(plainDir);
			fs.writeFileSync(path.join(plainDir, "x"), "x");
			await check(t, "non-git dir probes undefined", (await probeWorktreeGit(plainDir)) === undefined);
			await check(t, "missing dir probes undefined", (await probeWorktreeGit(path.join(root, "nope"))) === undefined);

			// Full group + render pass over the collected rows.
			const { groups } = groupListInfos(result.infos, {});
			const lines = buildWorktreeListLines({
				libraryRoot: settings.sandboxRoot!,
				groups,
				total: result.infos.length,
				ghFailed: result.ghFailed,
				ghAttempted: result.ghAttempted,
			}).join("\n");
			await check(t, "render: header", lines.includes("4 sandboxes in 2 projects"), lines.split("\n")[0]);
			await check(t, "render: groups by project", lines.includes("fixture-a (3)") && lines.includes("fixture-b (1)"), lines);
			await check(t, "render: fix row with badges", lines.includes("+1/-1 vs main") && lines.includes("dirty") && lines.includes(`last commit ${f1Date.slice(0, 10)}`), lines);
			await check(t, "render: live marker for other", lines.includes("● other"), lines);
			await check(t, "render: gone badge", lines.includes("✗ gone"));
			await check(t, "render: pr identity without gh state", lines.includes("pull/9"), lines);
			// gone checkout has no git date — and the size column is 0.
			const goneLine = lines.split("\n").find((l) => l.includes("checkout 0 B"));
			await check(t, "render: gone row sizes 0", goneLine !== undefined && goneLine.includes("created 2026-09-07"), goneLine ?? "");
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

describe("removal flow over a fixture library (throwaway)", () => {
	test("rm removes storage + worktree registration, deletes -b branches safely", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-wt-rm-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const git = async (args: string[], opts: { cwd: string }): Promise<string> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
				return r.stdout;
			};
			const cfg = async (cwd: string): Promise<void> => {
				await git(["config", "user.name", "wt-rm"], { cwd });
				await git(["config", "user.email", "wt-rm@test"], { cwd });
			};

			// Repo: main (m1); sandbox branches:
			//  - merged: created at main's tip, no own commits → branch -d OK
			//  - unmerged: created at m1 with a commit on top → -d refuses
			//  - preexisting: a branch that existed before the sandbox
			//    (baseRef === branch in meta) → never deleted
			const repo = path.join(root, "rm-repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await cfg(repo);
			fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
			await git(["add", "a.txt"], { cwd: repo });
			await git(["commit", "-m", "m1"], { cwd: repo });
			const m1 = (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();
			// merged branch (created later, at main tip)
			const wtMerged = path.join(root, "sandboxes", "merged-wt");
			await git(["worktree", "add", "-b", "merged-b", wtMerged, "main"], { cwd: repo });
			// unmerged branch with a commit of its own
			const wtUnmerged = path.join(root, "sandboxes", "unmerged-wt");
			await git(["worktree", "add", "-b", "unmerged-b", wtUnmerged, m1], { cwd: repo });
			fs.writeFileSync(path.join(wtUnmerged, "own.txt"), "own\n");
			await git(["add", "own.txt"], { cwd: wtUnmerged });
			await git(["commit", "-m", "u1"], { cwd: wtUnmerged });
			// pre-existing branch (created BEFORE the sandbox, checked out into it)
			const wtPre = path.join(root, "sandboxes", "pre-wt");
			await git(["branch", "preexisting-b", "main"], { cwd: repo });
			await git(["worktree", "add", wtPre, "preexisting-b"], { cwd: repo });
			// pull/N-shaped sandbox: detached at m1, no local branch
			const wtPr = path.join(root, "sandboxes", "pr-wt");
			await git(["worktree", "add", "--detach", wtPr, m1], { cwd: repo });

			const sandboxDir = (id: string) => path.join(settings.sandboxRoot!, id);
			const stateDir = (id: string) => path.join(settings.sandboxRoot!, ".state", id);
			const mkEntry = (over: { id: string; wt: string; branch: string; baseRef: string; dbBytes?: string }): SandboxEntry => {
				fs.mkdirSync(stateDir(over.id), { recursive: true });
				fs.writeFileSync(path.join(stateDir(over.id), ".chhound.db"), over.dbBytes ?? "db-bytes\n");
				fs.writeFileSync(path.join(stateDir(over.id), "meta.json"), JSON.stringify({ version: 1 }) + "\n", "utf8");
				fs.mkdirSync(sandboxDir(over.id), { recursive: true });
				return {
					dir: sandboxDir(over.id),
					stateDir: stateDir(over.id),
					meta: {
						version: 1,
						worktree: over.wt,
						repoRoot: repo,
						branch: over.branch,
						baseRef: over.baseRef,
						baseCommit: m1,
						chhoundVersion: "test-fixture",
						createdAt: "2026-09-07T00:00:00.000Z",
						copiedFrom: "",
						dbPath: path.join(stateDir(over.id), ".chhound.db"),
					},
					dbSizeBytes: 10,
				};
			};
			const rowFor = async (entry: SandboxEntry) => {
				const res = await collectWorktreeList({ entries: [entry], settings, records: new Map(), livePrefixFor: () => undefined });
				return res.infos[0]!;
			};

			const disconnected: string[] = [];
			const tombstoned: string[] = [];
			const storageOrder: string[] = [];
			const seams = {
				disconnect: async (id: string) => {
					disconnected.push(id);
				},
				tombstone: (id: string) => {
					tombstoned.push(id);
				},
				// Record the removal ORDER while delegating to the real filesystem.
				removeStorage: (target: string) => {
					storageOrder.push(target);
					fs.rmSync(target, { recursive: true, force: true });
				},
			};

			// ── 1) merged-b: everything removed, branch deleted ──
			const merged = mkEntry({ id: "sb-merged-00000001", wt: wtMerged, branch: "merged-b", baseRef: "main" });
			const outcome1 = await removeWorktreeEntry({ row: await rowFor(merged), settings, mcp: seams });
			await check(t, "merged: worktree removed + storage gone", outcome1.worktreeRemoved === true && outcome1.stateDirRemoved === true && outcome1.sandboxDirRemoved === true, JSON.stringify(outcome1));
			await check(t, "merged: branch deleted", outcome1.branchDeleted === "merged-b", JSON.stringify(outcome1));
			await check(t, "merged: dirs are really gone", !fs.existsSync(wtMerged) && !fs.existsSync(stateDir("sb-merged-00000001")) && !fs.existsSync(sandboxDir("sb-merged-00000001")));
			// V2-16: removal ORDER, not just inclusion — sandbox dir, then .state.
			await check(t, "merged: sandbox dir removed before the .state half", storageOrder.length === 2 && storageOrder[0] === sandboxDir("sb-merged-00000001") && storageOrder[1] === stateDir("sb-merged-00000001"), JSON.stringify(storageOrder));
			await check(t, "merged: host branch gone", (await runGit(["show-ref", "--verify", "--quiet", "refs/heads/merged-b"], { cwd: repo })).code !== 0);
			await check(t, "merged: worktree unregistered", (await git(["worktree", "list", "--porcelain"], { cwd: repo })).includes(wtMerged) === false);
			await check(t, "merged: no warnings", outcome1.warnings.length === 0, JSON.stringify(outcome1.warnings));

			// ── 2) unmerged-b: storage + worktree removed, branch KEPT ──
			const unmerged = mkEntry({ id: "sb-unmerged-00000002", wt: wtUnmerged, branch: "unmerged-b", baseRef: "main" });
			const outcome2 = await removeWorktreeEntry({ row: await rowFor(unmerged), settings, mcp: seams });
			await check(t, "unmerged: storage + worktree removed", outcome2.worktreeRemoved === true && outcome2.stateDirRemoved === true && outcome2.sandboxDirRemoved === true, JSON.stringify(outcome2));
			await check(t, "unmerged: branch kept (refused, not forced)", outcome2.branchDeleted === undefined && (outcome2.branchKept ?? "").includes("refused"), JSON.stringify(outcome2));
			await check(t, "unmerged: branch still exists", (await runGit(["show-ref", "--verify", "--quiet", "refs/heads/unmerged-b"], { cwd: repo })).code === 0);

			// ── 3) pre-existing branch: sandbox removed, branch untouched ──
			const pre = mkEntry({ id: "sb-pre-00000003", wt: wtPre, branch: "preexisting-b", baseRef: "preexisting-b" });
			const outcome3 = await removeWorktreeEntry({ row: await rowFor(pre), settings, mcp: seams });
			await check(t, "pre: storage removed", outcome3.stateDirRemoved === true && outcome3.sandboxDirRemoved === true, JSON.stringify(outcome3));
			await check(t, "pre: no delete attempt", outcome3.branchDeleted === undefined && outcome3.branchKept === undefined, JSON.stringify(outcome3));
			await check(t, "pre: branch survives", (await runGit(["show-ref", "--verify", "--quiet", "refs/heads/preexisting-b"], { cwd: repo })).code === 0);

			// ── 4) pull/N-shaped: detached, storage removed, no branch notes ──
			const pr = mkEntry({ id: "sb-pr-00000004", wt: wtPr, branch: "pull/7", baseRef: "main" });
			const outcome4 = await removeWorktreeEntry({ row: await rowFor(pr), settings, mcp: seams });
			await check(t, "pr: storage + worktree removed", outcome4.worktreeRemoved === true && outcome4.stateDirRemoved === true, JSON.stringify(outcome4));
			await check(t, "pr: no branch delete intent", outcome4.branchDeleted === undefined && outcome4.branchKept === undefined, JSON.stringify(outcome4));

			// ── 5) live + recorded seams fire on a dirty checkout ──
			const wtLive = path.join(root, "sandboxes", "live-wt");
			await git(["worktree", "add", "-b", "live-b", wtLive, "main"], { cwd: repo });
			fs.writeFileSync(path.join(wtLive, "scratch.txt"), "scratch\n");
			const live = mkEntry({ id: "sb-live-00000005", wt: wtLive, branch: "live-b", baseRef: "main" });
			const liveRes = await collectWorktreeList({
				entries: [live],
				settings,
				records: new Map([["sb-live-00000005", { sandboxId: "sb-live-00000005", state: "connected" }]]),
				livePrefixFor: () => "chh_live",
			});
			const outcome5 = await removeWorktreeEntry({ row: liveRes.infos[0]!, settings, mcp: seams });
			await check(t, "live: disconnect + tombstone fired", disconnected.includes("sb-live-00000005") && tombstoned.includes("sb-live-00000005"), JSON.stringify({ disconnected, tombstoned }));
			await check(t, "live: outcome flags", outcome5.mcpDisconnected === true && outcome5.tombstoned === true && outcome5.wasLive === true, JSON.stringify(outcome5));
			await check(t, "live: dirty noted", outcome5.hadUncommitted === true, JSON.stringify(outcome5));
			await check(t, "live: dirty checkout removed anyway (--force semantics of git worktree remove)", !fs.existsSync(wtLive));

			// ── 6) gone sandbox: state removed, stale registration pruned ──
			const goneId = "sb-gone-00000006";
			const wtGone = path.join(root, "sandboxes", "gone-wt");
			await git(["worktree", "add", "-b", "gone-b", wtGone, "main"], { cwd: repo });
			fs.rmSync(wtGone, { recursive: true, force: true }); // simulate the checkout disappearing on its own
			const gone = mkEntry({ id: goneId, wt: wtGone, branch: "gone-b", baseRef: "main" });
			const goneRes = await collectWorktreeList({ entries: [gone], settings, records: new Map(), livePrefixFor: () => undefined });
			await check(t, "gone row flagged", goneRes.infos[0]!.gone === true);
			const outcome6 = await removeWorktreeEntry({ row: goneRes.infos[0]!, settings, mcp: seams });
			await check(t, "gone: state removed + stale admin pruned", outcome6.stateDirRemoved === true && outcome6.pruned === true, JSON.stringify(outcome6));
			await check(t, "gone: branch deleted after prune", outcome6.branchDeleted === "gone-b", JSON.stringify(outcome6));
			await check(t, "gone: no stale registration left", (await git(["worktree", "list", "--porcelain"], { cwd: repo })).includes(wtGone) === false);

			await check(t, "main untouched", (await runGit(["show-ref", "--verify", "--quiet", "refs/heads/main"], { cwd: repo })).code === 0);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("manager collector paints metadata rows before the probes settle", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-manager-paint-");
		try {
			const home = await makeFakeHome(root);
			const sandboxLibrary = path.join(root, "sandboxes");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: sandboxLibrary } }));
			const checkout = path.join(root, "checkout");
			fs.mkdirSync(checkout, { recursive: true });
			fs.writeFileSync(path.join(checkout, "file.txt"), "0123456789");
			const sandboxId = "sb-paint-00000001";
			const stateDir = path.join(sandboxLibrary, ".state", sandboxId);
			const dbPath = path.join(stateDir, "db");
			fs.mkdirSync(dbPath, { recursive: true });
			fs.writeFileSync(path.join(dbPath, "index.duckdb"), "x".repeat(2048));
			writeSandboxMeta(stateDir, {
				version: 1, worktree: checkout, repoRoot: path.join(root, "repo"), branch: "feat/paint", baseRef: "main",
				baseCommit: "0".repeat(40), chhoundVersion: "test", createdAt: "2026-09-14T00:00:00.000Z",
				copiedFrom: "", dbPath,
			} satisfies SandboxMeta);
			const progress: ManagerLoadProgress[] = [];
			const { collectManagerItems } = await import("../../worktree/command.js");
			const collected = await collectManagerItems({ cwd: root }, (update) => progress.push(update));
			const first = progress[0]!;
			await check(t, "the first event paints the row from metadata alone", first.done === 0 && first.total === 1 && first.items.length === 1 && first.items[0]?.kind === "sandbox", JSON.stringify({ done: first.done, total: first.total, items: first.items.length }));
			const metaRow = first.items[0];
			await check(t, "the meta row carries identity and db size but no checkout measurement", metaRow?.kind === "sandbox" && metaRow.branch === "feat/paint" && metaRow.dbBytes === dirSize(dbPath) && metaRow.sizeBytes === undefined, JSON.stringify(metaRow));
			const settled = collected[0];
			await check(t, "the settled row fills the checkout size at the same index", settled?.kind === "sandbox" && settled.sizeBytes === dirSize(checkout) && progress.length >= 2 && progress.every((update) => update.items.length === 1), JSON.stringify(progress.map((update) => update.done)));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("a pull/N row reports before the gh state lands", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-manager-pr-update-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const ghShim = path.join(root, "gh-shim");
			fs.mkdirSync(ghShim);
			fs.writeFileSync(path.join(ghShim, "gh"), "#!/bin/sh\necho '{\"state\":\"MERGED\",\"isDraft\":false}'\n");
			fs.chmodSync(path.join(ghShim, "gh"), 0o755);
			process.env.PATH = ghShim + path.delimiter + (process.env.PATH ?? "");
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			const git = async (args: string[]): Promise<void> => {
				const r = await runGit(args, { cwd: repo });
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
			};
			await git(["init", "-q", "-b", "main"]);
			await git(["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
			const wt = path.join(root, "checkouts", "pull-9");
			fs.mkdirSync(wt, { recursive: true });
			fs.writeFileSync(path.join(wt, "file.txt"), "content\n");
			const entry: SandboxEntry = {
				dir: path.join(settings.sandboxRoot!, "sb-pr-00000009"),
				stateDir: path.join(settings.sandboxRoot!, ".state", "sb-pr-00000009"),
				dbSizeBytes: 0,
				meta: {
					version: 1, worktree: wt, repoRoot: repo, branch: "pull/9", baseRef: "main",
					baseCommit: "0".repeat(40), chhoundVersion: "test", createdAt: "2026-09-14T00:00:00.000Z",
					copiedFrom: "", dbPath: path.join(settings.sandboxRoot!, ".state", "sb-pr-00000009", "db"),
				},
			};
			const events: string[] = [];
			const result = await collectWorktreeList({
				entries: [entry], settings, records: new Map(),
				onItem: (_index, info) => events.push(info.pr === undefined ? "item:base" : "item:pr"),
				onUpdate: (_index, info) => events.push(`update:${info.pr?.state ?? "none"}`),
			});
			await check(t, "the row reports before the gh state lands on the same index", events.join(",") === "item:base,update:MERGED", JSON.stringify(events));
			await check(t, "the settled row and the gh counters carry the PR state", result.infos[0]?.pr?.state === "MERGED" && result.ghAttempted === 1 && result.ghFailed === 0, JSON.stringify({ pr: result.infos[0]?.pr, attempted: result.ghAttempted, failed: result.ghFailed }));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("rm engine hard edges: locked refusal, prune honesty, storage-failure ordering, remote-ref survival, force guard", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-wt-edges-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const git = async (args: string[], opts: { cwd: string }): Promise<string> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
				return r.stdout;
			};
			const cfg = async (cwd: string): Promise<void> => {
				await git(["config", "user.name", "wt-edges"], { cwd });
				await git(["config", "user.email", "wt-edges@test"], { cwd });
			};
			const repo = path.join(root, "edges-repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await cfg(repo);
			fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
			await git(["add", "a.txt"], { cwd: repo });
			await git(["commit", "-m", "m1"], { cwd: repo });
			const m1 = (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();

			const sandboxDir = (id: string): string => path.join(settings.sandboxRoot!, id);
			const stateDir = (id: string): string => path.join(settings.sandboxRoot!, ".state", id);
			const mkEntry = (over: { id: string; wt: string; branch: string; baseRef: string }): SandboxEntry => {
				fs.mkdirSync(stateDir(over.id), { recursive: true });
				fs.writeFileSync(path.join(stateDir(over.id), ".chhound.db"), "db-bytes\n");
				fs.writeFileSync(path.join(stateDir(over.id), "meta.json"), JSON.stringify({ version: 1 }) + "\n", "utf8");
				fs.mkdirSync(sandboxDir(over.id), { recursive: true });
				return {
					dir: sandboxDir(over.id),
					stateDir: stateDir(over.id),
					meta: {
						version: 1,
						worktree: over.wt,
						repoRoot: repo,
						branch: over.branch,
						baseRef: over.baseRef,
						baseCommit: m1,
						chhoundVersion: "test-fixture",
						createdAt: "2026-09-07T00:00:00.000Z",
						copiedFrom: "",
						dbPath: path.join(stateDir(over.id), ".chhound.db"),
					},
					dbSizeBytes: 10,
				};
			};
			const rowFor = async (entry: SandboxEntry) => (await collectWorktreeList({ entries: [entry], settings, records: new Map(), livePrefixFor: () => undefined })).infos[0]!;

			const disconnected: string[] = [];
			const tombstoned: string[] = [];
			const seams = {
				disconnect: async (id: string): Promise<void> => { disconnected.push(id); },
				tombstone: (id: string): void => { tombstoned.push(id); },
			};

			// ── A) locked worktree: REFUSE before ANY side effect (A2) ──
			const lockId = "sb-lock-00000001";
			const wtLock = path.join(root, "sandboxes", "lock-wt");
			await git(["worktree", "add", "-b", "lock-b", wtLock, "main"], { cwd: repo });
			await git(["worktree", "lock", "--reason", "held", wtLock], { cwd: repo });
			const lockEntry = mkEntry({ id: lockId, wt: wtLock, branch: "lock-b", baseRef: "main" });
			// Live + recorded seams: without the refusal these WOULD fire.
			const lockRow = (await collectWorktreeList({ entries: [lockEntry], settings, records: new Map([[lockId, { sandboxId: lockId, state: "connected" }]]), livePrefixFor: () => "chh_lock" })).infos[0]!;
			const outLock = await removeWorktreeEntry({ row: lockRow, settings, mcp: seams });
			await check(t, "locked: refused and names the lock", (outLock.refused ?? "").includes("locked"), JSON.stringify(outLock));
			await check(t, "locked: warning carries the unlock hint", outLock.warnings.join("\n").includes("git worktree unlock"), JSON.stringify(outLock.warnings));
			await check(t, "locked: no storage half or worktree touched", outLock.sandboxDirRemoved === false && outLock.stateDirRemoved === false && outLock.worktreeRemoved === false, JSON.stringify(outLock));
			await check(t, "locked: checkout + sandbox + state dirs survive", fs.existsSync(wtLock) && fs.existsSync(sandboxDir(lockId)) && fs.existsSync(stateDir(lockId)));
			await check(t, "locked: registration still lists the path", (await git(["worktree", "list", "--porcelain"], { cwd: repo })).includes(wtLock));
			await check(t, "locked: MCP seams not called", disconnected.length === 0 && tombstoned.length === 0, JSON.stringify({ disconnected, tombstoned }));

			await git(["worktree", "unlock", wtLock], { cwd: repo });
			const unlockedRow = (await collectWorktreeList({ entries: [lockEntry], settings, records: new Map([[lockId, { sandboxId: lockId, state: "connected" }]]), livePrefixFor: () => "chh_lock" })).infos[0]!;
			const outUnlocked = await removeWorktreeEntry({ row: unlockedRow, settings, mcp: seams });
			await check(t, "unlocked: removal proceeds end to end", outUnlocked.refused === undefined && outUnlocked.worktreeRemoved === true && outUnlocked.sandboxDirRemoved === true && outUnlocked.stateDirRemoved === true, JSON.stringify(outUnlocked));
			await check(t, "unlocked: checkout + both halves gone", !fs.existsSync(wtLock) && !fs.existsSync(sandboxDir(lockId)) && !fs.existsSync(stateDir(lockId)));
			await check(t, "unlocked: the seams fire (the lock was the only blocker)", disconnected.includes(lockId) && tombstoned.includes(lockId), JSON.stringify({ disconnected, tombstoned }));

			// ── B) prune honesty (V2-05): `pruned` only for a REAL sweep ──
			const realId = "sb-realprune-000002";
			const wtReal = path.join(root, "sandboxes", "realprune-wt");
			await git(["worktree", "add", "-b", "realprune-b", wtReal, "main"], { cwd: repo });
			fs.rmSync(wtReal, { recursive: true, force: true }); // the checkout vanishes on its own
			const realEntry = mkEntry({ id: realId, wt: wtReal, branch: "realprune-b", baseRef: "main" });
			const outReal = await removeWorktreeEntry({ row: await rowFor(realEntry), settings, mcp: seams });
			await check(t, "stale registration: git really pruned it", outReal.pruned === true, JSON.stringify(outReal));

			const neverId = "sb-neverreg-000003";
			const wtNever = path.join(root, "sandboxes", "never-registered-wt");
			const neverEntry = mkEntry({ id: neverId, wt: wtNever, branch: "never-registered-b", baseRef: "main" });
			const neverRow = await rowFor(neverEntry);
			await check(t, "never-registered sanity: the row is gone", neverRow.gone === true);
			const outNever = await removeWorktreeEntry({ row: neverRow, settings, mcp: seams });
			// exit code 0 with nothing swept must NOT claim a prune (the V2-05 case).
			await check(t, "prune swept nothing → pruned stays false", outNever.pruned === false, JSON.stringify(outNever));
			await check(t, "never-registered: storage removed without the false note", outNever.sandboxDirRemoved === true && outNever.stateDirRemoved === true, JSON.stringify(outNever));

			// ── C) storage-failure ordering (V2-07): sandbox first, .state kept ──
			// The failure is injected through the engine's storage seam (patching `fs`
			// internals is not portable: Node 24 no longer routes `rmSync` through
			// `process.binding`), which also proves the ORDER: the .state half is not
			// even attempted while the sandbox dir is still there.
			const failId = "sb-storagefail-000004";
			const wtFail = path.join(root, "sandboxes", "storagefail-wt");
			await git(["worktree", "add", "-b", "storagefail-b", wtFail, "main"], { cwd: repo });
			const failEntry = mkEntry({ id: failId, wt: wtFail, branch: "storagefail-b", baseRef: "main" });
			fs.writeFileSync(path.join(sandboxDir(failId), "payload.txt"), "payload\n");
			const failRow = await rowFor(failEntry);
			const attempted: string[] = [];
			const outFail = await removeWorktreeEntry({
				row: failRow,
				settings,
				mcp: {
					...seams,
					removeStorage: (target: string) => {
						attempted.push(target);
						if (path.resolve(target) === path.resolve(sandboxDir(failId))) {
							throw Object.assign(new Error("EPERM: fixture storage failure"), { code: "EPERM" });
						}
						fs.rmSync(target, { recursive: true, force: true });
					},
				},
			});
			await check(t, "storage failure: the engine returns (never throws)", outFail !== undefined);
			await check(t, "storage failure: sandbox half reported NOT removed", outFail!.sandboxDirRemoved === false, JSON.stringify(outFail));
			await check(t, "storage failure: .state half kept so the row stays discoverable", outFail!.stateDirRemoved === false && fs.existsSync(stateDir(failId)) && fs.existsSync(sandboxDir(failId)), JSON.stringify({ state: fs.existsSync(stateDir(failId)), sandbox: fs.existsSync(sandboxDir(failId)) }));
			await check(t, "storage failure: warning names the sandbox half", outFail!.warnings.some((w) => w.includes("sandbox dir removal failed")), JSON.stringify(outFail!.warnings));
			await check(t, "storage failure: the worktree step had already run", outFail!.worktreeRemoved === true && !fs.existsSync(wtFail), JSON.stringify(outFail));
			await check(t, "storage failure: the .state half was never even attempted (order)", attempted.length === 1 && path.resolve(attempted[0]!) === path.resolve(sandboxDir(failId)), JSON.stringify(attempted));

			// ── D) <remote>/<branch> slot: the remote-tracking ref survives (V2-18) ──
			const remoteId = "sb-remoteref-000005";
			const wtRemote = path.join(root, "sandboxes", "remoteref-wt");
			await git(["update-ref", "refs/remotes/origin/main", m1], { cwd: repo });
			await git(["worktree", "add", "--detach", wtRemote, "origin/main"], { cwd: repo });
			const remoteEntry = mkEntry({ id: remoteId, wt: wtRemote, branch: "origin/main", baseRef: "origin/main" });
			const outRemote = await removeWorktreeEntry({ row: await rowFor(remoteEntry), settings, mcp: seams });
			await check(t, "remote slot: no branch delete or keep note", outRemote.branchDeleted === undefined && outRemote.branchKept === undefined, JSON.stringify(outRemote));
			await check(t, "remote slot: refs/remotes/origin/main survives unchanged", (await runGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repo })).code === 0 && (await git(["rev-parse", "refs/remotes/origin/main"], { cwd: repo })).trim() === m1);
			await check(t, "remote slot: no local branch of that identity exists", (await runGit(["show-ref", "--verify", "--quiet", "refs/heads/origin/main"], { cwd: repo })).code !== 0);
			await check(t, "remote slot: storage + worktree removed", outRemote.worktreeRemoved === true && outRemote.sandboxDirRemoved === true && outRemote.stateDirRemoved === true, JSON.stringify(outRemote));

			// ── E) engine force guard (V3-12): the extension source needs force ──
			const extId = "sb-extsource-000006";
			const wtExt = path.join(root, "sandboxes", "extsource-wt");
			await git(["worktree", "add", "-b", "extsource-b", wtExt, "main"], { cwd: repo });
			const extEntry = mkEntry({ id: extId, wt: wtExt, branch: "extsource-b", baseRef: "main" });
			const extRow = { ...(await rowFor(extEntry)), runsThisExtension: true };
			const outExtNo = await removeWorktreeEntry({ row: extRow, settings, mcp: seams });
			await check(t, "extension source: refused without force", (outExtNo.refused ?? "").includes("extension"), JSON.stringify(outExtNo));
			await check(t, "extension source: refusal mentions --force", outExtNo.warnings.join("\n").includes("--force"), JSON.stringify(outExtNo.warnings));
			await check(t, "extension source: storage + registration untouched", outExtNo.sandboxDirRemoved === false && outExtNo.stateDirRemoved === false && outExtNo.worktreeRemoved === false && fs.existsSync(sandboxDir(extId)) && fs.existsSync(stateDir(extId)) && fs.existsSync(wtExt), JSON.stringify(outExtNo));
			await check(t, "extension source: registration still lists the path", (await git(["worktree", "list", "--porcelain"], { cwd: repo })).includes(wtExt));
			const outExtForced = await removeWorktreeEntry({ row: extRow, settings, mcp: seams, force: true });
			await check(t, "extension source: force proceeds and removes everything", outExtForced.refused === undefined && outExtForced.worktreeRemoved === true && outExtForced.sandboxDirRemoved === true && outExtForced.stateDirRemoved === true && !fs.existsSync(wtExt) && !fs.existsSync(sandboxDir(extId)) && !fs.existsSync(stateDir(extId)), JSON.stringify(outExtForced));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("an incomplete checkout walk renders as unmeasured, never a partial sum", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-wt-incomplete-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const git = async (args: string[], opts: { cwd: string }): Promise<string> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
				return r.stdout;
			};
			const repo = path.join(root, "incomplete-repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await git(["config", "user.name", "wt-incomplete"], { cwd: repo });
			await git(["config", "user.email", "wt-incomplete@test"], { cwd: repo });
			fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
			await git(["add", "a.txt"], { cwd: repo });
			await git(["commit", "-m", "m1"], { cwd: repo });
			const m1 = (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();
			const wt = path.join(root, "sandboxes", "incomplete-wt");
			await git(["worktree", "add", "-b", "incomplete-b", wt, "main"], { cwd: repo });
			const blocked = path.join(wt, "blocked-sub");
			fs.mkdirSync(blocked);
			fs.writeFileSync(path.join(blocked, "inner.txt"), "0123456789");

			const id = "sb-incomplete-000008";
			const sandboxDir = path.join(settings.sandboxRoot!, id);
			const stateDir = path.join(settings.sandboxRoot!, ".state", id);
			fs.mkdirSync(stateDir, { recursive: true });
			fs.mkdirSync(sandboxDir, { recursive: true });
			const entry: SandboxEntry = {
				dir: sandboxDir,
				stateDir,
				dbSizeBytes: 10,
				meta: {
					version: 1,
					worktree: wt,
					repoRoot: repo,
					branch: "incomplete-b",
					baseRef: "main",
					baseCommit: m1,
					chhoundVersion: "test-fixture",
					createdAt: "2026-09-07T00:00:00.000Z",
					copiedFrom: "",
					dbPath: path.join(stateDir, ".chhound.db"),
				},
			};

			// The walk fails at ONE subtree dir: the whole checkout is unmeasured
			// (undefined), never a partial sum (D7 / review V2-23).
			const realReaddir = fs.promises.readdir;
			let result: Awaited<ReturnType<typeof collectWorktreeList>> | undefined;
			try {
				fs.promises.readdir = ((p: fs.PathLike, o?: unknown) => {
					if (path.resolve(String(p)) === path.resolve(blocked)) {
						return Promise.reject(Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" }));
					}
					return (realReaddir as unknown as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(p, o);
				}) as unknown as typeof fs.promises.readdir;
				result = await collectWorktreeList({ entries: [entry], settings, records: new Map(), livePrefixFor: () => undefined });
			} finally {
				fs.promises.readdir = realReaddir;
			}

			const info = result!.infos[0]!;
			await check(t, "the row is collected but the checkout stays unmeasured", info.gone === false && info.checkoutBytes === undefined, JSON.stringify({ gone: info.gone, bytes: info.checkoutBytes }));
			const lines = buildWorktreeListLines({ libraryRoot: settings.sandboxRoot!, groups: groupListInfos([info], {}).groups, total: 1, ghFailed: 0, ghAttempted: 0 }).join("\n");
			await check(t, "row line renders checkout — · total —", lines.includes("checkout — · total —"), lines);
			await check(t, "group rollup renders checkout — · total —", lines.includes("(1) — db 10 B · checkout — · total —"), lines);
			await check(t, "no partial sum or NaN anywhere", !lines.includes("NaN"), lines);
			const preview = removePreviewLines(info, { branchDelete: false }).join("\n");
			await check(t, "rm preview renders checkout — · total —", preview.includes("checkout — · total —"), preview);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("a bounded gh budget returns a pending PR row instead of blocking", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-gh-budget-");
		const gate = path.join(root, "gh-release");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const ghShim = path.join(root, "gh-shim");
			fs.mkdirSync(ghShim);
			fs.writeFileSync(path.join(ghShim, "gh"), `#!/bin/sh\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\necho '{"state":"MERGED","isDraft":false}'\n`);
			fs.chmodSync(path.join(ghShim, "gh"), 0o755);
			process.env.PATH = ghShim + path.delimiter + (process.env.PATH ?? "");
			const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
			const repo = path.join(root, "budget-repo");
			fs.mkdirSync(repo);
			const git = async (args: string[]): Promise<void> => {
				const r = await runGit(args, { cwd: repo });
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
			};
			await git(["init", "-q", "-b", "main"]);
			await git(["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
			const wt = path.join(root, "checkouts", "pull-11");
			fs.mkdirSync(wt, { recursive: true });
			fs.writeFileSync(path.join(wt, "file.txt"), "content\n");
			const entry: SandboxEntry = {
				dir: path.join(settings.sandboxRoot!, "sb-pr-00000011"),
				stateDir: path.join(settings.sandboxRoot!, ".state", "sb-pr-00000011"),
				dbSizeBytes: 0,
				meta: {
					version: 1,
					worktree: wt,
					repoRoot: repo,
					branch: "pull/11",
					baseRef: "main",
					baseCommit: "0".repeat(40),
					chhoundVersion: "test",
					createdAt: "2026-09-14T00:00:00.000Z",
					copiedFrom: "",
					dbPath: path.join(settings.sandboxRoot!, ".state", "sb-pr-00000011", "db"),
				},
			};
			const started = Date.now();
			const result = await collectWorktreeList({ entries: [entry], settings, records: new Map(), ghWaitMs: 1 });
			const elapsed = Date.now() - started;
			await check(t, "the bounded budget leaves the gh row pending", result.ghPending === 1 && result.infos[0]?.prPending === true, JSON.stringify({ ghPending: result.ghPending, prPending: result.infos[0]?.prPending }));
			await check(t, "no PR state is invented while pending", result.infos[0]?.pr === undefined, JSON.stringify(result.infos[0]?.pr));
			await check(t, "the collector returns promptly (gh is still gated)", elapsed < 5_000, `${elapsed}ms`);
			// Release the shim: the late state lands on the SAME row object, and
			// the worker/child exit so nothing lingers past the test.
			fs.writeFileSync(gate, "go");
			const deadline = Date.now() + 5_000;
			while (result.infos[0]?.pr === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			await check(t, "the late gh state lands after release", result.infos[0]?.pr?.state === "MERGED" && result.ghAttempted === 1 && result.ghFailed === 0, JSON.stringify({ pr: result.infos[0]?.pr, attempted: result.ghAttempted, failed: result.ghFailed }));
		} finally {
			try { fs.writeFileSync(gate, "go"); } catch { /* teardown is best-effort */ }
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
