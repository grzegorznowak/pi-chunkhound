import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { baselineDbDirFor, ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { chhoundApiKeyEnv } from "../chhound/cli.js";
import { expandHome, worktreeArgumentCompletions } from "../chhound/completions.js";
import { WORKTREE_VALUE_FLAGS } from "../chhound/args.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { currentBranch, checkedOutBranches, defaultRemoteBranch, findRepoRoot, gitRootOrNull, gitWorktreeAdd, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { sandboxRoot } from "../chhound/paths.js";
import { createProgressUI, formatElapsed, type ProgressUICtx } from "../chhound/progress.js";
import { promptPath, promptText, type PathPromptUI } from "../chhound/path-input.js";
import { findConflictingIndexed, indexedWorktreePaths, listSandboxes, sandboxConfigPath, sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta } from "../chhound/sandbox.js";
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
	"  --dest <dir>        worktree library root for this invocation — the worktree AND",
	"                      its index land in a storage dir under <dir> (default: the",
	"                      configured worktree library root). Blocks when the location",
	"                      would overlap another chunkhound worktree/index.",
	"  --config <file>     adopt an existing chunkhound.json for this worktree",
	"  --no-index          skip indexing (worktree only)",
	"  --force-reindex    full re-index instead of baseline top-up",
	"  --refresh-baseline force baseline re-prime",
	"",
	"Two ways to invoke:",
	"  wizard:  /chworktree [repo] with no other arguments — asks for the branch name",
	"           and the worktree library root interactively (with no argument at all",
	"           it also lets you pick the repo). Path prompts support TAB completion",
	"           (dirs only, drill-down; TAB accepts, Enter confirms, Esc cancels).",
	"  one-go:  /chworktree [repo] -b <branch> [--dest <dir>] [options] — everything",
	"           on one line, non-interactive (agents). The first argument is always",
	"           the repo.",
	"",
	"Each worktree gets its own chunkhound index (baseline copy + top-up at the",
	"branch point). The checkout lives INSIDE its storage dir in the worktree",
	"library — config, index db, daemon state and checkout together, mirroring the",
	"'/workspaces' pattern. Nothing is ever written into the worktree checkout or",
	"the source repo (no .chunkhound/, no git-exclude edits).",
].join("\n");

/**
 * Decide what `git worktree add` should do with the chosen branch name:
 * - existing branch NOT checked out anywhere → check it out ({branch})
 * - existing branch in use by another worktree → derive a fresh name
 *   ({createBranch}, base-2, base-3, …) and warn — git won't check it out twice
 * - unknown name → create it ({createBranch})
 */
export async function resolveBranchChoice(
	repoRoot: string,
	branchName: string,
	notify: (msg: string, type: "info" | "warning" | "error") => void,
): Promise<{ branch?: string; createBranch?: string }> {
	const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot });
	if (exists.code !== 0) return { createBranch: branchName };
	const inUseAt = (await checkedOutBranches(repoRoot)).get(branchName);
	if (!inUseAt) return { branch: branchName };
	const fresh = await freeBranchName(repoRoot, branchName);
	notify(`Branch '${branchName}' is already checked out at ${inUseAt} — creating '${fresh}' instead.`, "warning");
	return { createBranch: fresh };
}

/** First free name base-2, base-3, … (no ref and not checked out anywhere). */
async function freeBranchName(repoRoot: string, base: string): Promise<string> {
	const checkedOut = await checkedOutBranches(repoRoot);
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		const r = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], { cwd: repoRoot });
		if (r.code !== 0 && !checkedOut.has(candidate)) return candidate;
	}
	throw new Error(`could not derive a free branch name from '${base}'`);
}

