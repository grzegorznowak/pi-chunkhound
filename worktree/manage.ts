/**
 * /ch-worktree manager surface — LIST of managed sandboxes (grouped by
 * project, searchable/sortable, with space, git-state and liveness columns)
 * and the REMOVAL engine behind `/ch-worktree rm`.
 *
 * Design: worktree/command.ts keeps the creation wizard + one-go flows and
 * dispatches manager VERBS from the parsed argument head (`ls`/`list`,
 * `rm`/`remove`). This module holds:
 *  - the verb + argument-validation predicates (pure, test-imported),
 *  - the collectors (IO: async checkout sizing, per-worktree git probes,
 *    gh PR-state lookups — every probe degrades, never throws),
 *  - the pure grouping / filter / sort stage,
 *  - the pure line renderer (headless-verifiable, like buildStatusLines),
 *  - the removal engine (`removeWorktreeEntry`: MCP disconnect/tombstone →
 *    worktree unregistration → storage → optional non-forced branch delete;
 *    locked worktrees and the extension source are refused up front).
 *
 * Listing never mutates anything and never touches baselines — it is read-
 * only over the sandbox library, the worktree checkouts, and the host git
 * repos (git status/rev-list/log probes).
 */
import * as fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkedOutBranches, remoteOrigin, runGit } from "../chhound/git.js";
import { mirrorRoot, shortHash } from "../chhound/paths.js";
import { ownerRepoFromRemoteUrl } from "../chhound/pr.js";
import { claimedRootMatches, dirSizeAsync, fmtSize, sandboxBranchLabel } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import type { ChhoundSettings } from "../chhound/types.js";
import { getMcpConnection } from "../mcp/manager.js";
import type { ConnectionRecord } from "../mcp/persist.js";

// ── Verb dispatch ────────────────────────────────────────────────────────────

/** List verbs: /ch-worktree ls [<query>] … (alias: list). */
export const LS_VERBS: readonly string[] = ["ls", "list"];
/** Removal verbs (alias: remove) — `/ch-worktree rm [<target>] [--force]`. */
export const RM_VERBS: readonly string[] = ["rm", "remove"];
export type WorktreeVerb = "list" | "remove";

/**
 * The manager verb carried by the FIRST positional, when any. Anything else
 * (undefined, a repo path, a PR URL, a branch) stays a creation invocation —
 * bare /ch-worktree keeps the wizard, positional[0] keeps meaning "repo".
 */
export function worktreeVerb(first: string | undefined): WorktreeVerb | undefined {
	if (first === undefined) return undefined;
	if (LS_VERBS.includes(first)) return "list";
	if (RM_VERBS.includes(first)) return "remove";
	return undefined;
}

// ── List options (parse/validation — pure) ───────────────────────────────────

export const LIST_SORT_KEYS = ["created", "name", "db", "checkout", "total"] as const;
export type ListSortKey = (typeof LIST_SORT_KEYS)[number];
export const DEFAULT_LIST_SORT: ListSortKey = "created";

/** Value flags the parser must know per command — these two belong to `ls`. */
export const LIST_VALUE_FLAGS: readonly string[] = ["search", "sort"];
/** Flags that steer CREATION — invalid on manager verbs (guarded per flow). */
export const CREATION_FLAGS: readonly string[] = [
	"b",
	"config",
	"dest",
	"from",
	"no-index",
	"force-reindex",
	"refresh-baseline",
];

/** First creation-only flag present, or undefined (pure — used as a guard). */
export function creationFlagIn(flags: Record<string, string | true>): string | undefined {
	return CREATION_FLAGS.find((f) => flags[f] !== undefined);
}

/** First list-only flag present, or undefined — guards the creation flows. */
export function listFlagIn(flags: Record<string, string | true>): string | undefined {
	return LIST_VALUE_FLAGS.find((f) => flags[f] !== undefined);
}

export interface ListOptions {
	/** Case-insensitive substring filter over repo/branch/id/path fields. */
	search: string;
	sort: ListSortKey;
}

export type ListInvocationResult = { ok: true; options: ListOptions } | { ok: false; error: string };

/**
 * Validate the arguments AFTER the verb: /ch-worktree ls [<query>] [--search
 * <text>] [--sort <key>]. Creation flags are rejected here (they steer the
 * creation pipeline and silently doing nothing would mislead), as are
 * unknown flags, a bare value flag, an unknown sort key and extra
 * positionals.
 */
export function parseListInvocation(
	positionals: string[],
	flags: Record<string, string | true>,
): ListInvocationResult {
	const creationFlag = creationFlagIn(flags);
	if (creationFlag) {
		return {
			ok: false,
			error: `--${creationFlag} is a creation option — not applicable to ls (creation: /ch-worktree [repo] …).`,
		};
	}
	for (const key of Object.keys(flags)) {
		if (key === "search" || key === "sort") continue;
		return { ok: false, error: `Unknown option --${key} — ls takes [<query>] [--search <text>] [--sort <key>].` };
	}
	if (positionals.length > 1) {
		return {
			ok: false,
			error: `ls takes at most one <query> argument — got: ${positionals.join(" ")} (quoted text with spaces: --search "<text>").`,
		};
	}
	if (flags["sort"] === true) {
		return { ok: false, error: `--sort needs a key: ${LIST_SORT_KEYS.join("|")} (default: created).` };
	}
	if (flags["search"] === true) {
		return { ok: false, error: "--search needs text: /ch-worktree ls --search <text>." };
	}
	const sortRaw = typeof flags["sort"] === "string" ? flags["sort"] : DEFAULT_LIST_SORT;
	const sort = sortRaw as ListSortKey;
	if (!LIST_SORT_KEYS.includes(sort)) {
		return { ok: false, error: `Unknown sort key '${sortRaw}' — keys: ${LIST_SORT_KEYS.join("|")}.` };
	}
	const search = typeof flags["search"] === "string" ? flags["search"].trim() : positionals[0]?.trim() ?? "";
	return { ok: true, options: { search, sort } };
}

