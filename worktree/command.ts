import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { baselineDbDirFor, ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { chhoundApiKeyEnv } from "../chhound/cli.js";
import { expandHome, worktreeArgumentCompletions } from "../chhound/completions.js";
import { WORKTREE_VALUE_FLAGS } from "../chhound/args.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { currentBranch, checkedOutBranches, defaultRemoteBranch, fetchRef, findRepoRoot, gitRootOrNull, gitWorktreeAdd, remoteNames, revParse, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { sandboxRoot } from "../chhound/paths.js";
import { createProgressUI, formatElapsed, type ProgressUICtx } from "../chhound/progress.js";
import { promptPath, promptText, type PathPromptUI } from "../chhound/path-input.js";
import { ensureMirror, fetchPrHead, findLocalRepo, ghPrView, mirrorDir, parsePrUrl, type PrInfo, type PrRef } from "../chhound/pr.js";
import { findConflictingIndexed, indexedWorktreePaths, listSandboxes, sandboxConfigPath, sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta, dirSize, readClaimedRoot } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState, SandboxMeta } from "../chhound/types.js";
import { connectEntry } from "../mcp/command.js";

const HELP = [
	"/chworktree [repo] [branch] [options]",
	"",
	"required:",
	"  [repo]              a git repository: a path inside one, the repo's own",
	"                      directory, or nothing when the cwd is inside a repo.",
	"                      A PR URL (https://github.com/<owner>/<repo>/pull/<n>) creates a",
	"                      pull-request sandbox instead (no local checkout needed — the",
	"                      repo is mirrored into the cache on first use).",
	"optional:",
	"  [branch]            existing branch to check out: a local branch or <remote>/<branch> — remote",
	"                      branches are checked out detached at their tip. Picker leads with 'new branch'.",
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
 * Resolved intent for one branch name (shared by the wizard and the one-go
 * path so their semantics never drift):
 * - existing LOCAL branch not checked out anywhere → {branch} — git checks
 *   it out (the ref is passed explicitly, never inferred from the path
 *   basename — slash names like `feature/x` stay correct).
 * - existing local branch in use by another worktree → fresh name
 *   ({createBranch}, base-2, base-3, …) and a warning — git won't check a
 *   branch out twice. With createUnknown:false that is an error instead
 *   (one-go positionals name EXISTING branches only — -b creates).
 * - `<remote>/<branch>` where <remote> is a configured remote → {remoteRef}:
 *   a remote-tracking ref can't be "checked out" as a branch; the checkout
 *   detaches at its tip. Best-effort fetch when no local tracking ref exists
 *   yet (the branch may live on the remote only).
 * - unknown name → create it ({createBranch}) when createUnknown (wizard
 *   typed names); otherwise an error.
 * Returns undefined after notifying when the name can't be honored.
 */
export interface BranchChoice {
	/** Existing unattached LOCAL branch to check out. */
	branch?: string;
	/** New local branch to create (-b <name>). */
	createBranch?: string;
	/** Remote-tracking ref ("origin/x") — checkout detaches at its tip. */
	remoteRef?: string;
}

export async function resolveBranchChoice(
	repoRoot: string,
	branchName: string,
	notify: (msg: string, type: "info" | "warning" | "error") => void,
	opts: { createUnknown?: boolean } = {},
): Promise<BranchChoice | undefined> {
	const { createUnknown = true } = opts;
	const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot });
	if (exists.code === 0) {
		const inUseAt = (await checkedOutBranches(repoRoot)).get(branchName);
		if (!inUseAt) return { branch: branchName };
		if (!createUnknown) {
			notify(
				`Branch '${branchName}' is already checked out at ${inUseAt} — pick another branch or create a new one with -b.`,
				"error",
			);
			return undefined;
		}
		const fresh = await freeBranchName(repoRoot, branchName);
		notify(`Branch '${branchName}' is already checked out at ${inUseAt} — creating '${fresh}' instead.`, "warning");
		return { createBranch: fresh };
	}
	// A "/"-containing name whose first segment is a configured remote is a
	// REMOTE branch intent (remote names cannot contain "/", so the split is
	// unambiguous). Local branches with the same full name already won above.
	const slash = branchName.indexOf("/");
	if (slash > 0) {
		const remote = branchName.slice(0, slash);
		if ((await remoteNames(repoRoot)).includes(remote)) {
			const ref = `refs/remotes/${branchName}`;
			const present = await runGit(["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
			if (present.code !== 0) {
				// Best-effort fetch — the branch may exist on the remote without a
				// local tracking ref yet (never fetched).
				try {
					await fetchRef(repoRoot, branchName.slice(slash + 1), remote);
				} catch {
					// fall through to the check below (offline / no such branch)
				}
				const retry = await runGit(["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
				if (retry.code !== 0) {
					notify(
						`No branch '${branchName.slice(slash + 1)}' on remote '${remote}' — check the name or fetch the remote first.`,
						"error",
					);
					return undefined;
				}
			}
			return { remoteRef: branchName };
		}
	}
	if (!createUnknown) {
		notify(`Branch '${branchName}' does not exist locally — use -b <name> to create a new branch (remote branches: <remote>/<name>).`, "error");
		return undefined;
	}
	return { createBranch: branchName };
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
			"runs an interactive wizard (repo/PR, branch, destination); one-go for agents: " +
			"/chworktree [repo] [-b <branch>] [--dest <dir>] [--from <ref>] [--config <file>] " +
			"[--no-index] [--force-reindex] [--refresh-baseline], or /chworktree <PR-URL> for a " +
			"pull request sandbox — /chworktree --help for details",
		getArgumentCompletions: (argumentPrefix) => worktreeArgumentCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args, WORKTREE_VALUE_FLAGS);
			const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
			const wctx: WizardCtx = { cwd: ctx.cwd, hasUI: ctx.hasUI, ui: ctx.ui, pi };

			if (flags["help"] || flags["h"]) {
				notify(HELP, "info");
				return;
			}

			// ── Wizard mode: /chworktree [repo] with no branch and no flags ──
			if (isWizardInvocation(positionals, flags)) {
				await runWizard(wctx, state, positionals[0]);
				return;
			}

			// ── One-go mode (fully non-interactive) ──
			if (flags["dest"] === true) {
				notify("--dest requires a directory: /chworktree [repo] --dest <dir>", "error");
				return;
			}
			let dest = typeof flags["dest"] === "string" ? path.resolve(ctx.cwd, expandHome(flags["dest"])) : undefined;
			const wtArg = positionals[0];
			// PR URL as the repo slot — the URL carries the repo identity:
			// /chworktree https://github.com/<owner>/<repo>/pull/<n> [--dest …]
			const prFromArg = wtArg ? parsePrUrl(wtArg) : undefined;
			if (prFromArg) {
				if (positionals[1]) {
					notify("A PR URL takes no branch argument — the sandbox branch is pull/<n>.", "error");
					return;
				}
				await runPrOneGo(wctx, state, prFromArg, flags, dest);
				return;
			}
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
			let remoteRef: string | undefined;
			let commitIsh: string | undefined;
			if (flags["b"] === true && positionals[1]) {
				createBranch = positionals[1];
			} else if (typeof flags["b"] === "string") {
				createBranch = flags["b"];
			} else if (positionals[1]) {
				// Positional = an EXISTING branch (local, or <remote>/<branch>).
				// Unknown names are an error here — -b is the create path.
				const choice = await resolveBranchChoice(repoRoot, positionals[1], notify, { createUnknown: false });
				if (!choice) return; // notified
				if (choice.branch) branch = choice.branch;
				else if (choice.remoteRef) remoteRef = choice.remoteRef;
			}
			if (flags["b"] === true && !positionals[1]) {
				notify("-b requires a branch name: /chworktree <path> -b <new-branch>", "error");
				return;
			}
			// Remote-branch checkout = detached at the remote tip: resolve the ref
			// to its commit so the checkout + summary are exact (and stable even
			// if the tracking ref later moves).
			if (remoteRef) {
				const sha = await revParse(repoRoot, remoteRef);
				if (!sha) {
					notify(`Cannot resolve ${remoteRef} to a commit.`, "error");
					return;
				}
				commitIsh = sha;
			}
			if (typeof flags["from"] === "string") commitIsh = flags["from"];

			// Explicit one-go choices get hard guards (no silent renaming): -b
			// requires a name that doesn't exist as a ref yet. (In-use / unknown
			// branch guards live inside resolveBranchChoice above.)
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
				if (!choice) return; // notified
				branch = choice.branch;
				createBranch = choice.createBranch;
			}

			// ── Location: sandbox-anchored — the checkout lives INSIDE its
			// sandbox dir at <library>/<sandbox>/<branch>. --dest overrides the
			// sandbox library root for this invocation. ──
			const loc = await oneGoLocation(repoRoot, branch ?? createBranch ?? remoteRef, settings, dest, notify);
			if (!loc) return; // refused (notified)

			await createIndexedWorktree(wctx, state, {
				repoRoot,
				sandboxDir: loc.sandboxDir,
				wtPath: loc.wtPath,
				settings,
				createBranch,
				branch,
				commitIsh,
				// Remote-branch checkouts: baseline anchored at the remote ref
				// itself; the sandbox carries the remote name as its identity.
				...(remoteRef ? { baseRef: remoteRef, branchLabel: remoteRef } : {}),
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
	ctx: WizardCtx,
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
		/** Baseline anchor ref override (PRs: the PR's base branch; remote-branch checkouts: the remote ref). */
		baseRef?: string;
		/** Logical branch recorded in meta + summary when the checkout is detached (remote refs, PRs) — otherwise the checkout's branch. */
		branchLabel?: string;
		/** PR head branch name — recorded in sandbox meta for /ch-status display. */
		headRef?: string;
		/** PR head commit — recorded in sandbox meta for /ch-status display. */
		headOid?: string;
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
		// branch vs detached checkout (remote refs, --from, PRs).
		const branchNote = createBranch
			? `new branch ${createBranch}`
			: branch
				? `branch ${branch}`
				: commitIsh
					? opts.branchLabel
						? `${opts.branchLabel} @ ${commitIsh.slice(0, 12)}`
						: `detached @ ${commitIsh}`
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
		// the top-up cost then tracks divergence from the default ref). PRs and
		// remote-branch checkouts pass an explicit anchor (opts.baseRef) — the
		// PR's base branch / the remote ref.
		let baseRef = opts.baseRef;
		if (!baseRef && !commitIsh) {
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
		const meta: SandboxMeta = {
			version: 1,
			worktree: wtPath,
			repoRoot,
			branch: opts.branchLabel ?? branchNow,
			baseRef: baseline.ref,
			baseCommit: baseline.meta.baseCommit,
			chhoundVersion: baseline.meta.chhoundVersion,
			createdAt: new Date().toISOString(),
			copiedFrom: baseline.dbDir,
			dbPath: dbDir,
			...(opts.headRef ? { headRef: opts.headRef } : {}),
			...(opts.headOid ? { headOid: opts.headOid } : {}),
		};
		writeSandboxMeta(sandboxStateDir(sandboxDir), meta);
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
		// Single chokepoint for all four entry paths: offer the MCP connect (the
		// /ch-mcp equivalent, daemon mode + session-log record) right after a
		// successful index. Headless runs (no UI) skip silently — the "Next:
		// chunkhound mcp …" tip above stays for them. connectEntry is the SAME
		// shared helper /ch-mcp uses — dedup, connect, record, notify — so the
		// prompt path can never drift from the command's behavior. A failed
		// connect is notified but never fails the worktree creation.
		if (ctx.hasUI) {
			const id = path.basename(sandboxDir);
			const connect = await ctx.ui.confirm(
				"Connect to this worktree via MCP now?",
				`${id} → ${wtPath}\n` +
					"Registers the chh_* MCP tools (as /ch-mcp does) and reconnects automatically on the next session start.\n" +
					`Stop it anytime with /ch-mcp ${id} --disconnect.`,
			);
			if (connect) {
				await connectEntry(
					ctx.pi,
					ctx,
					state,
					{
						dir: sandboxDir,
						stateDir: sandboxStateDir(sandboxDir),
						meta,
						dbSizeBytes: dirSize(dbDir),
						claimedRoot: readClaimedRoot(dbDir),
					},
					{},
				);
			}
		}
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
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	custom?: PathPromptUI["custom"];
};

type RepoPick = { kind: "repo"; root: string } | { kind: "pr"; url: string };

/** Sandbox branch-slot for a PR (identity + worktree folder + meta.branch). */
function prSlot(number: number): string {
	return `pull/${number}`;
}

/** Wizard ctx slice the prompt/flow helpers need (+ pi for the MCP connect). */
type WizardCtx = { cwd: string; hasUI: boolean; ui: WizardUI; pi: ExtensionAPI };

async function runWizard(ctx: WizardCtx, state: PluginState, positional?: string): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

	// 1) Repo / PR: a positional resolves one — a PR URL takes the PR path
	//    (repo + PR identity come from the URL); otherwise the user picks
	//    (the picker offers current repo, library repos, a PR, or a path).
	if (positional) {
		if (parsePrUrl(positional)) {
			await runPrWizard(ctx, state, positional);
			return;
		}
		const requestedPath = path.resolve(ctx.cwd, positional);
		const probe = fs.existsSync(requestedPath) ? requestedPath : path.dirname(requestedPath);
		const repoRoot = (await gitRootOrNull(ctx.cwd)) ?? (await findRepoRoot(probe));
		if (!repoRoot) {
			notify(
				`${positional} does not resolve to a git repo. Run it from inside the repo, pass the repo's own ` +
					"directory, or run /chworktree with no arguments to pick a repo from the library.",
				"error",
			);
			return;
		}
		await runBranchWizard(ctx, state, path.resolve(repoRoot));
		return;
	}
	const choice = await pickRepoInteractive(ctx);
	if (!choice) return; // cancelled
	if (choice.kind === "pr") {
		await runPrWizard(ctx, state, choice.url);
		return;
	}
	await runBranchWizard(ctx, state, choice.root);
}

/** Branch-sandbox wizard: repo known → branch name → library root → create. */
async function runBranchWizard(ctx: WizardCtx, state: PluginState, repoRoot: string): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const settings = loadSettings(repoRoot).settings;

	// Branch name — Enter accepts the suggested new branch (<repo>-wt); a
	// typed name that exists is checked out (a <remote>/<branch> name checks
	// out the remote branch detached), anything else is created.
	// Prefilled (promptText); typing replaces the suggested name.
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
	let remoteRef: string | undefined;
	let commitIsh: string | undefined;
	if (branchName) {
		const choice = await resolveBranchChoice(repoRoot, branchName, notify);
		if (!choice) return; // notified (unknown remote branch / bad name)
		branch = choice.branch;
		createBranch = choice.createBranch;
		remoteRef = choice.remoteRef;
	}
	if (remoteRef) {
		// Remote-branch checkout = detached at the remote tip (see one-go path).
		const sha = await revParse(repoRoot, remoteRef);
		if (!sha) {
			notify(`Cannot resolve ${remoteRef} to a commit.`, "error");
			return;
		}
		commitIsh = sha;
	}

	// Library root prompt (with conflict re-prompts).
	const pick = await promptLibraryRoot(ctx, settings, repoRoot, branch ?? createBranch ?? remoteRef);
	if (!pick) return; // cancelled / blocked (notified)

	await createIndexedWorktree(ctx, state, {
		repoRoot,
		sandboxDir: pick.sandboxDir,
		wtPath: pick.wtPath,
		settings,
		createBranch,
		branch,
		commitIsh,
		// Remote-branch checkouts: baseline anchored at the remote ref itself;
		// the sandbox carries the remote name as its identity.
		...(remoteRef ? { baseRef: remoteRef, branchLabel: remoteRef } : {}),
		flags: {},
	});
}

const OTHER_REPO = "type a path…";
const PICK_PR = "a pull request — paste its GitHub URL";
/** Title of the bare-/chworktree repo-source picker (exported for smoke). */
export const REPO_PICKER_TITLE = "Select a repository";

/** Repo picker for bare /chworktree: current repo + library repos, a PR (URL
 * prompt), or a typed path. */
async function pickRepoInteractive(ctx: WizardCtx): Promise<RepoPick | undefined> {
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
	const options = [...candidates.keys(), PICK_PR, OTHER_REPO];
	const choice = await ctx.ui.select(REPO_PICKER_TITLE, options);
	if (choice === undefined) {
		notify("Cancelled.", "info");
		return undefined;
	}
	if (choice === PICK_PR) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const raw = await promptText(ctx.ui, {
				title: "PR URL",
				hint: "Paste the full URL from the browser: https://github.com/<owner>/<repo>/pull/<n>",
			});
			if (raw === undefined) {
				notify("Cancelled.", "info");
				return undefined;
			}
			const url = raw.trim();
			if (parsePrUrl(url)) return { kind: "pr", url };
			notify(`Not a PR URL: ${url}. Expected https://github.com/<owner>/<repo>/pull/<n>`, "error");
		}
		notify("No valid PR URL — cancelling.", "error");
		return undefined;
	}
	if (choice !== OTHER_REPO && candidates.has(choice)) return { kind: "repo", root: candidates.get(choice)! };

	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await promptPath(ctx.ui, { title: "Repo path (a git repository) — TAB completes:", cwd: ctx.cwd, paramLabel: "repo directory" });
		if (raw === undefined) {
			notify("Cancelled.", "info");
			return undefined;
		}
		const p = path.resolve(ctx.cwd, expandHome(raw.trim()));
		// A pasted PR URL works here too (it carries the repo identity).
		if (parsePrUrl(p)) return { kind: "pr", url: p };
		const probe = fs.existsSync(p) ? p : path.dirname(p);
		const root = await findRepoRoot(probe);
		if (root) return { kind: "repo", root: path.resolve(root) };
		notify(`Not a git repo: ${raw}. Try the repo's own directory.`, "error");
	}
	notify("No valid repo selected — cancelling.", "error");
	return undefined;
}

