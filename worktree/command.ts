import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { baselineDbDirFor, baselineDbPathIn, ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { chhoundApiKeyEnv } from "../chhound/cli.js";
import { expandHome, worktreeArgumentCompletions } from "../chhound/completions.js";
import { WORKTREE_VALUE_FLAGS } from "../chhound/args.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { currentBranch, checkedOutBranches, defaultRemoteBranch, fetchRef, findRepoRoot, gitRootOrNull, gitWorktreeAdd, remoteNames, revParse, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { sandboxRoot } from "../chhound/paths.js";
import { createProgressUI, formatElapsed, type ProgressUICtx } from "../chhound/progress.js";
import { promptPath, promptText, type PathPromptUI } from "../chhound/path-input.js";
import { promptPick } from "../chhound/pick-panel.js";
import { ensureMirror, fetchPrHead, findLocalRepo, ghPrView, mirrorDir, parsePrUrl, type PrInfo, type PrRef } from "../chhound/pr.js";
import { findConflictingIndexed, indexedWorktreePaths, listSandboxes, sandboxBranchLabel, sandboxConfigPath, sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta, dirSize, dirSizeAsync, readClaimedRoot } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { BaselineMeta, ChhoundSettings, PluginState, SandboxMeta } from "../chhound/types.js";
import { connectEntry, resolveSandboxMatches } from "../mcp/command.js";
import { disconnectMcp, getMcpConnection } from "../mcp/manager.js";
import { rehydrateConnections, recordConnection } from "../mcp/persist.js";
import type { ConnectionRecord } from "../mcp/persist.js";
import { branchDeleteIntent, buildWorktreeListLines, collectWorktreeList, groupListInfos, listFlagIn, lifeMarker, parseListInvocation, parseRemoveInvocation, removePreviewLines, removeWorktreeEntry, worktreeVerb, type WtListInfo } from "./manage.js";
import { createManagerItemStore, createManagerSession, runManagerSession, baselineMetaItem, managerItemCacheKey, sandboxMetaItem, type ManagerBaselineItem, type ManagerItem, type ManagerLoadProgress, type ManagerSandboxItem, type WizardOutcome } from "./manager-core.js";
import { createWorktreeManagerRpcPresenter } from "./manager-rpc.js";
import { createWorktreeManagerTuiPresenter } from "./manager-tui.js";

const HELP = [
	"/ch-worktree [repo] [branch] [options]     — create a worktree sandbox",
	"/ch-worktree ls [<query>] [--search <t>] [--sort <k>]  — manage: list sandboxes",
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
	"Two ways to create:",
	"  wizard:  /ch-worktree [repo] with no other arguments — asks for the branch name",
	"           and the worktree library root interactively (with no argument at all",
	"           it also lets you pick the repo). Path prompts support TAB completion",
	"           (dirs only, drill-down; TAB accepts, Enter confirms, Esc cancels).",
	"  one-go:  /ch-worktree [repo] -b <branch> [--dest <dir>] [options] — everything",
	"           on one line, non-interactive (agents). The first argument is always",
	"           the repo.",
	"",
	"Manage (ls):",
	"  ls lists every worktree sandbox in the library, grouped by project, with",
	"  space columns (db first, then checkout, then total), git state (branch vs",
	"  detached, dirty, ahead/behind vs the branch upstream or the recorded base",
	"  ref, last commit), liveness (● connected via MCP, ↻ recorded for reconnect,",
	"  ✗ gone) and — for pull-request sandboxes — the PR state via gh.",
	"  <query>             shorthand for --search (the first argument after ls)",
	"  --search <text>     case-insensitive filter over repo, branch, id and paths",
	"  --sort <key>        created (default, newest first) | name | db | checkout | total",
	"                      (numeric keys: largest first; name: A→Z)",
	"  examples: /ch-worktree ls — /ch-worktree ls fix — /ch-worktree ls --search mcp --sort db",
	"",
	"Manage (rm):",
	"  rm removes a worktree sandbox: its storage (sandbox dir + .state index),",
	"  its worktree registration in the host repo, and — for branches created",
	"  for the sandbox only — the branch (git branch -d, NEVER forced, never",
	"  for pull/N or pre-existing branches). A live MCP connection is",
	"  disconnected first (the daemon exits on its own) and the session record",
	"  tombstoned. Shared baselines and the rest of the host repo are never",
	"  touched.",
	"  /ch-worktree rm                 interactive: pick a sandbox, then confirm",
	"                                 the impact preview (headless: shows usage)",
	"  /ch-worktree rm <target>        one-go removal of one sandbox — <target> is",
	"                                 a worktree path, storage id, or basename",
	"                                 (no confirm; guards still apply)",
	"  --force                        remove the sandbox that runs THIS extension",
	"                                 (one-go path; interactive confirms anyway)",
	"",
	"Each worktree gets its own chunkhound index (baseline copy + top-up at the",
	"branch point). The checkout lives INSIDE its storage dir in the worktree",
	"library — config, index db, daemon state and checkout together, mirroring the",
	"'/workspaces' pattern. Nothing is ever written into the worktree checkout or",
	"the source repo (no .chunkhound/, no git-exclude edits).",
	"/ch-worktree rm removes a sandbox; /ch-worktree ls lists the library.",
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

/** Context the manager collector reads — kept as a mutable holder because the
 * session's item store outlives any single command invocation. */
type ManagerCtx = Parameters<typeof collectManagerItems>[0];

export interface WorktreeCommandDeps {
	/** Test seam: builds the session-lifetime manager item store. */
	createItemStore?: typeof createManagerItemStore;
}

export function registerWorktreeCommand(pi: ExtensionAPI, state: PluginState, deps: WorktreeCommandDeps = {}): void {
	// The manager's item store lives for the whole session (one store per
	// registered command), so closing and re-running /ch-worktree reuses the last
	// collect while the library fingerprint is unchanged. The store must never
	// capture an invocation's ctx: each invocation binds its own context — and
	// the library root its settings resolve to — for the duration of the load
	// (`activeLoad`). A second concurrent invocation (impossible while the panel
	// is modal, honored anyway) gets its own isolated store instead of
	// clobbering this one.
	let activeLoad: { ctx: ManagerCtx; settingsRoot: string } | undefined;
	let managerStore: ReturnType<typeof createManagerItemStore> | undefined;
	// Single invalidation funnel: rm, the panel's `r` refresh and a successful
	// create all come through here, so a future write path cannot silently skip
	// the store invalidation (review V3-06).
	const invalidateManagerItems = (): void => {
		managerStore?.invalidate();
	};
	pi.registerCommand("ch-worktree", {
		description:
			"Create a git worktree with its own chunkhound index, or manage the worktree library. " +
			"Creation: /ch-worktree [repo] [-b <branch>] [--dest <dir>] [--from <ref>] [--config <file>] " +
			"[--no-index] [--force-reindex] [--refresh-baseline], or /ch-worktree <PR-URL> for a " +
			"pull request sandbox — bare /ch-worktree [repo] runs an interactive wizard. " +
			"Manage: /ch-worktree ls [<query>] [--search <text>] [--sort <key>] lists every sandbox " +
			"grouped by project with space/git-state/liveness columns; /ch-worktree rm [<target>] [--force] " +
			"removes a sandbox (disconnect, storage, worktree registration, -b branch) — /ch-worktree --help for details",
		getArgumentCompletions: (argumentPrefix) => worktreeArgumentCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args, WORKTREE_VALUE_FLAGS);
			const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
			const wctx: WizardCtx = { cwd: ctx.cwd, hasUI: ctx.hasUI, ui: ctx.ui, pi };

			if (flags["help"] || flags["h"]) {
				notify(HELP, "info");
				return;
			}

			// ── Manager verbs: /ch-worktree ls … and rm … — the
			// first positional names the VERB only when it is one; anything else
			// falls through to the creation flows below (repo paths, PR URLs,
			// branches and the bare wizard keep their existing meanings). ──
			const verb = worktreeVerb(positionals[0]);
			if (verb) {
				const rest = positionals.slice(1);
				if (verb === "remove") {
					await runWorktreeRemove(pi, ctx, rest, flags);
					// The library changed; the session cache must not serve the removed row.
					invalidateManagerItems();
					return;
				}
				await runWorktreeList(ctx, rest, flags);
				return;
			}

			// List-only flags without the verb name the manager surface — refuse
			// instead of silently creating (or mis-parsing) a worktree.
			if (listFlagIn(flags)) {
				notify(
					`--${listFlagIn(flags)} manages the worktree LIST — creation ignores it: /ch-worktree ls [--search <text>] [--sort <key>].`,
					"error",
				);
				return;
			}

			// ── TUI manager: the bare command owns one session across remounts. The
			// item store lives in this closure, so wizard cancel/failure returns to
			// the cached list without recomputing; create success invalidates it. A
			// fingerprint check drops the cache when the library changed underneath
			// (create/remove/liveness), so a reopen never serves a stale list. ──
			if (positionals.length === 0 && Object.keys(flags).length === 0 && ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
				// Bind THIS invocation's ctx + settings root; the fingerprint resolves
				// settings exactly like the collector (`gitRoot ?? cwd` — project
				// settings are exact-root only, review V2-08).
				const bound = { ctx, settingsRoot: (await gitRootOrNull(ctx.cwd)) ?? ctx.cwd };
				const concurrent = activeLoad !== undefined;
				activeLoad = bound;
				if (managerStore === undefined || concurrent) {
					managerStore = (deps.createItemStore ?? createManagerItemStore)((onProgress) => {
						const active = activeLoad ?? bound;
						return collectManagerItems(active.ctx, onProgress, { settingsRoot: active.settingsRoot });
					});
				}
				const store = managerStore;
				const session = createManagerSession();
				try {
					await runManagerSession(ctx, createWorktreeManagerTuiPresenter(ctx, (_session, onProgress) => store.load(onProgress, managerFingerprint(bound.settingsRoot)), { onRefresh: invalidateManagerItems }), {
						session,
						onCreated: invalidateManagerItems,
						runCreate: (_session, positional) => runWizard(wctx, state, positional, { suppressCancelNotify: true }),
					});
				} finally {
					if (activeLoad === bound) activeLoad = undefined;
				}
				return;
			}

			// ── RPC manager: one native select round-trip per manager action. ──
			if (positionals.length === 0 && Object.keys(flags).length === 0 && ctx.mode === "rpc" && typeof ctx.ui.select === "function") {
				await runManagerSession(ctx, createWorktreeManagerRpcPresenter(ctx, () => collectManagerItems(ctx, undefined, { ghWaitMs: GH_STATE_WAIT_MS })), {
					session: createManagerSession(),
					runCreate: (_session, positional) => runWizard(wctx, state, positional, { suppressCancelNotify: true }),
				});
				return;
			}

			// ── Wizard mode: /ch-worktree [repo] with no branch and no flags ──
			if (isWizardInvocation(positionals, flags)) {
				await runWizard(wctx, state, positionals[0]);
				return;
			}

			// ── One-go mode (fully non-interactive) ──
			if (flags["dest"] === true) {
				notify("--dest requires a directory: /ch-worktree [repo] --dest <dir>", "error");
				return;
			}
			let dest = typeof flags["dest"] === "string" ? path.resolve(ctx.cwd, expandHome(flags["dest"])) : undefined;
			const wtArg = positionals[0];
			// PR URL as the repo slot — the URL carries the repo identity:
			// /ch-worktree https://github.com/<owner>/<repo>/pull/<n> [--dest …]
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
				notify("-b requires a branch name: /ch-worktree <path> -b <new-branch>", "error");
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
 * Wizard mode = no branch positional, no flags: /ch-worktree [repo] alone asks
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
		"/ch-worktree creates a worktree OF an existing git repo.",
		"Try: run it from inside the repo, or pass the repo's own directory as the first argument",
		"(the worktree + its index land in the worktree library). If the project should be a repo:",,
		`git init ${wtArg ?? cwd} && git -C ${wtArg ?? cwd} add -A && git -C ${wtArg ?? cwd} commit -m init, then retry.`,
		"Bare /ch-worktree (no arguments) opens an interactive repo picker.",
	].join("\n");
}

/** Shared worktree creation: sandbox dir → git add → baseline → config → top-up → meta. */
export async function createIndexedWorktree(
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
		/** PR head branch name — recorded in sandbox meta for /ch-worktree display. */
		headRef?: string;
		/** PR head commit — recorded in sandbox meta for /ch-worktree display. */
		headOid?: string;
		flags: Record<string, string | true>;
	},
): Promise<{ ok: boolean; sandboxId?: string }> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const { repoRoot, sandboxDir, wtPath, settings, createBranch, branch, commitIsh, flags } = opts;
	const sandboxId = path.basename(sandboxDir);

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
			return { ok: false };
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
					`existing worktree is not wired up yet — remove it and re-create with /ch-worktree instead.`,
				"info",
			);
			return { ok: true, sandboxId };
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
				"Progress updates in the footer. Tip: /ch-worktree --no-index creates the worktree without indexing.",
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
				return { ok: false };
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
			return { ok: false };
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
		return { ok: true, sandboxId };
	} catch (err) {
		notify(`/ch-worktree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return { ok: false };
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
type PromptResult<T> = { kind: "picked"; value: T } | { kind: "cancelled" } | { kind: "blocked" };
type WizardDeps = { create?: typeof createIndexedWorktree; suppressCancelNotify?: boolean };

function notifyCancelled(ctx: WizardCtx, deps: Pick<WizardDeps, "suppressCancelNotify">): void {
	if (!deps.suppressCancelNotify) ctx.ui.notify("Cancelled.", "info");
}

/** Sandbox branch-slot for a PR (identity + worktree folder + meta.branch). */
function prSlot(number: number): string {
	return `pull/${number}`;
}

/** Wizard ctx slice the prompt/flow helpers need (+ pi for the MCP connect). */
type WizardCtx = { cwd: string; hasUI: boolean; ui: WizardUI; pi: ExtensionAPI };

export async function runWizard(ctx: WizardCtx, state: PluginState, positional?: string, deps: WizardDeps = {}): Promise<WizardOutcome> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	if (positional) {
		if (parsePrUrl(positional)) return runPrWizard(ctx, state, positional, deps);
		const requestedPath = path.resolve(ctx.cwd, positional);
		const probe = fs.existsSync(requestedPath) ? requestedPath : path.dirname(requestedPath);
		const repoRoot = (await gitRootOrNull(ctx.cwd)) ?? (await findRepoRoot(probe));
		if (!repoRoot) {
			notify(`${positional} does not resolve to a git repo. Run it from inside the repo, pass the repo's own directory, or run /ch-worktree with no arguments to pick a repo from the library.`, "error");
			return { kind: "failed" };
		}
		return runBranchWizard(ctx, state, path.resolve(repoRoot), deps);
	}
	const choice = await pickRepoInteractive(ctx, deps);
	if (choice.kind !== "picked") return { kind: choice.kind === "cancelled" ? "cancelled" : "failed" };
	return choice.value.kind === "pr" ? runPrWizard(ctx, state, choice.value.url, deps) : runBranchWizard(ctx, state, choice.value.root, deps);
}