// ── Per-worktree git state (IO, degrading) ───────────────────────────────────

export interface WtGitState {
	/** Checked-out branch (undefined = detached HEAD). */
	branch?: string;
	/** Uncommitted changes incl. untracked files (git status --porcelain). */
	dirty: boolean;
	/** Commits in HEAD but not in the comparison ref. */
	ahead: number;
	/** Commits in the comparison ref but not in HEAD. */
	behind: number;
	/** Ref the counts compare against: the branch's upstream when it has one,
	 * else the sandbox's baseRef. Undefined when neither exists/resolves. */
	vsRef?: string;
	/** HEAD commit oid. */
	headOid: string;
	/** HEAD commit date (%cI — committer, strict ISO). */
	lastCommit?: string;
}

/**
 * Probe one worktree checkout: status (dirty), branch vs detached, upstream
 * when the branch has one, and ahead/behind against the comparison ref
 * (upstream else baseRef). Read-only git calls — the listing never writes.
 * Returns undefined when the path is not a git worktree (gone / broken) —
 * the caller distinguishes "gone" via fs and renders accordingly.
 */
export async function probeWorktreeGit(wtPath: string, baseRef?: string): Promise<WtGitState | undefined> {
	const status = await runGit(["status", "--porcelain"], { cwd: wtPath });
	if (status.code !== 0) return undefined;
	const dirty = status.stdout.length > 0;
	const branch = (await runGit(["branch", "--show-current"], { cwd: wtPath })).stdout || undefined;
	const headOid = (await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: wtPath })).stdout;
	if (!headOid) return undefined;
	const log = await runGit(["log", "-1", "--format=%cI", headOid], { cwd: wtPath });
	const lastCommit = log.code === 0 && log.stdout.length > 0 ? log.stdout : undefined;
	// Comparison ref: the branch's upstream when it has one; otherwise the
	// sandbox's recorded baseRef (the ref the index baseline anchors on).
	// Detached checkouts (pull/N, remote refs) have no upstream — baseRef is
	// their only meaningful comparison.
	let upstream: string | undefined;
	if (branch) {
		const u = await runGit(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd: wtPath });
		if (u.code === 0) upstream = u.stdout;
	}
	const state: WtGitState = { dirty, ahead: 0, behind: 0, headOid, lastCommit };
	if (branch) state.branch = branch;
	const compareRef = upstream ?? baseRef;
	if (compareRef) {
		// Symmetric difference: LEFT side = commits in the ref not in HEAD
		// (behind); RIGHT = commits in HEAD not in the ref (ahead).
		const count = await runGit(["rev-list", "--left-right", "--count", `${compareRef}...HEAD`], { cwd: wtPath });
		if (count.code === 0 && /^\d+\s+\d+$/.test(count.stdout)) {
			const [behind, ahead] = count.stdout.split(/\s+/).map(Number);
			state.behind = behind;
			state.ahead = ahead;
			state.vsRef = compareRef;
		}
	}
	return state;
}

// ── gh PR-state lookup (item #3: PR-outcome linkage for pull/N) ─────────────

export interface WtPrState {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	draft: boolean;
}