export function registerWorktreeCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("chworktree", {
		description:
			"Create a git worktree with its own chunkhound index. Bare /chworktree [repo] " +
			"runs an interactive wizard (branch, destination); one-go for agents: " +
			"/chworktree [repo] [-b <branch>] [--dest <dir>] [--from <ref>] [--config <file>] " +
			"[--no-index] [--force-reindex] [--refresh-baseline] — /chworktree --help for details",
		getArgumentCompletions: (argumentPrefix) => worktreeArgumentCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args, WORKTREE_VALUE_FLAGS);
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
			let dest = typeof flags["dest"] === "string" ? path.resolve(ctx.cwd, expandHome(flags["dest"])) : undefined;
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

			const loaded = loadSettings(repoRoot);
			if (loaded.issue) notify(loaded.issue, "warning");
			const settings = loaded.settings;

			// ── Branch intent (one-go) — decided BEFORE the location, since the
			// sandbox (and thus the worktree folder) is named after the branch. ──
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

			// Explicit one-go choices get hard guards (no silent renaming): a
			// branch already checked out somewhere can't be checked out again,
			// and -b requires a name that doesn't exist as a ref yet.
			if (branch) {
				const inUseAt = (await checkedOutBranches(repoRoot)).get(branch);
				if (inUseAt) {
					notify(
						`Branch '${branch}' is already checked out at ${inUseAt} — pick another branch or create a new one with -b.`,
						"error",
					);
					return;
				}
			}
			if (createBranch) {
				const r = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${createBranch}`], { cwd: repoRoot });
				if (r.code === 0) {
					notify(
						`Branch '${createBranch}' already exists — pass it as the branch argument to check it out, or use a new name with -b.`,
						"error",
					);
					return;
				}
			}
			// No branch given: derive one — the sandbox/worktree folder is named
			// after the branch, so the default is <repo>-wt (run through in-use
			// resolution so it can't collide).
			if (!branch && !createBranch && !commitIsh) {
				const choice = await resolveBranchChoice(repoRoot, `${path.basename(repoRoot)}-wt`, notify);
				branch = choice.branch;
				createBranch = choice.createBranch;
			}

			// ── Location: sandbox-anchored — the checkout lives INSIDE its
			// sandbox dir at <library>/<sandbox>/<branch>. --dest overrides the
			// sandbox library root for this invocation. ──
			const { sandboxDir, wtPath } = resolveSandboxLocation(repoRoot, branch ?? createBranch, settings, dest);

			const conflict = findConflictingIndexed(wtPath, indexedWorktreePaths(settings));
			if (conflict) {
				notify(
					`Refusing: ${wtPath} is already part of the chunkhound index for ${conflict}. ` +
						"Pick a different destination (/ch-status lists indexed worktrees).",
					"error",
				);
				return;
			}
			const sandboxConflict = findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
			if (sandboxConflict) {
				notify(
					`Refusing: the storage dir ${sandboxDir} would overlap worktree ${sandboxConflict}. ` +
						"Pick a different destination (/ch-status lists worktrees).",
					"error",
				);
				return;
			}
			if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length > 0) {
				notify(`Refusing: ${wtPath} exists and is not empty (leftover from a failed run?).`, "error");
				return;
			}

			await createIndexedWorktree(ctx, state, {
				repoRoot,
				sandboxDir,
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
 * for the branch name and the sandbox library root (and, with no argument at
 * all, the repo).
 */
export function isWizardInvocation(positionals: string[], flags: Record<string, string | true>): boolean {
	return positionals.length <= 1 && Object.keys(flags).length === 0;
}

/**
 * Design-1 location: the worktree checkout lives INSIDE its sandbox dir at
 * `<library>/<sandbox>/<branch>` (folder = branch, slashes → "-"). `dest`
 * overrides the sandbox library root for this invocation (--dest / wizard
 * pick); otherwise the configured root applies (settings > env > default).
 * No collision suffixing: the sandbox name is unique per (repo, branch), so a
 * fresh sandbox always yields a fresh folder.
 */
export function resolveSandboxLocation(
	repoRoot: string,
	branch: string | undefined,
	settings: ChhoundSettings,
	dest?: string,
): { sandboxDir: string; wtPath: string } {
	const eff = dest ? { ...settings, sandboxRoot: dest } : settings;
	const finalBranch = branch ?? `${path.basename(repoRoot)}-wt`;
	const sandboxDir = sandboxDirFor(repoRoot, finalBranch, eff);
	const wtPath = path.join(sandboxDir, finalBranch.replace(/\//g, "-"));
	return { sandboxDir, wtPath };
}

function noRepoMessage(cwd: string, wtArg: string | undefined, requestedPath: string | undefined): string {
	const base = requestedPath
		? `${cwd} is not inside a git repo and ${requestedPath} does not resolve to one.`
		: `${cwd} is not inside a git repo.`;
	return [
		`No git repo found: ${base}`,
		"/chworktree creates a worktree OF an existing git repo.",
		"Try: run it from inside the repo, or pass the repo's own directory as the first argument",
		"(the worktree + its index land in the worktree library). If the project should be a repo:",,
		`git init ${wtArg ?? cwd} && git -C ${wtArg ?? cwd} add -A && git -C ${wtArg ?? cwd} commit -m init, then retry.`,
		"Bare /chworktree (no arguments) opens an interactive repo picker.",
	].join("\n");
}

/** Shared worktree creation: sandbox dir → git add → baseline → config → top-up → meta. */
async function createIndexedWorktree(
	ctx: { cwd: string; hasUI: boolean; ui: WizardUI },
	state: PluginState,
	opts: {
		repoRoot: string;
		/** Sandbox dir — the daemon's project dir (checkout + config inside; index state in the sibling `.state/<name>` dir). */
		sandboxDir: string;
		wtPath: string;
		settings: ChhoundSettings;
		createBranch?: string;
		branch?: string;
		commitIsh?: string;
		flags: Record<string, string | true>;
	},
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const { repoRoot, sandboxDir, wtPath, settings, createBranch, branch, commitIsh, flags } = opts;

	const progress = createProgressUI(ctx);
	try {
		notify(`Creating worktree ${wtPath}…`, "info");
		// The checkout lands INSIDE the sandbox dir — make sure the sandbox
		// (config lives there) and its hidden state sibling (db + meta — OUTSIDE
		// the indexed root) exist before `git worktree add`.
		fs.mkdirSync(sandboxDir, { recursive: true });
		fs.mkdirSync(sandboxStateDir(sandboxDir), { recursive: true });
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
				`Worktree created (no index): ${wtPath} @ ${branchNow}\n` +
					`The storage dir has no index yet (nothing is written into the checkout). Re-indexing an\n` +
					`existing worktree is not wired up yet — /ch-status --reindex is the pending path for it.`,
				"info",
			);
			return;
		}

		// Anchor the baseline to the LOCAL ref the worktree's tree comes from, so
		// the top-up stays small. An existing-branch checkout (positional branch,
		// no --from) → that branch's own local tip. A branch created/derived by
		// this invocation (-b, wizard, path-derived, no --from) → the source
		// repo's checked-out branch: git bases `worktree add -b` on the source
		// HEAD. Detached / --from checkouts → no override (default resolution;
		// the top-up cost then tracks divergence from the default ref).
		let baseRef: string | undefined;
		if (!commitIsh) {
			if (branch) baseRef = branch;
			else {
				const headBranch = await currentBranch(repoRoot);
				if (headBranch !== "(detached)") baseRef = headBranch;
			}
		}

		// 1) Baseline (primed/refreshed from the local anchor ref when stale)
		progress.setPhase("baseline index");
		// Watch the baseline db dir so the footer shows live growth (and
		// embedding batch progress) during the prime — resolved the same
		// way ensureBaseline computes it internally.
		const baselineRef = baseRef ?? (settings.baseline?.ref || (await defaultRemoteBranch(repoRoot)) || "main");
		progress.setWatchDir(baselineDbDirFor(repoRoot, baselineRef, settings));
		notify(
			"⏳ Indexing started — the session is busy until it completes and won't accept new messages meanwhile. " +
				"Progress updates in the footer. Tip: /chworktree --no-index creates the worktree without indexing.",
			"warning",
		);
		const baseline = await ensureBaseline({
			repoRoot,
			settings,
			ref: baseRef,
			onLine: progress.setLine,
			onNote: (note) => progress.setNote(note),
			force: flags["refresh-baseline"] === true,
			apiKey: state.apiKey,
		});

		// 2) Sandbox config (no secrets, pinned duckdb) + db copy target — the
		// daemon's project dir is the sandbox dir itself; the duckdb + sidecar
		// live in the hidden `.state` sibling, OUTSIDE the indexed root, so no
		// engine/plugin artifact is ever a scan candidate (no self-vectors).
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

		// 3) Sync index: baseline db copy + top-up at the worktree's branch point.
		// indexDir = the SANDBOX DIR (the daemon's project dir). The db, the root
		// claim sidecar and the wal all anchor on database.path, which points at
		// the `.state` sibling — outside the indexed root — so the engine's own
		// artifacts are never scan candidates.
		progress.setPhase("worktree index (top-up)");
		progress.setWatchDir(dbDir);
		// The baseline db copy happens before the engine starts — label the gap
		// (any engine output clears the note once the index process is live).
		if (flags["force-reindex"] !== true) progress.setNote("copying baseline index…");
		notify(
			`Indexing ${wtPath} (top-up from baseline ${baseline.ref} @ ${baseline.meta.baseCommit.slice(0, 12)})…`,
			"info",
		);
		const result = await hotStartIndex({
			sourceDbDir: baseline.dbDir,
			targetDbDir: dbDir,
			indexDir: sandboxDir,
			configPath,
			forceReindex: flags["force-reindex"] === true,
			// Baseline rows are relative to the bare checkout; the sandbox index
			// root wraps it in <branch>/ — re-key the copy so top-ups skip.
			pathPrefix: path.relative(sandboxDir, wtPath).split(path.sep).join("/"),
			env: chhoundApiKeyEnv(state.apiKey),
			onLine: progress.setLine,
		});
		if (result.code !== 0) {
			const tail = result.stderrTail.split("\n").slice(-4).join("\n");
			notify(`Index failed after ${formatElapsed(progress.elapsed())} (code ${result.code}):\n${tail}`, "error");
			return;
		}

		// 4) Meta + summary — meta.json lives in the state dir, not the index root.
		writeSandboxMeta(sandboxStateDir(sandboxDir), {
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
				`worktree: ${wtPath} (inside its storage dir — the repo stays untouched)`,
				`db: ${dbDir} (index state lives in the .state sibling — outside the indexed root)`,
				`config: ${sandboxConfigPath(sandboxDir)}`,
				`Next: chunkhound mcp ${sandboxDir} --config ${sandboxConfigPath(sandboxDir)}`,
				`Tip: .chunkhound.json sits in the sandbox dir, so 'chunkhound mcp ${sandboxDir}' auto-discovers it — no --config needed.`,
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
	custom?: PathPromptUI["custom"];
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
	//    Prefilled (promptText); typing replaces the suggested name.
	const defaultBranch = `${path.basename(repoRoot)}-wt`;
	const branchRaw = await promptText(ctx.ui, {
		title: "Branch name",
		startValue: defaultBranch,
		hint: `Enter accepts the new branch ${defaultBranch} — typing replaces it`,
	});
	if (branchRaw === undefined) {
		notify("Cancelled.", "info");
		return;
	}
	const branchName = branchRaw.trim();
	let createBranch: string | undefined;
	let branch: string | undefined;
	if (branchName) {
		const choice = await resolveBranchChoice(repoRoot, branchName, notify);
		branch = choice.branch;
		createBranch = choice.createBranch;
	}

	// 3) Worktree library root — the worktree AND its index land in a storage
	//    dir under <root>. Default: the configured worktree library root
	//    (settings > env > XDG state). Roots that would overlap another
	//    chunkhound worktree/index are blocked. Prefilled with the default;
	//    TAB completes like the command-line picker.
	const defaultRoot = sandboxRoot(settings);
	const finalBranch = branch ?? createBranch;
	const promptTitle = (): string =>
		`Worktree library root (worktree + index land in a storage dir under <root>; default: ${defaultRoot}):`;
	let destRaw = await promptPath(ctx.ui, {
		title: promptTitle(),
		cwd: ctx.cwd,
		startValue: defaultRoot,
		paramLabel: "worktree library root",
	});
	if (destRaw === undefined) {
		notify("Cancelled.", "info");
		return;
	}
	let dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultRoot));
	let { sandboxDir, wtPath } = resolveSandboxLocation(repoRoot, finalBranch, settings, dest);
	let conflict =
		findConflictingIndexed(wtPath, indexedWorktreePaths(settings)) ??
		findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
	for (let attempt = 0; attempt < 3 && conflict; attempt++) {
		notify(`Blocked: ${wtPath} would overlap the chunkhound worktree ${conflict}. Choose another root.`, "error");
		destRaw = await promptPath(ctx.ui, {
			title: promptTitle(),
			cwd: ctx.cwd,
			startValue: defaultRoot,
			paramLabel: "worktree library root",
		});
		if (destRaw === undefined) {
			notify("Cancelled.", "info");
			return;
		}
		dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultRoot));
		({ sandboxDir, wtPath } = resolveSandboxLocation(repoRoot, finalBranch, settings, dest));
		conflict =
			findConflictingIndexed(wtPath, indexedWorktreePaths(settings)) ??
			findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
	}
	if (conflict) {
		notify(`Blocked: ${wtPath} would overlap the chunkhound worktree ${conflict}. /ch-status lists worktrees.`, "error");
		return;
	}

	await createIndexedWorktree(ctx, state, { repoRoot, sandboxDir, wtPath, settings, createBranch, branch, flags: {} });
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
		const raw = await promptPath(ctx.ui, { title: "Repo path (a git repository) — TAB completes:", cwd: ctx.cwd, paramLabel: "repo directory" });
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