/**
 * Library root prompt for the wizards: prefilled with the configured root,
 * TAB-completed, and re-prompted (≤3) when the location would overlap another
 * chunkhound worktree/index. Returns undefined when cancelled or blocked.
 */
async function promptLibraryRoot(
	ctx: WizardCtx,
	settings: ChhoundSettings,
	repoRoot: string,
	slot: string | undefined,
): Promise<{ dest: string; sandboxDir: string; wtPath: string } | undefined> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const defaultRoot = sandboxRoot(settings);
	const promptTitle = (): string =>
		`Worktree library root (worktree + index land in a storage dir under <root>; default: ${defaultRoot}):`;
	const compute = (dest: string) => {
		const { sandboxDir, wtPath } = resolveSandboxLocation(repoRoot, slot, settings, dest);
		const conflict =
			findConflictingIndexed(wtPath, indexedWorktreePaths(settings)) ??
			findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
		return { sandboxDir, wtPath, conflict };
	};
	let destRaw = await promptPath(ctx.ui, {
		title: promptTitle(),
		cwd: ctx.cwd,
		startValue: defaultRoot,
		paramLabel: "worktree library root",
	});
	if (destRaw === undefined) {
		notify("Cancelled.", "info");
		return undefined;
	}
	let dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultRoot));
	let { sandboxDir, wtPath, conflict } = compute(dest);
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
			return undefined;
		}
		dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultRoot));
		({ sandboxDir, wtPath, conflict } = compute(dest));
	}
	if (conflict) {
		notify(`Blocked: ${wtPath} would overlap the chunkhound worktree ${conflict}. /ch-status lists worktrees.`, "error");
		return undefined;
	}
	return { dest, sandboxDir, wtPath };
}