/** runGh with a kill-on-timeout — a hung gh must never stall a listing. */
export async function runGhTimed(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn> | undefined;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child?.kill("SIGKILL");
			resolve({ code: -1, stdout: "", stderr: `gh timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		try {
			child = spawn("gh", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: String(e) });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: String(e) });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

/**
 * Resolve when `p` settles or after `ms` — whichever comes first. The timer is
 * cleared on settle so a fast result never keeps the process alive.
 */
function waitWithDeadline(p: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(done, ms);
		void p.then(done, done);
	});
}

/**
 * Owner/repo for gh queries from a sandbox's host repoRoot: the mirror cache
 * encodes it in the path (<mirrorRoot>/github.com/<owner>/<repo>); a local
 * checkout contributes its github.com origin URL. Undefined = no gh identity
 * (a local-only repo) — the PR state column then stays empty, silently.
 */
export async function prRepoIdentity(settings: ChhoundSettings, repoRoot: string | undefined): Promise<{ owner: string; repo: string } | undefined> {
	if (typeof repoRoot !== "string" || repoRoot.length === 0) return undefined;
	const mirrorBase = mirrorRoot(settings);
	if (repoRoot.startsWith(mirrorBase + path.sep)) {
		const rel = path.relative(mirrorBase, repoRoot).split(path.sep);
		// <mirrorRoot>/github.com/<owner>/<repo>
		if (rel[0] === "github.com" && rel.length >= 3) {
			return { owner: rel[1]!.toLowerCase(), repo: rel[2]!.toLowerCase() };
		}
		return undefined;
	}
	try {
		const origin = await remoteOrigin(repoRoot);
		if (origin) return ownerRepoFromRemoteUrl(origin);
	} catch {
		// not a repo (anymore) — no identity
	}
	return undefined;
}

/**
 * PR state via gh: `gh pr view <n> --repo <owner>/<repo> --json
 * state,isDraft`. Never throws; undefined = lookup failed (gh missing,
 * unauthenticated, offline, or the PR is gone) — the caller counts failures
 * so the renderer can say why PR states are hidden.
 */
export async function ghPrState(
	settings: ChhoundSettings,
	entry: SandboxEntry,
	timeoutMs = 12_000,
): Promise<WtPrState | undefined> {
	const slot = entry.meta.branch;
	const m = /^pull\/(\d+)$/.exec(slot ?? "");
	if (!m) return undefined;
	const identity = await prRepoIdentity(settings, entry.meta.repoRoot);
	if (!identity) return undefined;
	const r = await runGhTimed(["pr", "view", m[1]!, "-R", `${identity.owner}/${identity.repo}`, "--json", "state,isDraft"], timeoutMs);
	if (r.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(r.stdout) as { state?: unknown; isDraft?: unknown };
		if (parsed.state !== "OPEN" && parsed.state !== "CLOSED" && parsed.state !== "MERGED") return undefined;
		return { number: Number(m[1]), state: parsed.state, draft: parsed.isDraft === true };
	} catch {
		return undefined;
	}
}

// ── Row model + collector ────────────────────────────────────────────────────

export interface WtListInfo {
	entry: SandboxEntry;
	/** Checkout dir bytes (async walk). Undefined = the walk could not read a
	 * subtree (INCOMPLETE → unmeasured — never a partial sum, D7); 0 = nothing
	 * there (gone checkout / missing single file). */
	checkoutBytes?: number;
	/** The checkout dir (meta.worktree) no longer exists. */
	gone: boolean;
	/** Git probe — undefined when the worktree is gone or not a repo. */
	git?: WtGitState;
	/** Tool prefix of a LIVE MCP connection to this sandbox (this session). */
	liveMcpPrefix?: string;
	/** Session record says `connected` but no live connection (auto-restore
	 * on session start reconnects it). */
	recordedConnected: boolean;
	/** The loaded extension code runs from this sandbox's checkout. */
	runsThisExtension: boolean;
	/** PR outcome (gh) — pull/N sandboxes only. */
	pr?: WtPrState;
	/** gh lookup was still running when the collector returned (bounded wait). */
	prPending?: boolean;
}

export interface WtListResult {
	infos: WtListInfo[];
	/** pull/N sandboxes where a gh lookup was attempted but failed. */
	ghFailed: number;
	/** pull/N sandboxes with a gh identity (a lookup was attempted). */
	ghAttempted: number;
	/** pull/N sandboxes whose gh lookup was still running at return. */
	ghPending: number;
}

/** The checkout the loaded extension code runs from (realpath), if any. */
const EXTENSION_CHECKOUT = ((): string | undefined => {
	try {
		// <checkout>/worktree/manage.ts → <checkout>
		return fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
	} catch {
		return undefined;
	}
})();

export function extensionCheckout(): string | undefined {
	return EXTENSION_CHECKOUT;
}

/**
 * Collect the list rows for every sandbox entry. IO happens per entry with
 * bounded parallelism; every probe degrades (row-level gaps, never a
 * throw). `livePrefixFor` and `records` are seams so tests can drive the
 * liveness columns without touching the MCP manager or the session log.
 */
export async function collectWorktreeList(opts: {
	entries: readonly SandboxEntry[];
	settings: ChhoundSettings;
	records: ReadonlyMap<string, ConnectionRecord>;
	livePrefixFor?: (id: string) => string | undefined;
	concurrency?: number;
	/** Called once per entry when its row is displayable (checkout walk + git
	 * probes settled); the row may still receive an `onUpdate` for its PR state. */
	onItem?: (index: number, info: WtListInfo) => void;
	/** Called when a late field (the gh PR state) lands on an already-reported row. */
	onUpdate?: (index: number, info: WtListInfo) => void;
	/** Cap the wait for late gh lookups AFTER every row is displayable: the
	 * headless `ls` must never stall its output on the gh timeout grid
	 * (⌈pullRows/4⌉ × 12 s). Omitted = wait for everything (the manager paints
	 * rows early and lands PR updates live, so a wait costs nothing there). */
	ghWaitMs?: number;
}): Promise<WtListResult> {
	const { entries, settings, records } = opts;
	const livePrefixFor = opts.livePrefixFor ?? ((id: string) => getMcpConnection(id)?.prefix);
	const limit = Math.max(1, opts.concurrency ?? 4);
	const ghState = { failed: 0, attempted: 0 };
	const infos: WtListInfo[] = new Array(entries.length);
	// Rows whose gh task had not settled when the collector returned.
	const pendingPr = new Set<number>();
	// Detached gh lookups, capped by `limit` so the row walk never waits on the
	// network: time-to-output is bounded by the caller's budget, not by N hung
	// lookups (review V2-25).
	const ghTasks = new Set<Promise<void>>();
	let ghActive = 0;
	const ghQueue: (() => void)[] = [];
	const acquireGh = (): Promise<void> => {
		if (ghActive < limit) {
			ghActive++;
			return Promise.resolve();
		}
		return new Promise((resolve) => ghQueue.push(() => { ghActive++; resolve(); }));
	};
	const releaseGh = (): void => {
		ghActive--;
		ghQueue.shift()?.();
	};
	// Set once the collector returns: a late gh result still lands on its row
	// object, but must not fire callbacks into a caller that already rendered.
	let closed = false;
	let next = 0;
	let reported = 0;
	let onAllReported: (() => void) | undefined;
	const allReported = new Promise<void>((resolve) => {
		onAllReported = resolve;
	});
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= entries.length) return;
			const entry = entries[i]!;
			const id = path.basename(entry.dir);
			const wt = entry.meta.worktree;
			const gone = wt.length === 0 || !fs.existsSync(wt);
			// Start the gh lookup before the local probes: the network round-trip
			// overlaps the checkout walk, and the detached task only ever updates
			// its own PR cell (via onUpdate) — it never gates the row walk.
			const prTask = /^pull\/\d+$/.test(entry.meta.branch ?? "")
				? (async (): Promise<WtPrState | undefined> => {
					await acquireGh();
					try {
						if (!(await prRepoIdentity(settings, entry.meta.repoRoot))) return undefined;
						ghState.attempted++;
						const pr = await ghPrState(settings, entry);
						if (!pr) ghState.failed++;
						return pr;
					} finally {
						releaseGh();
					}
				})()
				: undefined;
			let git: WtGitState | undefined;
			let checkoutBytes: number | undefined = 0; // gone → measured as nothing
			if (!gone) {
				checkoutBytes = await dirSizeAsync(wt);
				git = await probeWorktreeGit(wt, entry.meta.baseRef);
			}
			const live = livePrefixFor(id);
			const record = records.get(id);
			const info: WtListInfo = {
				entry,
				checkoutBytes,
				gone,
				git,
				liveMcpPrefix: live,
				recordedConnected: record?.state === "connected" && live === undefined,
				runsThisExtension:
					EXTENSION_CHECKOUT !== undefined && wt.length > 0 && (() => {
						try {
							return fs.realpathSync(wt) === EXTENSION_CHECKOUT;
						} catch {
							return false;
						}
					})(),
			};
			infos[i] = info;
			reported++;
			opts.onItem?.(i, info);
			if (reported === entries.length) onAllReported?.();
			if (prTask) {
				// Detached: the row is already reported; the lookup lands later
				// (bounded by the caller's budget) without holding this worker slot.
				pendingPr.add(i);
				const task = prTask
					.then((pr) => {
						if (pr) {
							info.pr = pr;
							if (!closed) {
								try {
									opts.onUpdate?.(i, info);
								} catch {
									// A presenter callback must never reject the detached task:
									// an unhandled rejection would take the process down.
								}
							}
						}
					}, () => {
						ghState.failed++;
					})
					.finally(() => {
						pendingPr.delete(i);
						ghTasks.delete(task);
					});
				ghTasks.add(task);
			}
		}
	};
	const workers = Promise.all(Array.from({ length: Math.min(limit, entries.length) }, () => worker()));
	if (opts.ghWaitMs === undefined) {
		await workers;
		await Promise.allSettled([...ghTasks]);
	} else {
		// Displayable rows first (that is what the caller renders), then a bounded
		// wait for the detached gh lookups — a hung gh can neither delay the rows
		// nor stretch the emission past the budget, however many rows there are.
		if (entries.length > 0) await allReported;
		await waitWithDeadline(Promise.allSettled([...ghTasks]), opts.ghWaitMs);
	}
	closed = true;
	for (const index of pendingPr) infos[index]!.prPending = true;
	return { infos, ghFailed: ghState.failed, ghAttempted: ghState.attempted, ghPending: pendingPr.size };
}

// ── Group / filter / sort (pure) ─────────────────────────────────────────────

export interface WtGroup {
	/** Project key: meta.repoRoot ("" when absent). */
	key: string;
	/** Display label: repo basename (unique-ified per library on collision). */
	label: string;
	infos: WtListInfo[];
}

/** Free-text haystack of one row — repo, branch identity, id, paths, git branch. */
export function searchTextOf(info: WtListInfo): string {
	const e = info.entry;
	const meta = e.meta;
	return [
		meta.repoRoot ?? "",
		meta.branch ?? "",
		meta.headRef ?? "",
		meta.headOid ?? "",
		meta.worktree,
		e.dir,
		info.git?.branch ?? "",
	].join(" ").toLowerCase();
}

/** Ascending comparator on a row's identity label (branch label + id tie). */
function byIdentityAsc(a: WtListInfo, b: WtListInfo): number {
	const la = `${sandboxBranchLabel(a.entry.meta)} ${path.basename(a.entry.dir)}`;
	const lb = `${sandboxBranchLabel(b.entry.meta)} ${path.basename(b.entry.dir)}`;
	return la < lb ? -1 : la > lb ? 1 : 0;
}

/** Column value for the numeric sort keys — db/checkout/total, else undefined. */
function sortColumn(info: WtListInfo, key: ListSortKey): number | undefined {
	if (key === "db") return info.entry.dbSizeBytes;
	if (key === "checkout") return info.checkoutBytes;
	// Unmeasured checkout (incomplete walk) sorts as 0 — largest-first puts the
	// unknown rows last instead of inventing a size for the comparison.
	if (key === "total") return info.entry.dbSizeBytes + (info.checkoutBytes ?? 0);
	return undefined;
}

/**
 * Filter (search), then group by project (meta.repoRoot) and order. Group
 * order and within-group order both follow the sort key:
 *  - created: newest first (entry createdAt desc; groups by their newest row)
 *  - name:    A→Z on the row identity (groups by label)
 *  - db / checkout / total: largest first (groups by their column sum)
 * Ties resolve by storage id (ascending) / group label, then the project key
 * (ascending) so duplicate basenames never flap — deterministic for any input.
 */
export function groupListInfos(
	infos: readonly WtListInfo[],
	opts: { search?: string; sort?: ListSortKey },
): { groups: WtGroup[] } {
	const { sort = DEFAULT_LIST_SORT } = opts;
	const query = opts.search?.trim().toLowerCase() ?? "";
	const rows = query.length === 0 ? [...infos] : infos.filter((i) => searchTextOf(i).includes(query));

	// Per-row ordering within a group.
	const rowOrder = (a: WtListInfo, b: WtListInfo): number => {
		const idA = path.basename(a.entry.dir);
		const idB = path.basename(b.entry.dir);
		if (sort === "name") {
			const c = byIdentityAsc(a, b);
			if (c !== 0) return c;
			return idA < idB ? -1 : idA > idB ? 1 : 0;
		}
		if (sort === "created") {
			const c = b.entry.meta.createdAt.localeCompare(a.entry.meta.createdAt); // desc
			if (c !== 0) return c;
			return idA < idB ? -1 : idA > idB ? 1 : 0;
		}
		const col = (sortColumn(b, sort) ?? 0) - (sortColumn(a, sort) ?? 0); // largest first (unmeasured = 0, last)
		if (col !== 0) return col;
		return idA < idB ? -1 : idA > idB ? 1 : 0;
	};

	// Group rows by project key, preserving the label derivation source.
	const byKey = new Map<string, WtListInfo[]>();
	for (const r of rows) {
		const key = r.entry.meta.repoRoot ?? "";
		const list = byKey.get(key);
		if (list) list.push(r);
		else byKey.set(key, [r]);
	}
	const groups: WtGroup[] = [];
	for (const [key, list] of byKey) {
		list.sort(rowOrder);
		const label = key.length > 0 ? path.basename(key) : "(unknown project)";
		groups.push({ key, label, infos: list });
	}

	// Group order per sort key (see doc comment), ties by label asc.
	const groupDate = (g: WtGroup): string => g.infos.reduce((m, i) => (i.entry.meta.createdAt > m ? i.entry.meta.createdAt : m), "");
	const groupSum = (g: WtGroup, key: ListSortKey): number => g.infos.reduce((s, i) => s + (sortColumn(i, key) ?? 0), 0);
	groups.sort((a, b) => {
		let c = 0;
		if (sort === "created") c = groupDate(b).localeCompare(groupDate(a));
		else if (sort === "name") c = a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
		else c = groupSum(b, sort) - groupSum(a, sort);
		if (c !== 0) return c;
		const byLabel = a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
		// Duplicate basenames (fork + upstream) are only separated by the label
		// uniquifier — tie-break on the raw project key so equal labels stay stable.
		return byLabel !== 0 ? byLabel : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});

	// Unique-ify labels: two project roots may share a basename (fork +
	// upstream) — the shorter hash token (same derivation sandbox names use)
	// keeps the group rows distinguishable.
	const seen = new Map<string, number>();
	for (const g of groups) seen.set(g.label, (seen.get(g.label) ?? 0) + 1);
	for (const g of groups) {
		if ((seen.get(g.label) ?? 0) > 1) g.label = `${g.label}·${shortHash(g.key).slice(0, 6)}`;
	}
	return { groups };
}

// ── Rendering (pure) ─────────────────────────────────────────────────────────

/** Badges for one row, in display order (no separators — the caller joins). */
export function entryBadges(info: WtListInfo): string[] {
	const { entry, git, gone } = info;
	const meta = entry.meta;
	const out: string[] = [];
	if (gone) {
		out.push("✗ gone");
		return out;
	}
	if (info.pr) {
		const state = info.pr.state === "OPEN" ? (info.pr.draft ? "DRAFT" : "OPEN") : info.pr.state;
		out.push(`PR #${info.pr.number} ${state}`);
	}
	if (git?.dirty) out.push("dirty");
	if (git?.branch && git.branch !== meta.branch) {
		// The checkout moved to a different branch than the sandbox identity
		// records (its index is stale relative to the checkout).
		out.push(`on ${git.branch}`);
	} else if (git && !git.branch && !/^pull\/\d+$/.test(meta.branch ?? "") && !(meta.branch ?? "").includes("/")) {
		// Detached where the identity says a plain branch — pull/N and
		// <remote>/<branch> sandboxes are detached BY DESIGN (no badge).
		out.push(`detached @ ${git.headOid.slice(0, 8)}`);
	}
	if (git?.vsRef && (git.ahead > 0 || git.behind > 0)) {
		out.push(`+${git.ahead}/-${git.behind} vs ${git.vsRef}`);
	}
	if (info.runsThisExtension) out.push("runs this extension");
	if (entry.claimedRoot === undefined) out.push("unclaimed index");
	else if (!claimedRootMatches(entry.claimedRoot, entry.dir)) out.push("index root mismatch");
	if (git?.lastCommit) out.push(`last commit ${git.lastCommit.slice(0, 10)}`);
	return out;
}

/** Life marker: ● = live MCP connection now, ↻ = recorded connected (will
 * restore at the next session start), · = idle. */
export function lifeMarker(info: WtListInfo): string {
	if (info.liveMcpPrefix !== undefined) return "●";
	if (info.recordedConnected) return "↻";
	return "·";
}

/** Worktree path shown on the sizes line — relative to the library root
 * when it lives under it (id + checkout folder), absolute otherwise. */
export function displayWorktreePath(libraryRoot: string, wtPath: string): string {
	if (wtPath.length === 0) return "";
	const rel = path.relative(libraryRoot, wtPath);
	if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	return wtPath;
}

export interface ListRenderInput {
	libraryRoot: string;
	groups: readonly WtGroup[];
	/** Rows BEFORE the search filter (for "showing N of M"). */
	total: number;
	search?: string;
	/** pull/N sandboxes whose gh lookup failed (state column incomplete). */
	ghFailed: number;
	/** pull/N sandboxes with a gh identity (a lookup was attempted). */
	ghAttempted: number;
	/** pull/N sandboxes whose gh lookup was still running (state not yet known). */
	ghPending?: number;
}

/** fmtSize for a measured count; "—" when the walk could not measure (D7:
 * unmeasured stays unmeasured, never a partial sum). */
function fmtSizeMaybe(bytes: number | undefined): string {
	return bytes === undefined ? "—" : fmtSize(bytes);
}

/**
 * Full /ch-worktree ls rendering (pure — the handler assembles the inputs
 * and notifies the result). Group header carries the project rollups; each
 * row is two lines: identity + state badges, then the space columns (db
 * first) and the worktree path.
 */
export function buildWorktreeListLines(opts: ListRenderInput): string[] {
	const { libraryRoot, groups, total, search, ghFailed, ghAttempted, ghPending } = opts;
	const count = groups.reduce((s, g) => s + g.infos.length, 0);
	const lines = [
		`worktree library — ${count} sandbox${count === 1 ? "" : "es"} in ${groups.length} project${groups.length === 1 ? "" : "s"} · root: ${libraryRoot}`,
	];
	if (search && search.length > 0 && count !== total) {
		lines.push(`(showing ${count} of ${total} matching "${search}")`);
	}
	if (groups.length === 0) {
		lines.push(
			total === 0
				? "  (no worktrees yet — /ch-worktree <repo> [branch] creates the first; a PR URL creates a pull-request sandbox)"
				: `  (no worktree matches "${search}" — /ch-worktree ls lists everything)`,
		);
		return lines;
	}
	for (const g of groups) {
		const db = g.infos.reduce((s, i) => s + i.entry.dbSizeBytes, 0);
		// A rollup with an unmeasured member stays unknown — never a partial sum.
		const checkout = g.infos.some((i) => i.checkoutBytes === undefined)
			? undefined
			: g.infos.reduce((s, i) => s + (i.checkoutBytes ?? 0), 0);
		lines.push(
			`${g.label} (${g.infos.length}) — db ${fmtSize(db)} · checkout ${fmtSizeMaybe(checkout)} · total ${fmtSizeMaybe(checkout === undefined ? undefined : db + checkout)}`,
		);
		for (const info of g.infos) {
			const meta = info.entry.meta;
			const badges = entryBadges(info);
			const identity = sandboxBranchLabel(meta);
			lines.push(`  ${lifeMarker(info)} ${identity}${badges.length > 0 ? " — " + badges.join(" · ") : ""}`);
			const totalBytes = info.checkoutBytes === undefined ? undefined : info.entry.dbSizeBytes + info.checkoutBytes;
			const wt = displayWorktreePath(libraryRoot, meta.worktree);
			lines.push(
				`      db ${fmtSize(info.entry.dbSizeBytes)} · checkout ${fmtSizeMaybe(info.checkoutBytes)} · total ${fmtSizeMaybe(totalBytes)} · created ${meta.createdAt.slice(0, 10)}` +
					(wt.length > 0 ? ` · wt ${wt}` : ""),
			);
		}
	}
	if (ghFailed > 0) {
		lines.push(
			`(gh PR lookup failed for ${ghFailed} of ${ghAttempted} pull sandbox${ghAttempted === 1 ? "" : "es"} — PR states hidden; check: gh auth status)`,
		);
	}
	if ((ghPending ?? 0) > 0) {
		lines.push(
			`(gh PR lookup still running for ${ghPending} pull sandbox${ghPending === 1 ? "" : "es"} — state not shown yet; re-run ls in a moment)`,
		);
	}
	return lines;
}

// ── Removal (rm) ─────────────────────────────────────────────────────────────

export interface RemoveOptions {
	/** Explicit target (worktree path / storage id / basename) — undefined
	 * means "pick interactively" (UI) or an error (headless). */
	target?: string;
	/** Bypass the runs-this-extension guard (one-go path). */
	force: boolean;
}

export type RemoveInvocationResult = { ok: true; options: RemoveOptions } | { ok: false; error: string };

/**
 * Validate the arguments AFTER the verb: /ch-worktree rm [<target>]
 * [--force]. One positional at most; creation and list flags are rejected
 * (they steer other flows — silently ignoring them would mislead).
 */
export function parseRemoveInvocation(
	positionals: string[],
	flags: Record<string, string | true>,
): RemoveInvocationResult {
	const creationFlag = creationFlagIn(flags);
	if (creationFlag) {
		return { ok: false, error: `--${creationFlag} is a creation option — not applicable to rm.` };
	}
	const listFlag = listFlagIn(flags);
	if (listFlag) {
		return { ok: false, error: `--${listFlag} belongs to ls — rm takes [<target>] [--force].` };
	}
	if (positionals.length > 1) {
		return { ok: false, error: `rm takes at most one <target> (a worktree path or storage id) — got: ${positionals.join(" ")}.` };
	}
	for (const key of Object.keys(flags)) {
		if (key === "force") continue;
		return { ok: false, error: `Unknown option --${key} — rm takes [<target>] [--force].` };
	}
	if (flags["force"] !== undefined && flags["force"] !== true) {
		return { ok: false, error: "--force takes no value." };
	}
	return { ok: true, options: { target: positionals[0]?.trim() || undefined, force: flags["force"] === true } };
}

/**
 * Whether removing this sandbox should ALSO try `git branch -d <branch>`.
 * Pure intent rule — the recorded base ref is the anchor: when the sandbox
 * checked out an EXISTING branch (positional branch), the baseline anchored
 * at that branch itself (baseRef === branch), so the branch predates the
 * sandbox and must never be deleted. Branches CREATED for the sandbox (-b,
 * wizard-typed, derived) anchor on the source repo's head branch instead
 * (baseRef !== branch) — those are candidates. pull/N and <remote>/<branch>
 * slots never pass (their identity is not a local branch; runtime ref
 * existence is verified separately).
 */
export function branchDeleteIntent(meta: { branch?: string; baseRef?: string }): boolean {
	const { branch, baseRef } = meta;
	if (!branch || branch.length === 0 || !baseRef) return false;
	if (/^pull\/\d+$/.test(branch)) return false; // PR slots are never local branches
	return branch !== baseRef;
}

/**
 * Test seams for the removal engine: the MCP lifecycle hooks and the storage
 * remover. `removeStorage` defaults to `fs.rmSync(path, { recursive, force })`
 * and exists so the storage-failure ORDER can be pinned deterministically on
 * every platform/node version (a failing sandbox-dir removal must keep the
 * `.state` half so the row stays discoverable) — patching `fs` internals is
 * not portable (Node 24 no longer routes `rmSync` through `process.binding`).
 */
export interface RemoveSeams {
	/** Disconnect a LIVE MCP connection by sandbox id. Never throws. */
	disconnect?: (id: string) => Promise<void>;
	/** Tombstone a `connected` session record (append-only log). Never throws. */
	tombstone?: (sandboxId: string) => Promise<void> | void;
	/** Remove one storage half. Defaults to `fs.rmSync(path, {recursive, force})`. */
	removeStorage?: (path: string) => void;
}

export interface RemoveOutcome {
	/** Storage id (sandbox dir basename). */
	id: string;
	worktree: string;
	/** Pre-removal worktree state. */
	hadUncommitted: boolean;
	gone: boolean;
	wasLive: boolean;
	/** Live connection disconnected (daemon exits on its own). */
	mcpDisconnected: boolean;
	/** `connected` session record tombstoned. */
	tombstoned: boolean;
	/** Storage halves removed (may already be gone). */
	stateDirRemoved: boolean;
	sandboxDirRemoved: boolean;
	/** Refused BEFORE any side effect (locked worktree / extension source
	 * without force). No other field is meaningful when set. */
	refused?: string;
	/** git worktree remove ran and the checkout is unregistered. */
	worktreeRemoved: boolean;
	/** `git worktree prune` ran as a fallback (cleanup note). */
	pruned: boolean;
	/** Branch deletion outcome for -b-created branches (never forced). */
	branchDeleted?: string;
	/** Branch kept — human reason (unmerged, missing, still checked out). */
	branchKept?: string;
	/** Human-readable per-step problems (removal continues past them). */
	warnings: string[];
}

/**
 * Lock state of one registered worktree, from `git worktree list --porcelain`
 * (the only place git exposes locks: a `locked [<reason>]` line follows the
 * `worktree <path>` stanza). An unreadable host repo degrades to unlocked —
 * the `git worktree remove` step then reports the real error.
 */
async function worktreeLockState(hostRoot: string, worktree: string): Promise<{ locked: boolean; reason?: string }> {
	const r = await runGit(["worktree", "list", "--porcelain"], { cwd: hostRoot });
	if (r.code !== 0) return { locked: false };
	const target = path.resolve(worktree);
	let current: string | undefined;
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length);
			continue;
		}
		if (current !== undefined && path.resolve(current) === target && line.startsWith("locked")) {
			const reason = line.slice("locked".length).trim();
			return reason.length > 0 ? { locked: true, reason } : { locked: true };
		}
	}
	return { locked: false };
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Did `git worktree prune -v` actually remove THIS target's admin entry? Git
 * reports each removal as `Removing worktrees/<id>: <reason>` on STDERR (exit
 * code 0 also when there was nothing to prune), so exit code alone cannot tell,
 * and a repo-global sweep may remove some OTHER stale entry: match the target's
 * own id — `basename(worktree)`, which is how git names the admin entry
 * (reviews V2-05, N-03). A `prune` that swept nothing — or only other entries —
 * must never be reported as `pruned` for this target.
 */
