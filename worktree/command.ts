import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { baselineDbDirFor, ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { chhoundApiKeyEnv } from "../chhound/cli.js";
import { expandHome, worktreeArgumentCompletions } from "../chhound/completions.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { currentBranch, defaultRemoteBranch, findRepoRoot, gitRootOrNull, gitWorktreeAdd, repoExcludePath, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { createProgressUI, formatElapsed, type ProgressUICtx } from "../chhound/progress.js";
import { findConflictingIndexed, indexedWorktreePaths, listSandboxes, sandboxConfigPath, sandboxDbDir, sandboxDirFor, writeSandboxMeta } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";

const HELP = [
	"/chworktree [repo] [branch] [options]",
	"",
	"required:",
	"  [repo]              a git repository: a path inside one, the repo's own",
	"                      directory, or nothing when the cwd is inside a repo.",
	"optional:",
	"  [branch]            existing branch to check out (picker leads with 'new branch')",
	"  -b <name>           create a new branch with an explicit name",
	"  --from <ref>        base commit/branch/tag for the worktree",
	"  --dest <dir>        parent folder for the worktree — the worktree dir is named",
	"                      <repo>-wt (suffix -2 on collision). Blocks when the location",
	"                      is already part of another chunkhound index.",
	"  --config <file>     adopt an existing chunkhound.json for this worktree",
	"  --no-index          skip indexing (worktree only)",
	"  --force-reindex    full re-index instead of baseline top-up",
	"  --refresh-baseline force baseline re-prime",
	"",
	"Two ways to invoke:",
	"  wizard:  /chworktree [repo] with no other arguments — asks for the branch name",
	"           and the destination folder interactively (with no argument at all it",
	"           also lets you pick the repo). The destination must not already be part",
	"           of another chunkhound index — such locations are blocked.",
	"  one-go:  /chworktree [repo] -b <branch> --dest <dir> [options] — everything on",
	"           one line, non-interactive (agents). Without --dest the first argument",
	"           is the worktree location itself, as before.",
	"",
	"Each worktree gets its own chunkhound index: baseline copy + top-up at the",
	"branch point. Indexes live in the sandbox library, not in the worktree.",
].join("\n");

export function registerWorktreeCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("chworktree", {
		description:
			"Create a git worktree with its own chunkhound index. Bare /chworktree [repo] " +
			"runs an interactive wizard (branch, destination); one-go for agents: " +
			"/chworktree [repo] [-b <branch>] [--dest <dir>] [--from <ref>] [--config <file>] " +
			"[--no-index] [--force-reindex] [--refresh-baseline] — /chworktree --help for details",
		getArgumentCompletions: (argumentPrefix) => worktreeArgumentCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args);
			const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

			if (flags["help"] || flags["h"]) {
				notify(HELP, "info");
				return;
			}

			// ── Wizard mode: /chworktree [repo] with no branch and no flags ──
			if (isWizardInvocation(positionals, flags)) {
				await runWizard(ctx, state, positionals[0]);
				return;
			}

			// ── One-go mode (fully non-interactive) ──
			if (flags["dest"] === true) {
				notify("--dest requires a directory: /chworktree [repo] --dest <dir>", "error");
				return;
			}
			const dest = typeof flags["dest"] === "string" ? path.resolve(ctx.cwd, expandHome(flags["dest"])) : undefined;
			const wtArg = positionals[0];
			const requestedPath = wtArg ? path.resolve(ctx.cwd, wtArg) : undefined;

			let repoRoot = await gitRootOrNull(ctx.cwd);
			if (!repoRoot && requestedPath) {
				const probe = fs.existsSync(requestedPath) ? requestedPath : path.dirname(requestedPath);
				repoRoot = await findRepoRoot(probe);
			}
			if (!repoRoot) {
				notify(noRepoMessage(ctx.cwd, wtArg, requestedPath), "error");
				return;
			}
			repoRoot = path.resolve(repoRoot);

			if (!dest && !wtArg) {
				notify(
					"A worktree location is required: /chworktree <path> … (or give --dest <dir> and the " +
						"worktree dir is derived as <repo>-wt).",
					"error",
				);
				return;
			}
			const { wtPath, note } = resolveWorktreeLocation({ repoRoot, positional: requestedPath, dest });
			if (note) notify(note, "info");
			if (dest) fs.mkdirSync(dest, { recursive: true });
			if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length > 0) {
				notify(`Refusing: ${wtPath} exists and is not empty.`, "error");
				return;
			}

			const loaded = loadSettings(repoRoot);
			if (loaded.issue) notify(loaded.issue, "warning");
			const settings = loaded.settings;
			const conflict = findConflictingIndexed(wtPath, indexedWorktreePaths(settings));
			if (conflict) {
				notify(
					`Refusing: ${wtPath} is already part of the chunkhound index for ${conflict}. ` +
						"Pick a different destination (/ch-status lists indexed worktrees).",
					"error",
				);
				return;
			}

			// Branch semantics mirror `git worktree add`:
			//   /chworktree <path> [<existing-branch>]
			//   /chworktree <path> -b <new-branch> [--from <commit-ish>]
			let createBranch: string | undefined;
			let branch: string | undefined;
			let commitIsh: string | undefined;
			if (flags["b"] === true && positionals[1]) {
				createBranch = positionals[1];
			} else if (typeof flags["b"] === "string") {
				createBranch = flags["b"];
			} else if (positionals[1]) {
				branch = positionals[1];
			}
			if (flags["b"] === true && !positionals[1]) {
				notify("-b requires a branch name: /chworktree <path> -b <new-branch>", "error");
				return;
			}
			if (typeof flags["from"] === "string") commitIsh = flags["from"];

			await createIndexedWorktree(ctx, state, {
				repoRoot,
				wtPath,
				settings,
				createBranch,
				branch,
				commitIsh,
				flags,
			});
		},
	});
}