/** Branch-sandbox wizard: repo known → branch name → library root → create. */
export async function runBranchWizard(ctx: WizardCtx, state: PluginState, repoRoot: string, deps: WizardDeps = {}): Promise<WizardOutcome> {
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
		notifyCancelled(ctx, deps);
		return { kind: "cancelled" };
	}
	const branchName = branchRaw.trim();
	let createBranch: string | undefined;
	let branch: string | undefined;
	let remoteRef: string | undefined;
	let commitIsh: string | undefined;
	if (branchName) {
		const choice = await resolveBranchChoice(repoRoot, branchName, notify);
		if (!choice) return { kind: "failed" }; // notified (unknown remote branch / bad name)
		branch = choice.branch;
		createBranch = choice.createBranch;
		remoteRef = choice.remoteRef;
	}
	if (remoteRef) {
		// Remote-branch checkout = detached at the remote tip (see one-go path).
		const sha = await revParse(repoRoot, remoteRef);
		if (!sha) {
			notify(`Cannot resolve ${remoteRef} to a commit.`, "error");
			return { kind: "failed" };
		}
		commitIsh = sha;
	}

	// Library root prompt (with conflict re-prompts).
	const pick = await promptLibraryRoot(ctx, settings, repoRoot, branch ?? createBranch ?? remoteRef, deps);
	if (pick.kind !== "picked") return { kind: pick.kind === "cancelled" ? "cancelled" : "failed" };

	const created = await (deps.create ?? createIndexedWorktree)(ctx, state, {
		repoRoot,
		sandboxDir: pick.value.sandboxDir,
		wtPath: pick.value.wtPath,
		settings,
		createBranch,
		branch,
		commitIsh,
		// Remote-branch checkouts: baseline anchored at the remote ref itself;
		// the sandbox carries the remote name as its identity.
		...(remoteRef ? { baseRef: remoteRef, branchLabel: remoteRef } : {}),
		flags: {},
	});
	return created.ok && created.sandboxId ? { kind: "created", sandboxId: created.sandboxId } : { kind: "failed" };
}