function pruneRemovedSomething(r: { code: number; stderr: string }, worktree: string): boolean {
	const base = path.basename(worktree.replace(/[\\/]+$/, ""));
	return r.code === 0 && r.stderr.split("\n").some((line) => line.startsWith(`Removing worktrees/${base}:`));
}

/**
 * Remove one sandbox: live-MCP disconnect + record tombstone FIRST (the
 * chunkhound daemon self-exits when its client detaches; the tombstone stops
 * auto-restore), then `git worktree remove --force` in the host repo
 * (meta.repoRoot — bare mirror hosts work the same way as when they added
 * the worktree), then the storage halves (sandbox dir first, then the .state
 * sibling), then a best-effort `git branch -d` when the branch was created
 * FOR this sandbox (branchDeleteIntent; NEVER forced; never for pull/N or
 * pre-existing branches). Shared baselines are never touched, and neither
 * is anything else in the host repo beyond the sandbox's own registration.
 *
 * REFUSES before any side effect when the worktree is locked (operator
 * decision: detect and refuse, never `-f -f`; the hint names
 * `git worktree unlock`) or when the sandbox runs THIS extension without an
 * explicit `force` — the engine owns that guard, not just the command.
 *
 * Never throws: per-step failures land in `warnings` and the outcome so the
 * caller can report what was and was not done. `mcp` seams keep the flow
 * testable headless (fs tests inject counting fakes).
 */