// ── PR sandboxes ─────────────────────────────────────────────────────────────

/**
 * PR facts + host repo: gh view (fail fast — no clone for a bad/missing PR),
 * then the host for the worktree — a LOCAL checkout of <owner>/<repo> when
 * one exists (cwd repo or library-known; its cached baseline is reused), else
 * a BARE MIRROR under the mirror cache root (cloned on first use; it hosts
 * the baseline for every later PR of the repo). Finally fetch the PR head
 * (only FETCH_HEAD + objects enter the host repo) and verify it against gh.
 * Exported for the smoke suite.
 */
export async function resolvePrSandboxHost(
	ctxCwd: string,
	discoverySettings: ChhoundSettings,
	pr: PrRef,
	notify: (msg: string, type: "info" | "warning" | "error") => void,
): Promise<{ repoRoot: string; settings: ChhoundSettings; info: PrInfo; headSha: string } | undefined> {
	let info: PrInfo;
	try {
		info = await ghPrView(pr.owner, pr.repo, pr.number);
	} catch (err) {
		notify(err instanceof Error ? err.message : String(err), "error");
		return undefined;
	}
	const preferRoots: string[] = [];
	const cwdRoot = await gitRootOrNull(ctxCwd);
	if (cwdRoot) preferRoots.push(cwdRoot);
	const local = await findLocalRepo(discoverySettings, pr.owner, pr.repo, preferRoots);
	let repoRoot: string;
	if (local) {
		repoRoot = path.resolve(local);
	} else {
		const dir = mirrorDir(discoverySettings, pr.owner, pr.repo);
		notify(`No local checkout of ${pr.owner}/${pr.repo} — mirroring it into the cache (${dir}); later PRs of this repo reuse it.`, "info");
		try {
			repoRoot = await ensureMirror(discoverySettings, pr.owner, pr.repo);
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), "error");
			return undefined;
		}
	}
	const settings = loadSettings(repoRoot).settings;
	let headSha: string;
	try {
		headSha = await fetchPrHead(repoRoot, pr.number);
	} catch (err) {
		notify(err instanceof Error ? err.message : String(err), "error");
		return undefined;
	}
	if (info.headRefOid && headSha !== info.headRefOid) {
		notify(
			`gh reports head ${info.headRefOid.slice(0, 12)} but refs/pull/${pr.number}/head fetched ${headSha.slice(0, 12)} — indexing the fetched commit.`,
			"warning",
		);
	}
	return { repoRoot, settings, info, headSha };
}