export const OTHER_REPO = "select local repository";
const PICK_PR = "a pull request — paste its GitHub URL";
/** Title of the bare-/ch-worktree repo-source picker (exported for smoke). */
export const REPO_PICKER_TITLE = "Select a repository";

/** Repo picker for bare /ch-worktree: current repo + library repos, a PR (URL
 * prompt), or a typed path. */
async function pickRepoInteractive(ctx: WizardCtx, deps: Pick<WizardDeps, "suppressCancelNotify">): Promise<PromptResult<RepoPick>> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const settings = loadSettings(ctx.cwd).settings;
	// One row per source repo, keyed by its canonical root. The same root can be
	// cached as a baseline AND cut into an indexed sandbox; both rows select the
	// identical source (only the root is returned downstream), so duplicates are
	// collapsed. When a root has both, the "(indexed)" marker wins — the sandbox
	// is the fresher of the two caches; "current" always wins.
	const labelFor = (root: string, marker: "baseline" | "indexed") =>
		`${path.basename(root)} (${marker}) — ${root}`;
	const candidates = new Map<string, string>(); // canonical root → display label
	const addRepo = (rawRoot: string, marker: "baseline" | "indexed"): void => {
		const root = path.resolve(rawRoot);
		const existing = candidates.get(root);
		if (existing === undefined || (marker === "indexed" && existing === labelFor(root, "baseline"))) {
			candidates.set(root, labelFor(root, marker));
		}
	};
	const fromCwd = await gitRootOrNull(ctx.cwd);
	if (fromCwd) candidates.set(path.resolve(fromCwd), `current: ${fromCwd}`);
	for (const b of listBaselines(settings)) {
		if (typeof b.meta?.repoRoot === "string") addRepo(b.meta.repoRoot, "baseline");
	}
	for (const s of listSandboxes(settings)) {
		if (typeof s.meta.repoRoot === "string") addRepo(s.meta.repoRoot, "indexed");
	}
	const options = [...candidates.values(), PICK_PR, OTHER_REPO];
	// Plugin-owned panel (band cursor like the manager); ui.select in RPC/print.
	const choice = await promptPick(ctx.ui, { title: REPO_PICKER_TITLE, options });
	if (choice === undefined) {
		notifyCancelled(ctx, deps);
		return { kind: "cancelled" };
	}
	if (choice === PICK_PR) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const raw = await promptText(ctx.ui, {
				title: "PR URL",
				hint: "Paste the full URL from the browser: https://github.com/<owner>/<repo>/pull/<n>",
			});
			if (raw === undefined) {
				notifyCancelled(ctx, deps);
				return { kind: "cancelled" };
			}
			const url = raw.trim();
			if (parsePrUrl(url)) return { kind: "picked", value: { kind: "pr", url } };
			notify(`Not a PR URL: ${url}. Expected https://github.com/<owner>/<repo>/pull/<n>`, "error");
		}
		notify("No valid PR URL — cancelling.", "error");
		return { kind: "blocked" };
	}
	if (choice !== OTHER_REPO) {
		for (const [root, label] of candidates) {
			if (label === choice) return { kind: "picked", value: { kind: "repo", root } };
		}
	}

	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await promptPath(ctx.ui, { title: "Repo path (a git repository) — TAB completes:", cwd: ctx.cwd, paramLabel: "repo directory" });
		if (raw === undefined) {
			notifyCancelled(ctx, deps);
			return { kind: "cancelled" };
		}
		const p = path.resolve(ctx.cwd, expandHome(raw.trim()));
		// A pasted PR URL works here too (it carries the repo identity).
		if (parsePrUrl(p)) return { kind: "picked", value: { kind: "pr", url: p } };
		const probe = fs.existsSync(p) ? p : path.dirname(p);
		const root = await findRepoRoot(probe);
		if (root) return { kind: "picked", value: { kind: "repo", root: path.resolve(root) } };
		notify(`Not a git repo: ${raw}. Try the repo's own directory.`, "error");
	}
	notify("No valid repo selected — cancelling.", "error");
	return { kind: "blocked" };
}