export async function removeWorktreeEntry(opts: {
	row: WtListInfo;
	settings: ChhoundSettings;
	mcp?: RemoveSeams;
	force?: boolean;
}): Promise<RemoveOutcome> {
	const { row, mcp } = opts;
	const entry = row.entry;
	const meta = entry.meta;
	const removeStorage = mcp?.removeStorage ?? ((p: string): void => fs.rmSync(p, { recursive: true, force: true }));
	const id = path.basename(entry.dir);
	const outcome: RemoveOutcome = {
		id,
		worktree: meta.worktree,
		hadUncommitted: row.git?.dirty === true,
		gone: row.gone,
		wasLive: row.liveMcpPrefix !== undefined,
		mcpDisconnected: false,
		tombstoned: false,
		stateDirRemoved: false,
		sandboxDirRemoved: false,
		worktreeRemoved: false,
		pruned: false,
		warnings: [],
	};

	// 0) Preconditions — REFUSE before ANY side effect:
	//    - a lock is the user's explicit statement (A2: detect + refuse, never
	//      double-force): unlocking is a deliberate `git worktree unlock`.
	//    - the sandbox running THIS extension needs an explicit force (the
	//      engine enforces it so a future removal consumer cannot omit it).
	const hostRoot = typeof meta.repoRoot === "string" && meta.repoRoot.length > 0 ? meta.repoRoot : undefined;
	const hostAlive = hostRoot !== undefined && fs.existsSync(hostRoot);
	if (row.runsThisExtension && opts.force !== true) {
		outcome.refused = "sandbox runs this extension";
		outcome.warnings.push("refused: this sandbox runs the loaded extension — re-run with --force to remove it anyway");
		return outcome;
	}
	if (hostAlive && meta.worktree.length > 0) {
		const lock = await worktreeLockState(hostRoot!, meta.worktree);
		if (lock.locked) {
			outcome.refused = `worktree locked${lock.reason ? `: ${lock.reason}` : ""}`;
			outcome.warnings.push(
				`refused: the worktree is locked — unlock first: git worktree unlock ${meta.worktree}`,
			);
			return outcome;
		}
	}

	// 1) Live MCP connection → disconnect (daemon self-exits) + tombstone the
	//    session record so auto-restore cannot resurrect the sandbox.
	if (row.liveMcpPrefix !== undefined) {
		try {
			await mcp?.disconnect?.(id);
			outcome.mcpDisconnected = true;
		} catch (e) {
			outcome.warnings.push(`MCP disconnect failed: ${(e as Error).message}`);
		}
	}
	if (row.recordedConnected || row.liveMcpPrefix !== undefined) {
		try {
			await mcp?.tombstone?.(id);
			outcome.tombstoned = true;
		} catch (e) {
			outcome.warnings.push(`session-record tombstone failed: ${(e as Error).message}`);
		}
	}

	// 2) git worktree remove --force in the host repo — while the checkout
	//    still exists. On any failure the storage halves are still removed
	//    and a `git worktree prune -v` sweep cleans the admin metadata (the
	//    sweep reports `pruned` ONLY when it removed THIS target's entry).
	if (hostAlive && meta.worktree.length > 0 && fs.existsSync(meta.worktree)) {
		const r = await runGit(["worktree", "remove", "--force", meta.worktree], { cwd: hostRoot! });
		if (r.code === 0) outcome.worktreeRemoved = true;
		else {
			outcome.warnings.push(`git worktree remove failed: ${r.stderr || r.stdout || "unknown error"}`);
			const p = await runGit(["worktree", "prune", "-v"], { cwd: hostRoot! });
			if (pruneRemovedSomething(p, meta.worktree)) outcome.pruned = true;
		}
	} else if (hostAlive && meta.worktree.length > 0) {
		// Checkout already gone — sweep the stale admin registration so the
		// branch (if deletable) is not seen as "still checked out".
		const p = await runGit(["worktree", "prune", "-v"], { cwd: hostRoot! });
		if (pruneRemovedSomething(p, meta.worktree)) outcome.pruned = true;
	}

	// 3) Storage halves: the sandbox dir (checkout + config + engine dir)
	//    FIRST, and the hidden .state sibling (db + meta) ONLY after the
	//    sandbox dir is really gone — deleting the state half first would make
	//    a sandbox whose checkout deletion failed undiscoverable (no meta → no
	//    row, no prune); this order keeps it visible as a `gone` row instead.
	//    Each half is independently try/caught: the "never throws" contract
	//    holds and both outcomes are reported.
	if (fs.existsSync(entry.dir)) {
		try {
			removeStorage(entry.dir);
			outcome.sandboxDirRemoved = true;
		} catch (e) {
			outcome.warnings.push(
				`sandbox dir removal failed: ${errText(e)} — the .state half is kept so the sandbox stays discoverable (/ch-status --prune retries it)`,
			);
		}
	}
	if (!fs.existsSync(entry.dir) && fs.existsSync(entry.stateDir)) {
		try {
			removeStorage(entry.stateDir);
			outcome.stateDirRemoved = true;
		} catch (e) {
			outcome.warnings.push(`state dir removal failed: ${errText(e)}`);
		}
	}

	// 4) Optional branch delete — candidates only (branchDeleteIntent), never
	//    forced, verified against the live repo.
	if (branchDeleteIntent(meta)) {
		if (!hostAlive) {
			outcome.branchKept = "host repo gone — branch left alone";
		} else {
			const branchName = meta.branch!;
			const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: hostRoot });
			if (exists.code !== 0) {
				outcome.branchKept = "no local branch of that name";
			} else {
				const checkedOut = await checkedOutBranches(hostRoot!);
				if (checkedOut.has(branchName)) {
					outcome.branchKept = "still checked out somewhere else";
				} else {
					const d = await runGit(["branch", "-d", branchName], { cwd: hostRoot });
					if (d.code === 0) outcome.branchDeleted = branchName;
					else outcome.branchKept = `git branch -d refused (${d.stderr || d.stdout || "unmerged?"})`;
				}
			}
		}
	}
	return outcome;
}

