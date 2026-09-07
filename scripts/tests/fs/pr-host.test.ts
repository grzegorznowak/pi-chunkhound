import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { currentBranch, gitWorktreeAdd, runGit } from "../../../chhound/git.js";
import { ensureMirror, findLocalRepo, ghPrView, mirrorDir } from "../../../chhound/pr.js";
import { sandboxBranchLabel, sandboxDirFor, sandboxStateDir } from "../../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { resolvePrSandboxHost } from "../../../worktree/command.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 15 legacy checks moved from smoke.ts section 17 (PR resolution,
// hermetic) — the local git host ladder (fake gh shim on PATH, fixture bare
// origin with refs/pull/1/head, pre-seeded mirror, full host resolution) and
// the detached PR-sandbox layout. The pure URL parsing moved to
// unit/pr-identity.test.ts; the real mirror anchor/refresh (ensureBaseline)
// moved to engine/pr-baseline.test.ts. SELF-OWNED fixture: no network, no
// real gh — only local bare clones and a canned `gh` answering `pr view`.

describe("pr host", () => {
	test("legacy PR host ladder + layout obligations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-pr-host-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
				mirrorRoot: path.join(root, "mirrors"),
				indexing: { realtimeBackend: "polling" },
			};
			const git = async (args: string[], opts: { cwd?: string } = {}): Promise<void> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
			};
			const gitOk = async (args: string[], opts: { cwd?: string } = {}) => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
				return r.stdout;
			};

			// Seed repo with main + feature (the PR head); its bare clone is the
			// fixture origin and carries refs/pull/1/head (GitHub-style).
			const seed = path.join(root, "pr-seed");
			fs.mkdirSync(seed);
			await git(["init", "-q", "-b", "main"], { cwd: seed });
			await git(["config", "user.email", "smoke@test"], { cwd: seed });
			await git(["config", "user.name", "Smoke"], { cwd: seed });
			fs.writeFileSync(path.join(seed, "a.ts"), "export const a = 1;\n");
			await git(["add", "-A"], { cwd: seed });
			await git(["commit", "-qm", "init"], { cwd: seed });
			const baseSha = await gitOk(["rev-parse", "HEAD"], { cwd: seed });
			const prBare = path.join(root, "pr-origin.git");
			// The bare clone happens AFTER the feature commit so the head object
			// is in it (update-ref refuses refs to nonexistent objects).
			await git(["checkout", "-q", "-b", "feature"], { cwd: seed });
			fs.writeFileSync(path.join(seed, "a.ts"), "export const a = 2;\n");
			await git(["add", "-A"], { cwd: seed });
			await git(["commit", "-qm", "feature change"], { cwd: seed });
			const headSha = await gitOk(["rev-parse", "feature"], { cwd: seed });
			await git(["clone", "-q", "--bare", seed, prBare], { cwd: root });
			await git(["--git-dir", prBare, "update-ref", "refs/pull/1/head", headSha], { cwd: root });
			const pullRef = await runGit(["--git-dir", prBare, "show-ref", "--verify", "--quiet", "refs/pull/1/head"], { cwd: root });
			await check(t, "setup: refs/pull/1/head on the fixture origin", pullRef.code === 0 && headSha !== baseSha, `${headSha.slice(0, 8)} vs ${baseSha.slice(0, 8)}`);

			// Fake gh on PATH: answers `gh pr view … --json` with canned facts.
			const ghShim = path.join(root, "gh-shim");
			fs.mkdirSync(ghShim);
			const ghJson = JSON.stringify({ number: 1, baseRefName: "main", headRefName: "feature", headRefOid: headSha, state: "OPEN", title: "t" });
			fs.writeFileSync(path.join(ghShim, "gh"), `#!/bin/sh\ncat <<'EOF'\n${ghJson}\nEOF\n`);
			fs.chmodSync(path.join(ghShim, "gh"), 0o755);
			// PATH is kept by isolatedEnv; prepend the shim (restored with env).
			process.env.PATH = ghShim + path.delimiter + (process.env.PATH ?? "");
			const info = await ghPrView("ghuser", "add", 1);
			await check(t, "ghPrView parses the shim json", info.baseRefName === "main" && info.headRefName === "feature" && info.headRefOid === headSha && info.state === "OPEN", JSON.stringify(info));

			// Host ladder rung 1 — a local checkout whose origin IS the repo. The
			// url is github-shaped on purpose: resolution only READS origin urls.
			const localHost = path.join(root, "pr-localhost");
			await git(["clone", "-q", seed, localHost], { cwd: root });
			await git(["remote", "set-url", "origin", "https://github.com/ghuser/add"], { cwd: localHost });
			const found = await findLocalRepo(settings, "ghuser", "add", [localHost]);
			await check(t, "findLocalRepo finds the matching local checkout", found === path.resolve(localHost), `${found} vs ${path.resolve(localHost)}`);
			const notFound = await findLocalRepo(settings, "ghuser", "other", [localHost]);
			await check(t, "findLocalRepo skips non-matching roots", notFound === undefined, String(notFound));

			// Host ladder rung 2 — the bare mirror: pre-seed the deterministic
			// mirror dir with a bare clone (what the network clone produces), then
			// ensureMirror pins the refspec and refreshes from the fixture origin.
			const mirror = mirrorDir(settings, "ghuser", "add");
			fs.mkdirSync(path.dirname(mirror), { recursive: true });
			await git(["clone", "-q", "--bare", prBare, mirror], { cwd: root });
			await git(["--git-dir", prBare, "update-ref", "refs/heads/late-branch", baseSha], { cwd: root });
			const mirrored = await ensureMirror(settings, "ghuser", "add");
			await check(t, "ensureMirror reuses the pre-seeded mirror", mirrored === mirror);
			const fetchCfg = (await runGit(["--git-dir", mirror, "config", "--get-all", "remote.origin.fetch"], { cwd: root })).stdout;
			await check(t, "ensureMirror pins the heads refspec", fetchCfg.includes("+refs/heads/*:refs/heads/*"), fetchCfg);
			const lateRef = await runGit(["--git-dir", mirror, "show-ref", "--verify", "--quiet", "refs/heads/late-branch"], { cwd: root });
			await check(t, "ensureMirror refresh fetched the new branch", lateRef.code === 0, lateRef.stderr);

			// Full host resolution (fake gh, offline): repo-less PR → mirror host;
			// head fetch lands exactly on refs/pull/1/head. ctx is a non-repo dir
			// so the cwd rung of the ladder stays empty.
			const notes: string[] = [];
			const ctx = path.join(root, "ctx");
			fs.mkdirSync(ctx);
			const host = await resolvePrSandboxHost(ctx, settings, { owner: "ghuser", repo: "add", number: 1 }, (m, t2) => notes.push(`${t2}: ${m}`));
			await check(t, "host resolution → mirror repoRoot", host?.repoRoot === mirror, host?.repoRoot);
			await check(t, "host carries gh base + head facts", host?.info.baseRefName === "main" && host?.info.headRefName === "feature", JSON.stringify(host?.info));
			await check(t, "head fetch lands on the PR head commit", host?.headSha === headSha, `${host?.headSha} vs ${headSha}`);
			await check(t, "mirroring announced once", notes.filter((n) => n.startsWith("info")).length === 1, notes.join(" | "));

			// PR sandbox layout: identity pull/1 (folder + name), worktree INSIDE
			// the sandbox dir, detached at the head commit. (The baseline anchor
			// on the mirror is exercised in engine/pr-baseline.test.ts.)
			const prSb = sandboxDirFor(mirror, "pull/1", settings);
			const prWt = path.join(prSb, "pull-1");
			await check(t, "PR sandbox named <repo>-pull-1-<hash>", path.basename(prSb).startsWith("add-pull-1-"), path.basename(prSb));
			fs.mkdirSync(prSb, { recursive: true });
			fs.mkdirSync(sandboxStateDir(prSb), { recursive: true });
			await gitWorktreeAdd({ cwd: mirror, path: prWt, detach: true, commitIsh: headSha });
			await check(
				t,
				"PR checkout detached at the head commit",
				(await currentBranch(prWt)) === "" && (await runGit(["rev-parse", "HEAD"], { cwd: prWt })).stdout === headSha,
				"",
			);
			await check(t, "PR checkout carries the PR content", fs.readFileSync(path.join(prWt, "a.ts"), "utf8").includes("= 2"), "");
			const label = sandboxBranchLabel({ branch: "pull/1", headRef: "feature", headOid: headSha });
			await check(t, "status label carries PR head context", label === `pull/1 · head feature @ ${headSha.slice(0, 8)}`, label);
			await git(["worktree", "remove", "--force", prWt], { cwd: mirror });
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