/**
 * Wizard mode = no branch positional, no flags: /chworktree [repo] alone asks
 * for the branch name and destination (and, with no argument at all, the repo).
 */
export function isWizardInvocation(positionals: string[], flags: Record<string, string | true>): boolean {
	return positionals.length <= 1 && Object.keys(flags).length === 0;
}

/**
 * Final worktree location.
 * - With --dest: parent = dest, name = <repo>-wt (suffix -2 on collision) —
 *   the first positional only resolved the repo.
 * - Without --dest: the first positional IS the location; picking the source
 *   repo itself derives a sibling <repo>-wt (as before).
 */
export function resolveWorktreeLocation(opts: {
	repoRoot: string;
	/** Absolute first positional, when given. */
	positional?: string;
	/** Absolute --dest, when given. */
	dest?: string;
}): { wtPath: string; note?: string } {
	if (opts.dest) {
		return { wtPath: deriveWorktreePath(opts.repoRoot, opts.dest) };
	}
	if (opts.positional && opts.positional === opts.repoRoot) {
		const sibling = deriveWorktreePath(opts.repoRoot);
		return {
			wtPath: sibling,
			note: `${path.basename(opts.positional)} is the source repo itself — creating the worktree at ${sibling} instead.`,
		};
	}
	return { wtPath: opts.positional! };
}