/** PR-wizard tail after the URL is validated: gh → host → root prompt → create. */
async function runPrWizard(ctx: WizardCtx, state: PluginState, url: string): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const pr = parsePrUrl(url);
	if (!pr) {
		notify(`Not a PR URL: ${url} — paste the full URL from the browser (https://github.com/<owner>/<repo>/pull/<n>).`, "error");
		return;
	}
	const cwdRoot = await gitRootOrNull(ctx.cwd);
	const discovery = loadSettings(cwdRoot ?? ctx.cwd).settings;
	const host = await resolvePrSandboxHost(ctx.cwd, discovery, pr, notify);
	if (!host) return;
	const slot = prSlot(pr.number);
	const pick = await promptLibraryRoot(ctx, host.settings, host.repoRoot, slot);
	if (!pick) return; // cancelled / blocked (notified)
	await createIndexedWorktree(ctx, state, {
		repoRoot: host.repoRoot,
		sandboxDir: pick.sandboxDir,
		wtPath: pick.wtPath,
		settings: host.settings,
		// Detached at the PR head; baseline anchored at the PR's BASE branch so
		// the top-up only indexes the PR delta.
		commitIsh: host.headSha,
		baseRef: host.info.baseRefName,
		branchLabel: slot,
		headRef: host.info.headRefName,
		headOid: host.headSha,
		flags: {},
	});
}