/**
 * Library root prompt for the wizards: prefilled with the configured root,
 * TAB-completed, and re-prompted (≤3) when the location would overlap another
 * chunkhound worktree/index.
 */
async function promptLibraryRoot(
	ctx: WizardCtx,
	settings: ChhoundSettings,
	repoRoot: string,
	slot: string | undefined,
	deps: Pick<WizardDeps, "suppressCancelNotify">,
): Promise<PromptResult<{ dest: string; sandboxDir: string; wtPath: string }>> {
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
		notifyCancelled(ctx, deps);
		return { kind: "cancelled" };
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
			notifyCancelled(ctx, deps);
			return { kind: "cancelled" };
		}
		dest = path.resolve(ctx.cwd, expandHome(destRaw.trim() || defaultRoot));
		({ sandboxDir, wtPath, conflict } = compute(dest));
	}
	if (conflict) {
		notify(`Blocked: ${wtPath} would overlap the chunkhound worktree ${conflict}. /ch-worktree ls lists worktrees.`, "error");
		return { kind: "blocked" };
	}
	return { kind: "picked", value: { dest, sandboxDir, wtPath } };
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
export async function runPrWizard(ctx: WizardCtx, state: PluginState, url: string, deps: Pick<WizardDeps, "suppressCancelNotify"> = {}): Promise<WizardOutcome> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const pr = parsePrUrl(url);
	if (!pr) {
		notify(`Not a PR URL: ${url} — paste the full URL from the browser (https://github.com/<owner>/<repo>/pull/<n>).`, "error");
		return { kind: "failed" };
	}
	const cwdRoot = await gitRootOrNull(ctx.cwd);
	const discovery = loadSettings(cwdRoot ?? ctx.cwd).settings;
	const host = await resolvePrSandboxHost(ctx.cwd, discovery, pr, notify);
	if (!host) return { kind: "failed" };
	const slot = prSlot(pr.number);
	const pick = await promptLibraryRoot(ctx, host.settings, host.repoRoot, slot, deps);
	if (pick.kind !== "picked") return { kind: pick.kind === "cancelled" ? "cancelled" : "failed" };
	const created = await createIndexedWorktree(ctx, state, {
		repoRoot: host.repoRoot,
		sandboxDir: pick.value.sandboxDir,
		wtPath: pick.value.wtPath,
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
	return created.ok && created.sandboxId ? { kind: "created", sandboxId: created.sandboxId } : { kind: "failed" };
}

/** One-go PR path (/ch-worktree <PR URL> [--dest …]): fully non-interactive. */
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
				"Pick a different destination (/ch-worktree ls lists indexed worktrees).",
			"error",
		);
		return undefined;
	}
	const sandboxConflict = findConflictingIndexed(sandboxDir, listSandboxes(settings).map((e) => e.dir));
	if (sandboxConflict) {
		notify(
			`Refusing: the storage dir ${sandboxDir} would overlap worktree ${sandboxConflict}. ` +
				"Pick a different destination (/ch-worktree ls lists worktrees).",
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

// ── Manager: /ch-worktree ls ─────────────────────────────────────────────────

/** How long a NON-STREAMING caller (headless `ls`, the RPC menu) waits for the
 * late gh PR states before rendering without them — never the full gh timeout
 * grid (⌈pullRows/4⌉ × 12 s). The TUI streams rows and lands PR updates live,
 * so it does not need a budget. */
const GH_STATE_WAIT_MS = 2_000;

/** Read-only adapter for the TUI manager. Collection failures deliberately render an empty list. */
export async function collectManagerItems(
	ctx: {
		cwd: string;
		sessionManager?: { getBranch(): readonly import("@earendil-works/pi-coding-agent").SessionEntry[] };
	},
	onProgress?: (progress: ManagerLoadProgress) => void,
	opts: { settingsRoot?: string; ghWaitMs?: number } = {},
): Promise<ManagerItem[]> {
	try {
		const settingsRoot = opts.settingsRoot ?? (await gitRootOrNull(ctx.cwd)) ?? ctx.cwd;
		const settings = loadSettings(settingsRoot).settings;
		const entries = listSandboxes(settings);
		// Meta-less baseline dirs are garbage (failed/abandoned primes), not rows.
		// A racing removal here must not cost us the whole sandbox listing.
		let baselines: ReturnType<typeof listBaselines> = [];
		try {
			baselines = listBaselines(settings).filter((baseline) => baseline.meta !== undefined);
		} catch { /* baseline listing is optional */ }
		// Newest-first like the sandboxes, and stable across remounts.
		baselines.sort((a, b) => (b.meta?.updatedAt ?? "").localeCompare(a.meta?.updatedAt ?? ""));
		const total = entries.length + baselines.length;
		let records: Map<string, ConnectionRecord> = new Map();
		try {
			if (ctx.sessionManager) records = rehydrateConnections(ctx.sessionManager.getBranch());
		} catch { /* session log is optional */ }
		// Paint pass: every sandbox row from metadata alone (branch, paths, db
		// size, liveness) before the first probe runs. The rows are then replaced
		// in place at their index as the probe pool settles (out of order), so
		// indices — and therefore selection/filtering — stay stable on every frame.
		const ordered: ManagerItem[] = entries.map((entry) => sandboxMetaItem(entry, {
			live: Boolean(getMcpConnection(path.basename(entry.dir))?.prefix),
		}));
		let done = 0;
		// Each event carries a snapshot: a consumer that keeps an event must never
		// observe later probe results appearing in it retroactively.
		const report = (): void => { onProgress?.({ done, total, items: [...ordered] }); };
		report();
		const result = await collectWorktreeList({
			entries,
			settings,
			records,
			ghWaitMs: opts.ghWaitMs,
			onItem: (index, info) => {
				ordered[index] = managerItemFrom(info);
				done++;
				report();
			},
			// A slow gh lookup must not hold back the row's size/git cells: the row
			// is already painted, and the PR state settles the same slot later.
			onUpdate: (index, info) => {
				ordered[index] = managerItemFrom(info);
				report();
			},
		});
		// Baselines stream after the sandboxes. A baseline db is a single file, so
		// this is one stat per baseline — no checkout walk (there is no checkout).
		const baselineItems: ManagerItem[] = [];
		for (const baseline of baselines) {
			const item = await baselineItemFrom(baseline.dir, baseline.meta);
			baselineItems.push(item);
			ordered.push(item);
			done++;
			report();
		}
		return ordered.length === total ? ordered : [...result.infos.map(managerItemFrom), ...baselineItems];
	} catch {
		return [];
	}
}

/**
 * Cheap change detector for the session's manager item cache: the identity
 * fields of every row (`managerItemCacheKey` — built from the same builders
 * the rows use, so claim/identity membership cannot drift) plus the resolved
 * library root. Its settings scope MUST match the collector's (`gitRoot ??
 * cwd`; project settings are exact-root only) or a reopen from a repo subdir
 * would serve a stale library (review V2-08). Probe results (sizes, git, PR)
 * are deliberately excluded — they refresh via `r` or such a change (D10).
 */
function managerFingerprint(settingsRoot: string): string {
	try {
		const { settings } = loadSettings(settingsRoot);
		const parts = [`root:${sandboxRoot(settings)}`];
		for (const entry of listSandboxes(settings)) {
			const id = path.basename(entry.dir);
			parts.push(managerItemCacheKey(sandboxMetaItem(entry, { live: Boolean(getMcpConnection(id)?.prefix) })));
		}
		for (const baseline of listBaselines(settings).filter((value) => value.meta !== undefined).sort((a, b) => a.dir.localeCompare(b.dir))) {
			parts.push(managerItemCacheKey(baselineMetaItem(baseline.dir, baseline.meta)));
		}
		return parts.join("\n");
	} catch {
		// An unreadable library cannot be compared — a constant stamp avoids a
		// full recollect on every open while the error persists.
		return "unreadable";
	}
}

/** Adapter from one collected list row to the renderer-free manager item. */
function managerItemFrom(info: WtListInfo): ManagerSandboxItem {
	const pr = info.pr ? { number: info.pr.number, state: info.pr.state } : undefined;
	return {
		...sandboxMetaItem(info.entry, { live: info.liveMcpPrefix !== undefined, pr }),
		sizeBytes: info.checkoutBytes,
	};
}

/** Adapter from one cached baseline to the renderer-free manager item. */
async function baselineItemFrom(dir: string, meta: BaselineMeta | undefined): Promise<ManagerBaselineItem> {
	// Identity comes from the shared builder (same fields the cache key uses);
	// only the db size is measured here.
	return { ...baselineMetaItem(dir, meta), dbBytes: await dirSizeAsync(baselineDbPathIn(dir)) };
}

/**
 * /ch-worktree ls — list the worktree library. Pure render (headless AND
 * interactive — the notify dialog shows the same text; /ch-status precedent)
 * assembled from the collectors in manage.ts: async checkout sizing, git
 * probes, gh PR-state lookups (all degrading, never throwing).
 */
async function runWorktreeList(
	ctx: {
		cwd: string;
		ui: { notify(msg: string, type?: "info" | "warning" | "error"): void };
		sessionManager?: { getBranch(): readonly import("@earendil-works/pi-coding-agent").SessionEntry[] };
	},
	rest: string[],
	flags: Record<string, string | true>,
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const repoRoot = await gitRootOrNull(ctx.cwd);
	const loaded = loadSettings(repoRoot ?? ctx.cwd);
	if (loaded.issue) notify(loaded.issue, "warning");
	const settings = loaded.settings;

	const parsed = parseListInvocation(rest, flags);
	if (!parsed.ok) {
		notify(parsed.error, "error");
		return;
	}
	const { search, sort } = parsed.options;

	const entries = listSandboxes(settings);
	if (entries.length === 0) {
		notify(
			buildWorktreeListLines({
				libraryRoot: sandboxRoot(settings),
				groups: [],
				total: 0,
				ghFailed: 0,
				ghAttempted: 0,
			}).join("\n"),
			"info",
		);
		return;
	}
	// Session-log records (branch-scoped) drive the "recorded for reconnect"
	// marker; a missing session manager degrades to no records (live MCP
	// connections are always visible — they come from the manager singleton).
	let records: Map<string, ConnectionRecord> = new Map();
	try {
		if (ctx.sessionManager) records = rehydrateConnections(ctx.sessionManager.getBranch());
	} catch {
		// no session log available — liveness columns degrade gracefully
	}

	const result = await collectWorktreeList({ entries, settings, records, ghWaitMs: GH_STATE_WAIT_MS });
	const groups = groupListInfos(result.infos, { search: search.length > 0 ? search : undefined, sort });
	notify(
		buildWorktreeListLines({
			libraryRoot: sandboxRoot(settings),
			groups: groups.groups,
			total: result.infos.length,
			search: search.length > 0 ? search : undefined,
			ghFailed: result.ghFailed,
			ghAttempted: result.ghAttempted,
			ghPending: result.ghPending,
		}).join("\n"),
		"info",
	);
}

// ── Manager: /ch-worktree rm ─────────────────────────────────────────────────

/**
 * /ch-worktree rm — remove one worktree sandbox (storage, worktree
 * registration, optional -b-created branch), with the guards from the
 * planning: live MCP connections are disconnected first (daemon self-exits)
 * and session records tombstoned; the extension-source sandbox needs an
 * explicit --force on the one-go path; pre-existing branches are never
 * deleted (branchDeleteIntent); pull/N and remote-ref slots never are.
 *
 * Interactive (no target, UI present): pick from the sandbox list
 * (the plugin's band-highlighted picker; native select without ctx.ui.custom),
 * then a confirm dialog with the full impact preview
 * (removePreviewLines) — including what is NOT touched. Headless without a
 * target: usage + hint. One-go (explicit target): no confirm (assumed
 * default the operator accepted) — the outcome summary reports each step.
 */
async function runWorktreeRemove(
	pi: ExtensionAPI,
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: {
			notify(msg: string, type?: "info" | "warning" | "error"): void;
			select?(title: string, options: string[]): Promise<string | undefined>;
			confirm?(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
			custom?: PathPromptUI["custom"];
		};
		sessionManager?: { getBranch(): readonly import("@earendil-works/pi-coding-agent").SessionEntry[] };
	},
	rest: string[],
	flags: Record<string, string | true>,
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const repoRoot = await gitRootOrNull(ctx.cwd);
	const loaded = loadSettings(repoRoot ?? ctx.cwd);
	if (loaded.issue) notify(loaded.issue, "warning");
	const settings = loaded.settings;

	const parsed = parseRemoveInvocation(rest, flags);
	if (!parsed.ok) {
		notify(parsed.error, "error");
		return;
	}
	const { target, force } = parsed.options;
	if (target === undefined) {
		// Interactive: pick a sandbox (numbered selectable list) then confirm
		// with the impact preview. Headless: show what would be removable.
		// `ctx.hasUI` is the capability gate: print/json hosts expose no-op
		// select/confirm/custom stubs that resolve undefined/false without ever
		// prompting, which used to swallow this branch as a silent "Cancelled."
		// and make the usage/hint below unreachable (review V2-04).
		const canPick = typeof ctx.ui.select === "function" || typeof ctx.ui.custom === "function";
		if (ctx.hasUI && canPick && typeof ctx.ui.confirm === "function") {
			const entries = listSandboxes(settings);
			if (entries.length === 0) {
				notify("No worktrees to remove — /ch-worktree creates them.", "info");
				return;
			}
			const { infos } = await collectWorktreeList({ entries, settings, records: sessionRecords(ctx) });
			const options = infos.map(
				(info) =>
					`${lifeMarker(info)} ${info.entry.meta.repoRoot ? path.basename(info.entry.meta.repoRoot) + "/" : ""}${sandboxBranchLabel(info.entry.meta)}` +
					(info.gone ? " (gone)" : info.git?.dirty ? " (dirty)" : "") +
					` — ${path.basename(info.entry.dir)}`,
			);
			const choice = await promptPick(ctx.ui, { title: "Remove which worktree sandbox?", options });
			if (choice === undefined) {
				notify("Cancelled.", "info");
				return;
			}
			const info = infos[options.indexOf(choice)];
			if (!info) {
				notify("Selection did not match a sandbox — cancelling.", "error");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				`Remove sandbox ${path.basename(info.entry.dir)}?`,
				removePreviewLines(info, { branchDelete: branchDeleteIntent(info.entry.meta) }).join("\n"),
			);
			if (!confirmed) {
				notify("Cancelled — nothing was removed.", "info");
				return;
			}
			await performRemoval(pi, ctx, settings, info, { force: true });
			return;
		}
		notify(
			[
				"rm needs a target when no interactive picker is available: /ch-worktree rm <worktree path|storage id>.",
				"/ch-worktree ls lists every sandbox with its storage id.",
			].join("\n"),
			"error",
		);
		return;
	}

	// One-go: resolve the target (worktree path | storage id | basename).
	const matches = resolveSandboxMatches(target, settings, ctx.cwd);
	if (matches.length === 0) {
		notify(
			[
				`No worktree or storage id matches '${target}'.`,
				"/ch-worktree ls lists every sandbox with its storage id; remove by id: /ch-worktree rm <id>.",
			].join("\n"),
			"error",
		);
		return;
	}
	if (matches.length > 1) {
		notify(
			`'${target}' matches ${matches.length} sandboxes:\n` +
				matches.map((m) => `  ${path.basename(m.dir)} → ${m.meta.worktree}`).join("\n") +
				"\nUse the full storage id or worktree path.",
			"error",
		);
		return;
	}
	const entry = matches[0]!;
	// The extension-source guard: removing the sandbox the loaded extension
	// runs from breaks the plugin until the symlink is repointed — the
	// interactive confirm carries the warning, the one-go path refuses
	// without --force.
	const { infos } = await collectWorktreeList({ entries: [entry], settings, records: sessionRecords(ctx) });
	const info = infos[0]!;
	if (info.runsThisExtension && !force) {
		notify(
			[
				`${path.basename(entry.dir)} runs THIS extension (the loaded code lives in its checkout).`,
				"Removing it breaks the plugin until ~/.pi/agent/extensions/pi-chhound is repointed to another checkout.",
				"Re-run with --force to remove it anyway: /ch-worktree rm " + target + " --force",
			].join("\n"),
			"error",
		);
		return;
	}
	await performRemoval(pi, ctx, settings, info, { force });
}

/** Session-log records for this session branch (empty when unavailable). */
function sessionRecords(
	ctx: { sessionManager?: { getBranch(): readonly import("@earendil-works/pi-coding-agent").SessionEntry[] } },
): Map<string, ConnectionRecord> {
	try {
		if (ctx.sessionManager) return rehydrateConnections(ctx.sessionManager.getBranch());
	} catch {
		// no session log — liveness degrades gracefully
	}
	return new Map();
}

/**
 * Shared removal tail: impact preview already confirmed (or one-go accepted
 * by default) — run removeWorktreeEntry with the real MCP seams and report
 * the outcome per step.
 */
async function performRemoval(
	pi: ExtensionAPI,
	ctx: { ui: { notify(msg: string, type?: "info" | "warning" | "error"): void } },
	settings: ChhoundSettings,
	info: Awaited<ReturnType<typeof collectWorktreeList>>["infos"][number],
	opts: { force: boolean },
): Promise<void> {
	const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);
	const id = path.basename(info.entry.dir);
	notify(`Removing ${id}…`, "info");
	const outcome = await removeWorktreeEntry({
		row: info,
		settings,
		mcp: {
			disconnect: async (sandboxId) => {
				await disconnectMcp(sandboxId);
			},
			tombstone: (sandboxId) => recordConnection(pi, { sandboxId, state: "disconnected" }),
		},
		force: opts.force,
	});
	// The engine refuses locked worktrees and the extension-source sandbox
	// (without force) BEFORE any side effect — report that as a refusal, never
	// as a partial removal.
	if (outcome.refused !== undefined) {
		notify(
			[
				`Removal refused (${outcome.refused}) — nothing was changed.`,
				...outcome.warnings.map((w) => `  ⚠ ${w}`),
			].join("\n"),
			"error",
		);
		return;
	}
	const lines = [
		`✓ Removed ${outcome.id}${info.entry.meta.repoRoot ? " (" + path.basename(info.entry.meta.repoRoot) + "/" + sandboxBranchLabel(info.entry.meta) + ")" : ""}`,
		`  storage: ${outcome.stateDirRemoved ? "state dir removed" : "state dir already gone"} · ${outcome.sandboxDirRemoved ? "sandbox dir removed" : "sandbox dir already gone"}`,
		outcome.worktreeRemoved
			? `  worktree: ${outcome.worktree} unregistered`
			: outcome.gone
				? `  worktree: ${outcome.worktree} was already gone`
				: `  worktree: ${outcome.worktree} NOT unregistered${outcome.pruned ? " (admin entry pruned)" : ""}`,
	];
	if (outcome.mcpDisconnected) lines.push("  mcp: disconnected (the chunkhound daemon exits on its own)");
	if (outcome.tombstoned) lines.push("  mcp: session record tombstoned (no auto-restore)");
	if (outcome.branchDeleted) lines.push(`  branch: deleted '${outcome.branchDeleted}' (git branch -d)`);
	if (outcome.branchKept) lines.push(`  branch: kept — ${outcome.branchKept}`);
	if (outcome.hadUncommitted && !outcome.gone) lines.push("  note: the checkout had uncommitted changes — they are gone");
	for (const w of outcome.warnings) lines.push(`  ⚠ ${w}`);
	if (outcome.branchKept === undefined && outcome.branchDeleted === undefined && branchDeleteIntent(info.entry.meta)) {
		lines.push(`  branch: not applicable (pre-existing/remote branch — never deleted)`);
	}
	lines.push("  baselines and the host repo's other worktrees are untouched.");
	notify(lines.join("\n"), outcome.warnings.length > 0 ? "warning" : "info");
}
