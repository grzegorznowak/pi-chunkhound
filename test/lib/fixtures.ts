import fs from "node:fs";
import path from "node:path";
import { ensureBaseline } from "../../chhound/baseline.js";
import { chhoundVersion } from "../../chhound/cli.js";
import { materializeConfig } from "../../chhound/config.js";
import { gitWorktreeAdd, runGit } from "../../chhound/git.js";
import { hotStartIndex } from "../../chhound/hotstart.js";
import { sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta } from "../../chhound/sandbox.js";
import type { ChhoundSettings, SandboxMeta } from "../../chhound/types.js";

/**
 * Fixture factories shared by test files. Construction only — each file owns
 * its instance and its cleanup (no hidden suite-order state, no cross-file
 * fixtures). All helpers must be called AFTER env isolation is applied (they
 * spawn git and, through the product code, the engine via CHHOUND_BINARY).
 */

async function git(args: string[], opts: { cwd?: string } = {}): Promise<void> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function gitOk(args: string[], opts: { cwd?: string } = {}): Promise<string> {
	const r = await runGit(args, opts);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

export interface IndexedSandbox {
	repo: string;
	baseCommit: string;
	/** Primed baseline db the sandbox db was copied from. */
	sourceDbDir: string;
	sandboxDir: string;
	wt: string;
	dbDir: string;
	configPath: string;
	meta: SandboxMeta;
}

export interface BuildIndexedSandboxOptions {
	/** realpath'd fixture root the caller owns (removed by the caller). */
	root: string;
	settings: ChhoundSettings;
	/** Extra engine args, e.g. ["--no-embeddings"]. */
	extraArgs: string[];
	/** Hotstart progress lines (test files that assert on them pass a collector). */
	onLine?: (line: string) => void;
}

/**
 * The smoke "worktree spin-up" recipe: committed repo → baseline prime →
 * fix/smoke worktree with its own file commit → hotStartIndex (db copy +
 * top-up, pathPrefix re-key) → meta in the .state sibling. Produces an
 * engine-indexed sandbox with materialized polling config + claim sidecar.
 */
export async function buildIndexedSandbox(opts: BuildIndexedSandboxOptions): Promise<IndexedSandbox> {
	const { root, settings } = opts;
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	await git(["init", "-b", "main"], { cwd: repo });
	await git(["config", "user.email", "smoke@test"], { cwd: repo });
	await git(["config", "user.name", "Smoke"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
	await git(["add", "-A"], { cwd: repo });
	await git(["commit", "-qm", "init"], { cwd: repo });
	const baseCommit = await gitOk(["rev-parse", "HEAD"], { cwd: repo });
	const b = await ensureBaseline({ repoRoot: repo, settings, extraArgs: opts.extraArgs });

	const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
	const wt = path.join(sandboxDir, "fix-smoke");
	fs.mkdirSync(sandboxDir, { recursive: true });
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	await git(["add", "-A"], { cwd: wt });
	await git(["commit", "-qm", "add c"], { cwd: wt });
	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	const r = await hotStartIndex({
		sourceDbDir: b.dbDir,
		targetDbDir: dbDir,
		indexDir: sandboxDir,
		configPath,
		extraArgs: opts.extraArgs,
		pathPrefix: "fix-smoke",
		onLine: opts.onLine,
	});
	if (r.code !== 0) throw new Error(`hotStartIndex failed (code ${r.code}): ${r.stderrTail}`);
	const meta: SandboxMeta = {
		version: 1,
		worktree: wt,
		repoRoot: repo,
		branch: "fix/smoke",
		baseRef: "main",
		baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: b.dbDir,
		dbPath: dbDir,
	};
	writeSandboxMeta(sandboxStateDir(sandboxDir), meta);
	return { repo, baseCommit, sourceDbDir: b.dbDir, sandboxDir, wt, dbDir, configPath, meta };
}