/** Worktree location for a repo: `<parent>/<repo>-wt`, `<repo>-wt-2`, … */
export function deriveWorktreePath(repoRoot: string, parent?: string): string {
	const dir = parent ?? path.dirname(repoRoot);
	const base = path.basename(repoRoot);
	let candidate = path.join(dir, `${base}-wt`);
	for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}-wt-${i}`);
	return candidate;
}

function noRepoMessage(cwd: string, wtArg: string | undefined, requestedPath: string | undefined): string {
	const base = requestedPath
		? `${cwd} is not inside a git repo and ${requestedPath} does not resolve to one.`
		: `${cwd} is not inside a git repo.`;
	return [
		`No git repo found: ${base}`,
		"/chworktree creates a worktree OF an existing git repo.",
		"Try: run it from inside the repo, or pass the repo's own directory as the first argument",
		"(a sibling <repo>-wt is derived automatically). If the project should be a repo:",
		`git init ${wtArg ?? cwd} && git -C ${wtArg ?? cwd} add -A && git -C ${wtArg ?? cwd} commit -m init, then retry.`,
		"Bare /chworktree (no arguments) opens an interactive repo picker.",
	].join("\n");
}

/** Shared worktree creation: baseline ensure → sandbox → exclude → top-up. */
async function createIndexedWorktree(
	ctx: { cwd: string; hasUI: boolean; ui: WizardUI },
	state: PluginState,
	opts: {
		repoRoot: string;
		wtPath: string;
		settings: ChhoundSettings;
		createBranch?: string;
		branch?: string;
		commitIsh?: string;
		flags: Record<string, string | true>;
	},
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const { repoRoot, wtPath, settings, createBranch, branch, commitIsh, flags } = opts;

	const progress = createProgressUI(ctx);
	try {
		notify(`Creating worktree ${wtPath}…`, "info");
		try {
			await gitWorktreeAdd({ cwd: repoRoot, path: wtPath, createBranch, branch, commitIsh });
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
		const branchNow = await currentBranch(wtPath);
		// Describe what the branch position did: new branch (explicit -b, typed
		// new name via the picker, or git's path-derived default) vs existing
		// branch vs detached checkout.
		const branchNote = createBranch
			? `new branch ${createBranch}`
			: branch
				? `branch ${branch}`
				: commitIsh
					? `detached @ ${commitIsh}`
					: `new branch ${branchNow}`;

		if (flags["no-index"]) {
			notify(
				`Worktree created (no index): ${wtPath} @ ${branchNow}\nRun /chworktree ${wtPath} --force-reindex later to index it.`,
				"info",
			);
			return;
		}

		// 1) Baseline (primed/refreshed from origin/<ref> when stale)
		progress.setPhase("baseline index");
		// Watch the baseline db dir so the footer shows live growth (and
		// embedding batch progress) during the prime — resolved the same
		// way ensureBaseline computes it internally.
		const baselineRef = settings.baseline?.ref || (await defaultRemoteBranch(repoRoot)) || "main";
		progress.setWatchDir(baselineDbDirFor(repoRoot, baselineRef, settings));
		notify(
			"⏳ Indexing started — the session is busy until it completes and won't accept new messages meanwhile. " +
				"Progress updates in the footer. Tip: /chworktree --no-index creates the worktree without indexing.",
			"warning",
		);
		const baseline = await ensureBaseline({
			repoRoot,
			settings,
			onLine: progress.setLine,
			force: flags["refresh-baseline"] === true,
			apiKey: state.apiKey,
		});

		// 2) Sandbox: config (no secrets, pinned duckdb) + db copy target
		const sandboxDir = sandboxDirFor(repoRoot, wtPath, settings);
		const dbDir = sandboxDbDir(sandboxDir);
		let adopted;
		if (typeof flags["config"] === "string") {
			try {
				adopted = adoptConfigFile(flags["config"], ctx.cwd).adopted;
			} catch (err) {
				notify(err instanceof Error ? err.message : String(err), "error");
				return;
			}
		}
		const configPath = materializeConfig(sandboxDir, { settings, dbDir, adopted });

		// 3) Keep the worktree clean: git-exclude .chhound artifacts (repo-wide
		//    info/exclude — the only one git reads for linked worktrees)
		const excludePath = await repoExcludePath(wtPath);
		if (excludePath) {
			const extra = [".chhound/", ".chhound.json"].filter((p) => {
				try {
					return !fs.readFileSync(excludePath, "utf8").split("\n").includes(p.trim());
				} catch {
					return true;
				}
			});
			if (extra.length > 0) {
				fs.mkdirSync(path.dirname(excludePath), { recursive: true });
				fs.appendFileSync(excludePath, "\n# pi-chhound\n" + extra.join("\n") + "\n");
			}
		}

		// 4) Sync index: baseline db copy + top-up at the worktree's branch point
		progress.setPhase("worktree index (top-up)");
		progress.setWatchDir(dbDir);
		notify(
			`Indexing ${wtPath} (top-up from baseline ${baseline.ref} @ ${baseline.meta.baseCommit.slice(0, 12)})…`,
			"info",
		);
		const result = await hotStartIndex({
			sourceDbDir: baseline.dbDir,
			targetDbDir: dbDir,
			indexDir: wtPath,
			configPath,
			forceReindex: flags["force-reindex"] === true,
			env: chhoundApiKeyEnv(state.apiKey),
			onLine: progress.setLine,
		});
		if (result.code !== 0) {
			const tail = result.stderrTail.split("\n").slice(-4).join("\n");
			notify(`Index failed after ${formatElapsed(progress.elapsed())} (code ${result.code}):\n${tail}`, "error");
			return;
		}

		// 5) Meta + summary
		writeSandboxMeta(sandboxDir, {
			version: 1,
			worktree: wtPath,
			repoRoot,
			branch: branchNow,
			baseRef: baseline.ref,
			baseCommit: baseline.meta.baseCommit,
			chhoundVersion: baseline.meta.chhoundVersion,
			createdAt: new Date().toISOString(),
			copiedFrom: baseline.dbDir,
			dbPath: dbDir,
		});
		notify(
			[
				`✓ ${branchNote} @ ${wtPath} indexed (${result.copied ? "baseline copy + top-up" : "full index"}) in ${formatElapsed(progress.elapsed())}.`,
				`db: ${dbDir}`,
				`config: ${sandboxConfigPath(sandboxDir)}`,
				`Next: cd ${wtPath} && chunkhound mcp --config ${sandboxConfigPath(sandboxDir)}`,
			].join("\n"),
			"info",
		);
	} catch (err) {
		notify(`/chworktree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		progress.done();
	}
}

