import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { runGit } from "../../chhound/git.js";
import { dirSize, dirSizeAsync } from "../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { buildWorktreeListLines, collectWorktreeList, entryBadges, groupListInfos, probeWorktreeGit } from "../../worktree/manage.js";
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

			const result = await collectWorktreeList({
				entries,
				settings,
				records: new Map([[fixId, { sandboxId: fixId, state: "connected" }]]),
				livePrefixFor: (id) => (id === fixId ? undefined : id === otherId ? "chh_other" : undefined),
			});
			await check(t, "four rows collected", result.infos.length === 4, String(result.infos.length));

			const [fix, other, pr, gone] = result.infos;
			// Fix sandbox: dirty, on branch fix, +1/-1 vs recorded baseRef main.
			await check(t, "fix: not gone, dirty, branch fix", fix && !fix.gone && fix.git?.dirty === true && fix.git.branch === "fix", JSON.stringify(fix.git));
			await check(t, "fix: +1/-1 vs main (baseRef)", fix.git?.ahead === 1 && fix.git?.behind === 1 && fix.git.vsRef === "main", JSON.stringify(fix.git));
			await check(t, "fix: last commit date matches f1", fix.git?.lastCommit === f1Date, `${fix.git?.lastCommit} vs ${f1Date}`);
			await check(t, "fix: checkout size matches the sync walk", fix.checkoutBytes > 0 && fix.checkoutBytes === dirSize(wtFix), String(fix.checkoutBytes));
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
