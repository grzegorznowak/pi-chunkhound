/**
 * /chworktree manager surface — LIST of managed sandboxes (grouped by
 * project, searchable/sortable, with space, git-state and liveness columns).
 * REMOVAL lands in a follow-up slice on the same verb dispatch.
 *
 * Design: worktree/command.ts keeps the creation wizard + one-go flows and
 * dispatches manager VERBS from the parsed argument head (`ls`/`list` —
 * removal verbs are reserved). This module holds:
 *  - the verb + argument-validation predicates (pure, test-imported),
 *  - the collectors (IO: async checkout sizing, per-worktree git probes,
 *    gh PR-state lookups — every probe degrades, never throws),
 *  - the pure grouping / filter / sort stage,
 *  - the pure line renderer (headless-verifiable, like buildStatusLines).
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

/** List verbs: /chworktree ls [<query>] … (alias: list). */
export const LS_VERBS: readonly string[] = ["ls", "list"];
/** Removal verbs (reserved — the remove flow lands in a follow-up slice). */
export const RM_VERBS: readonly string[] = ["rm", "remove"];
export type WorktreeVerb = "list" | "remove";

/**
 * The manager verb carried by the FIRST positional, when any. Anything else
 * (undefined, a repo path, a PR URL, a branch) stays a creation invocation —
 * bare /chworktree keeps the wizard, positional[0] keeps meaning "repo".
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
 * Validate the arguments AFTER the verb: /chworktree ls [<query>] [--search
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
			error: `--${creationFlag} is a creation option — not applicable to ls (creation: /chworktree [repo] …).`,
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
		return { ok: false, error: "--search needs text: /chworktree ls --search <text>." };
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
	/** Checkout dir bytes (async walk; 0 when gone/unreadable). */
	checkoutBytes: number;
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
}

export interface WtListResult {
	infos: WtListInfo[];
	/** pull/N sandboxes where a gh lookup was attempted but failed. */
	ghFailed: number;
	/** pull/N sandboxes with a gh identity (a lookup was attempted). */
	ghAttempted: number;
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
}): Promise<WtListResult> {
	const { entries, settings, records } = opts;
	const livePrefixFor = opts.livePrefixFor ?? ((id: string) => getMcpConnection(id)?.prefix);
	const limit = Math.max(1, opts.concurrency ?? 4);
	const ghState = { failed: 0, attempted: 0 };
	const infos: WtListInfo[] = new Array(entries.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= entries.length) return;
			const entry = entries[i]!;
			const id = path.basename(entry.dir);
			const wt = entry.meta.worktree;
			const gone = wt.length === 0 || !fs.existsSync(wt);
			let git: WtGitState | undefined;
			let checkoutBytes = 0;
			if (!gone) {
				checkoutBytes = await dirSizeAsync(wt);
				git = await probeWorktreeGit(wt, entry.meta.baseRef);
			}
			let pr: WtPrState | undefined;
			if (/^pull\/\d+$/.test(entry.meta.branch ?? "") && (await prRepoIdentity(settings, entry.meta.repoRoot))) {
				ghState.attempted++;
				pr = await ghPrState(settings, entry);
				if (!pr) ghState.failed++;
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
				pr,
			};
			infos[i] = info;
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, () => worker()));
	return { infos, ghFailed: ghState.failed, ghAttempted: ghState.attempted };
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
	if (key === "total") return info.entry.dbSizeBytes + info.checkoutBytes;
	return undefined;
}

/**
 * Filter (search), then group by project (meta.repoRoot) and order. Group
 * order and within-group order both follow the sort key:
 *  - created: newest first (entry createdAt desc; groups by their newest row)
 *  - name:    A→Z on the row identity (groups by label)
 *  - db / checkout / total: largest first (groups by their column sum)
 * Ties resolve by storage id (ascending) / group label — the order is
 * deterministic for any input.
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
		const col = sortColumn(b, sort)! - sortColumn(a, sort)!; // largest first
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
		return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
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
}

/**
 * Full /chworktree ls rendering (pure — the handler assembles the inputs
 * and notifies the result). Group header carries the project rollups; each
 * row is two lines: identity + state badges, then the space columns (db
 * first) and the worktree path.
 */