// ── Interactive wizard ────────────────────────────────────────────────────────

type WizardUI = ProgressUICtx["ui"] & {
	notify(msg: string, type: "info" | "warning" | "error"): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
};

async function runWizard(ctx: { cwd: string; hasUI: boolean; ui: WizardUI }, state: PluginState, positional?: string): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

	// 1) Repo: positional resolves one; otherwise the user picks (or types).
	let repoRoot: string | undefined;
	if (positional) {
		const requestedPath = path.resolve(ctx.cwd, positional);
		const probe = fs.existsSync(requestedPath) ? requestedPath : path.dirname(requestedPath);
		repoRoot = (await gitRootOrNull(ctx.cwd)) ?? (await findRepoRoot(probe));
		if (!repoRoot) {
			notify(
				`${positional} does not resolve to a git repo. Run it from inside the repo, pass the repo's own ` +
					"directory, or run /chworktree with no arguments to pick a repo from the library.",
				"error",
			);
			return;
		}
	} else {
		repoRoot = await pickRepoInteractive(ctx);
		if (!repoRoot) return; // cancelled
	}
	repoRoot = path.resolve(repoRoot);
	const settings = loadSettings(repoRoot).settings;

	// 2) Branch name — Enter accepts the suggested new branch (<repo>-wt);
	//    a typed name that exists is checked out, anything else is created.
	const defaultBranch = `${path.basename(repoRoot)}-wt`;
	const branchRaw = await ctx.ui.input(`Branch name (Enter = new branch ${defaultBranch}):`, defaultBranch);
	if (branchRaw === undefined) {
		notify("Cancelled.", "info");
		return;
	}
	const branchName = branchRaw.trim();
	let createBranch: string | undefined;
	let branch: string | undefined;
	if (branchName) {
		const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot });
		if (exists.code === 0) branch = branchName;
		else createBranch = branchName;
	}

	// 3) Destination — parent folder; final dir = dest/<repo>-wt (-2 on
	//    collision). Locations already part of another chunkhound index block.
	const defaultDest = path.dirname(repoRoot);
	let destRaw = await ctx.ui.input(`Destination folder (parent of the worktree, Enter = ${defaultDest}):`, defaultDest);
	if (destRaw === undefined) {
		notify("Cancelled.", "info");
		return;
	}
	let dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultDest));
	let wtPath = deriveWorktreePath(repoRoot, dest);
	let conflict = findConflictingIndexed(wtPath, indexedWorktreePaths(settings));
	for (let attempt = 0; attempt < 3 && conflict; attempt++) {
		notify(`Blocked: ${wtPath} is already part of the chunkhound index for ${conflict}. Choose another destination.`, "error");
		destRaw = await ctx.ui.input(`Destination folder (parent of the worktree, Enter = ${defaultDest}):`, defaultDest);
		if (destRaw === undefined) {
			notify("Cancelled.", "info");
			return;
		}
		dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultDest));
		wtPath = deriveWorktreePath(repoRoot, dest);
		conflict = findConflictingIndexed(wtPath, indexedWorktreePaths(settings));
	}
	if (conflict) {
		notify(`Blocked: ${wtPath} is already part of the chunkhound index for ${conflict}. /ch-status lists indexed worktrees.`, "error");
		return;
	}
	fs.mkdirSync(dest, { recursive: true });

	await createIndexedWorktree(ctx, state, { repoRoot, wtPath, settings, createBranch, branch, flags: {} });
}