/** Rows used by the removal dialog. */
export function removePreviewLines(row: WtListInfo, opts: { branchDelete: boolean }): string[] {
	const meta = row.entry.meta;
	const repo = meta.repoRoot ? path.basename(meta.repoRoot) : path.basename(row.entry.dir);
	const lines = [
		`${repo}/${sandboxBranchLabel(meta)}`,
		`worktree: ${meta.worktree}`,
		`storage id: ${path.basename(row.entry.dir)}`,
		`db ${fmtSize(row.entry.dbSizeBytes)} · checkout ${fmtSizeMaybe(row.checkoutBytes)} · total ${fmtSizeMaybe(row.checkoutBytes === undefined ? undefined : row.entry.dbSizeBytes + row.checkoutBytes)}`,
		`base: ${meta.baseRef} @ ${meta.baseCommit.slice(0, 8)} · created ${meta.createdAt.slice(0, 10)}`,
	];
	if (row.liveMcpPrefix !== undefined) {
		lines.push(`live MCP connection (${row.liveMcpPrefix}) WILL BE DISCONNECTED — the chunkhound daemon exits on its own`);
	}
	if (row.recordedConnected) {
		lines.push("recorded for auto-reconnect — the session record will be tombstoned");
	}
	if ((row.git?.dirty === true) && !row.gone) {
		lines.push("⚠ the checkout has uncommitted changes — they will be lost");
	}
	if (row.runsThisExtension) {
		lines.push("⚠ this sandbox runs THIS extension — removing it breaks the plugin until the extension symlink is repointed");
	}
	if (opts.branchDelete && typeof meta.branch === "string") {
		lines.push(`branch: will try 'git branch -d ${meta.branch}' (only when it is merged elsewhere; never forced)`);
	}
	lines.push("NOT touched: shared baselines, other sandboxes, the host repo beyond this sandbox's own worktree registration.");
	return lines;
}