/** One-go PR path (/chworktree <PR URL> [--dest …]): fully non-interactive. */
async function runPrOneGo(
	ctx: WizardCtx,
	state: PluginState,
	pr: PrRef,
	flags: Record<string, string | true>,
	dest?: string,
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const cwdRoot = await gitRootOrNull(ctx.cwd);
	const discovery = loadSettings(cwdRoot ?? ctx.cwd).settings;
	const host = await resolvePrSandboxHost(ctx.cwd, discovery, pr, notify);
	if (!host) return;
	const slot = prSlot(pr.number);
	const loc = await oneGoLocation(host.repoRoot, slot, host.settings, dest, notify);
	if (!loc) return;
	await createIndexedWorktree(ctx, state, {
		repoRoot: host.repoRoot,
		sandboxDir: loc.sandboxDir,
		wtPath: loc.wtPath,
		settings: host.settings,
		commitIsh: host.headSha,
		baseRef: host.info.baseRefName,
		branchLabel: slot,
		headRef: host.info.headRefName,
		headOid: host.headSha,
		flags,
	});
}

/** One-go location guards — notify + undefined when the location is blocked
 * (shared by the branch and PR one-go paths so their refusals never drift). */
async function oneGoLocation(
	repoRoot: string,
	slot: string | undefined,
	settings: ChhoundSettings,
	dest: string | undefined,
	notify: (msg: string, type: "info" | "warning" | "error") => void,
): Promise<{ sandboxDir: string; wtPath: string } | undefined> {
	const { sandboxDir, wtPath } = resolveSandboxLocation(repoRoot, slot, settings, dest);
	const conflict = findConflictingIndexed(wtPath, indexedWorktreePaths(settings));
	if (conflict) {
		notify(
			`Refusing: ${wtPath} is already part of the chunkhound index for ${conflict}. ` +
				"Pick a different destination (/ch-status lists indexed worktrees).",
			"error",
		);
		return undefined;
	}
	const sandboxConflict = findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
	if (sandboxConflict) {
		notify(
			`Refusing: the storage dir ${sandboxDir} would overlap worktree ${sandboxConflict}. ` +
				"Pick a different destination (/ch-status lists worktrees).",
			"error",
		);
		return undefined;
	}
	if (fs.existsSync(wtPath) && fs.readdirSync(wtPath).length > 0) {
		notify(`Refusing: ${wtPath} exists and is not empty (leftover from a failed run?).`, "error");
		return undefined;
	}
	return { sandboxDir, wtPath };
}