const OTHER_REPO = "type a path…";

/** Repo picker for bare /chworktree: current repo + library repos, or a typed path. */
async function pickRepoInteractive(ctx: { cwd: string; hasUI: boolean; ui: WizardUI }): Promise<string | undefined> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const settings = loadSettings(ctx.cwd).settings;
	const candidates = new Map<string, string>();
	const fromCwd = await gitRootOrNull(ctx.cwd);
	if (fromCwd) candidates.set(`current: ${fromCwd}`, fromCwd);
	for (const b of listBaselines(settings)) {
		if (typeof b.meta?.repoRoot === "string") {
			candidates.set(`${path.basename(b.meta.repoRoot)} (baseline) — ${b.meta.repoRoot}`, b.meta.repoRoot);
		}
	}
	for (const s of listSandboxes(settings)) {
		if (typeof s.meta.repoRoot === "string") {
			candidates.set(`${path.basename(s.meta.repoRoot)} (indexed) — ${s.meta.repoRoot}`, s.meta.repoRoot);
		}
	}
	const options = [...candidates.keys(), OTHER_REPO];
	let choice: string | undefined;
	if (options.length === 1) {
		choice = OTHER_REPO; // nothing known — straight to typed path
	} else {
		choice = await ctx.ui.select("Which repo? (new chunkhound-tracked branch)", options);
		if (choice === undefined) {
			notify("Cancelled.", "info");
			return undefined;
		}
	}
	if (choice !== OTHER_REPO && candidates.has(choice)) return candidates.get(choice)!;

	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await ctx.ui.input("Repo path (a git repository):", "");
		if (raw === undefined) {
			notify("Cancelled.", "info");
			return undefined;
		}
		const p = path.resolve(ctx.cwd, expandHome(raw.trim()));
		const probe = fs.existsSync(p) ? p : path.dirname(p);
		const root = await findRepoRoot(probe);
		if (root) return path.resolve(root);
		notify(`Not a git repo: ${raw}. Try the repo's own directory.`, "error");
	}
	notify("No valid repo selected — cancelling.", "error");
	return undefined;
}