export function buildWorktreeListLines(opts: ListRenderInput): string[] {
	const { libraryRoot, groups, total, search, ghFailed, ghAttempted } = opts;
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
				? "  (no worktrees yet — /chworktree <repo> [branch] creates the first; a PR URL creates a pull-request sandbox)"
				: `  (no worktree matches "${search}" — /chworktree ls lists everything)`,
		);
		return lines;
	}
	for (const g of groups) {
		const db = g.infos.reduce((s, i) => s + i.entry.dbSizeBytes, 0);
		const checkout = g.infos.reduce((s, i) => s + i.checkoutBytes, 0);
		lines.push(
			`${g.label} (${g.infos.length}) — db ${fmtSize(db)} · checkout ${fmtSize(checkout)} · total ${fmtSize(db + checkout)}`,
		);
		for (const info of g.infos) {
			const meta = info.entry.meta;
			const badges = entryBadges(info);
			const identity = sandboxBranchLabel(meta);
			lines.push(`  ${lifeMarker(info)} ${identity}${badges.length > 0 ? " — " + badges.join(" · ") : ""}`);
			const totalBytes = info.entry.dbSizeBytes + info.checkoutBytes;
			const wt = displayWorktreePath(libraryRoot, meta.worktree);
			lines.push(
				`      db ${fmtSize(info.entry.dbSizeBytes)} · checkout ${fmtSize(info.checkoutBytes)} · total ${fmtSize(totalBytes)} · created ${meta.createdAt.slice(0, 10)}` +
					(wt.length > 0 ? ` · wt ${wt}` : ""),
			);
		}
	}
	if (ghFailed > 0) {
		lines.push(
			`(gh PR lookup failed for ${ghFailed} of ${ghAttempted} pull sandbox${ghAttempted === 1 ? "" : "es"} — PR states hidden; check: gh auth status)`,
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
 * Validate the arguments AFTER the verb: /chworktree rm [<target>]
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

export interface RemoveSeams {
	/** Disconnect a LIVE MCP connection by sandbox id. Never throws. */
	disconnect?: (id: string) => Promise<void>;
	/** Tombstone a `connected` session record (append-only log). Never throws. */
	tombstone?: (sandboxId: string) => Promise<void> | void;
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
 * Remove one sandbox: live-MCP disconnect + record tombstone FIRST (the
 * chunkhound daemon self-exits when its client detaches; the tombstone stops
 * auto-restore), then `git worktree remove --force` in the host repo
 * (meta.repoRoot — bare mirror hosts work the same way as when they added
 * the worktree), then the storage halves (sandbox dir + .state sibling),
 * then a best-effort `git branch -d` when the branch was created FOR this
 * sandbox (branchDeleteIntent; NEVER forced; never for pull/N or
 * pre-existing branches). Shared baselines are never touched, and neither
 * is anything else in the host repo beyond the sandbox's own registration.
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
	//    and a `git worktree prune` sweep cleans the admin metadata.
	const hostRoot = typeof meta.repoRoot === "string" && meta.repoRoot.length > 0 ? meta.repoRoot : undefined;
	const hostAlive = hostRoot !== undefined && fs.existsSync(hostRoot);
	if (hostAlive && meta.worktree.length > 0 && fs.existsSync(meta.worktree)) {
		const r = await runGit(["worktree", "remove", "--force", meta.worktree], { cwd: hostRoot });
		if (r.code === 0) outcome.worktreeRemoved = true;
		else {
			outcome.warnings.push(`git worktree remove failed: ${r.stderr || r.stdout || "unknown error"}`);
			const p = await runGit(["worktree", "prune"], { cwd: hostRoot });
			if (p.code === 0) outcome.pruned = true;
		}
	} else if (hostAlive && meta.worktree.length > 0) {
		// Checkout already gone — sweep the stale admin registration so the
		// branch (if deletable) is not seen as "still checked out".
		const p = await runGit(["worktree", "prune"], { cwd: hostRoot });
		if (p.code === 0) outcome.pruned = true;
	}

	// 3) Storage halves: sandbox dir (checkout + config + engine dir) and the
	//    hidden .state sibling (db + meta) — never the baselines.
	if (fs.existsSync(entry.stateDir)) {
		fs.rmSync(entry.stateDir, { recursive: true, force: true });
		outcome.stateDirRemoved = true;
	}
	if (fs.existsSync(entry.dir)) {
		fs.rmSync(entry.dir, { recursive: true, force: true });
		outcome.sandboxDirRemoved = true;
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
		`db ${fmtSize(row.entry.dbSizeBytes)} · checkout ${fmtSize(row.checkoutBytes)} · total ${fmtSize(row.entry.dbSizeBytes + row.checkoutBytes)}`,
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
