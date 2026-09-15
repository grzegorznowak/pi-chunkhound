import * as fs from "node:fs";
import path from "node:path";
import { fmtSize, readClaimedRoot, sandboxDbDir } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import type { BaselineMeta } from "../chhound/types.js";

export interface ManagerItemBase {
	/** Stable identity of the source repo (sandbox repo root / baseline repoRoot). */
	projectKey: string;
	projectLabel: string;
	/** Checkout path for sandboxes; source repo root for baselines. */
	path: string;
	searchText: string;
	/** Checkout bytes — absent on baselines (they carry no checkout copy). */
	sizeBytes?: number;
	/** Index-db bytes. */
	dbBytes?: number;
}

export interface ManagerSandboxItem extends ManagerItemBase {
	kind: "sandbox";
	sandboxId: string;
	branch: string;
	indexed: boolean;
	gone: boolean;
	live: boolean;
	pr?: { number: number; state: string };
	createdAt?: string;
}

/** A cached baseline index: db-only (the priming worktree is removed after indexing). */
export interface ManagerBaselineItem extends ManagerItemBase {
	kind: "baseline";
	baselineDir: string;
	ref: string;
	baseCommit?: string;
	chhoundVersion?: string;
	updatedAt?: string;
}

export type ManagerItem = ManagerSandboxItem | ManagerBaselineItem;

export interface ManagerRow {
	kind: "create" | "sandbox" | "project" | "baseline";
	/** Present on sandbox rows; the create row has none. */
	sandboxId?: string;
	projectKey?: string;
	/** Present on baseline rows. */
	baselineDir?: string;
	label: string;
	badges: string[];
	/** Sandbox/baseline rows: cells for the list's size columns (details reuse the same values). */
	sizeCells?: ManagerSizeCells;
}

export interface ManagerSizeCells {
	db: string;
	checkout?: string;
	total?: string;
}

export interface ManagerSession {
	tab: "worktrees" | "projects" | "baselines";
	row: number;
	filter: string;
	/** Project drill-down scope: the worktrees list is narrowed to this repo until Esc. */
	project?: { key: string; label: string };
}

export type PanelAction = { kind: "close" } | { kind: "create"; positional?: string } | { kind: "back" };
export type WizardOutcome = { kind: "created"; sandboxId: string } | { kind: "cancelled" } | { kind: "failed" };

/**
 * Incremental load state: the row set in library order. The first event
 * already carries every metadata row (identity, db size, liveness) so the
 * panel can paint immediately; rows are replaced in place as the probes
 * settle, and `done` counts settled rows (never reordered, never shrinking).
 * `items` is a per-event snapshot, never the live collector array.
 */
export interface ManagerLoadProgress {
	done: number;
	total: number;
	items: readonly ManagerItem[];
}
export interface ManagerPresenter {
	next(session: ManagerSession): Promise<PanelAction | undefined>;
}

/**
 * Session-scoped item cache: one successful collect serves every remount of
 * the manager panel (wizard cancel/failure returns to the same list without
 * recomputing). A cache hit returns synchronously so the renderer paints rows
 * on its first frame; a miss starts the shared in-flight load, so a rapid
 * close/reopen never launches a second collect. `invalidate()` drops the
 * cache — create success calls it so the next open collects the new sandbox.
 *
 * `load` also takes an optional `fingerprint`: a cheap digest of the inputs
 * the loader reads (library identity/liveness, not probe results). When it
 * differs from the digest of the cached/in-flight result, the cache is
 * dropped and a fresh collect starts — so a reopen after a create/remove (or
 * a liveness change) never serves a stale list, while a reopen with nothing
 * changed never pays for the probes. A load without a fingerprint opts out.
 */
export interface ManagerItemStore {
	load(
		onProgress?: (progress: ManagerLoadProgress) => void,
		fingerprint?: string,
	): readonly ManagerItem[] | Promise<readonly ManagerItem[]>;
	invalidate(): void;
}

export function createManagerItemStore(
	loader: (onProgress?: (progress: ManagerLoadProgress) => void) => Promise<readonly ManagerItem[]>,
): ManagerItemStore {
	let cached: readonly ManagerItem[] | undefined;
	let cachedFingerprint: string | undefined;
	let inFlight: { promise: Promise<readonly ManagerItem[]>; generation: number; fingerprint?: string } | undefined;
	let generation = 0;
	let lastProgress: ManagerLoadProgress | undefined;
	const listeners = new Set<(progress: ManagerLoadProgress) => void>();
	const release = (listener?: (progress: ManagerLoadProgress) => void): void => {
		if (listener) listeners.delete(listener);
	};
	const publish = (progress: ManagerLoadProgress): void => {
		lastProgress = progress;
		for (const listener of listeners) listener(progress);
	};
	/** Digest of the collect that the current cache/in-flight state describes. */
	const liveFingerprint = (): string | undefined => {
		if (cached !== undefined) return cachedFingerprint;
		if (inFlight && inFlight.generation === generation) return inFlight.fingerprint;
		return undefined;
	};
	return {
		load(onProgress, fingerprint) {
			// Inputs changed under the cached/in-flight collect: expiring it here
			// is equivalent to invalidate() — the generation guard discards the old
			// load's result and progress.
			const live = liveFingerprint();
			if (fingerprint !== undefined && live !== undefined && live !== fingerprint) {
				generation++;
				cached = undefined;
				cachedFingerprint = undefined;
				lastProgress = undefined;
			}
			if (cached) return cached;
			if (onProgress) {
				listeners.add(onProgress);
				if (lastProgress) onProgress(lastProgress);
			}
			// Only a load started after the last invalidate is reusable; an expired
			// one is left running but its result is never cached (see below).
			if (inFlight && inFlight.generation === generation) {
				// A mount joining the shared load must release its own subscriber:
				// the creator only cleans up the callback it was handed.
				if (onProgress) {
					const releaseJoined = (): void => release(onProgress);
					void inFlight.promise.then(releaseJoined, releaseJoined);
				}
				return inFlight.promise;
			}
			const startedAt = generation;
			const startedFingerprint = fingerprint;
			const pending = loader((progress) => {
				// Progress from an expired load is stale too: it may describe a
				// library that predates the change that invalidated it.
				if (startedAt === generation) publish(progress);
			}).then(
				(items) => {
					release(onProgress);
					if (inFlight?.promise === pending) inFlight = undefined;
					if (generation === startedAt) {
						cached = items;
						cachedFingerprint = startedFingerprint;
						lastProgress = { done: items.length, total: items.length, items };
					}
					return items;
				},
				(error: unknown) => {
					release(onProgress);
					if (inFlight?.promise === pending) inFlight = undefined;
					if (generation === startedAt) lastProgress = undefined;
					throw error;
				},
			);
			inFlight = { promise: pending, generation: startedAt, fingerprint: startedFingerprint };
			return pending;
		},
		invalidate() {
			generation++;
			cached = undefined;
			cachedFingerprint = undefined;
			lastProgress = undefined;
		},
	};
}

/**
 * Cheap manager row from a sandbox entry alone: identity, branch, paths, the
 * (already measured) index-db size and liveness — no checkout walk, no git or
 * gh probe. The manager paints these rows immediately, then replaces each one
 * in place with the fully probed item (`sizeBytes`/`pr` arrive later). Both
 * phases share this builder so the meta row can never drift from the final
 * row's identity fields.
 */
export function sandboxMetaItem(
	entry: SandboxEntry,
	opts: { live?: boolean; pr?: { number: number; state: string } } = {},
): ManagerSandboxItem {
	const meta = entry.meta;
	const projectKey = meta.repoRoot ?? entry.dir;
	const sandboxId = path.basename(entry.dir);
	return {
		kind: "sandbox",
		sandboxId,
		projectKey,
		projectLabel: path.basename(projectKey),
		branch: meta.branch,
		path: meta.worktree,
		indexed: Boolean(entry.claimedRoot ?? readClaimedRoot(sandboxDbDir(entry.dir))),
		gone: !fs.existsSync(meta.worktree),
		live: Boolean(opts.live),
		...(opts.pr ? { pr: opts.pr } : {}),
		searchText: [projectKey, path.basename(projectKey), meta.branch, sandboxId, meta.worktree, opts.pr ? `#${opts.pr.number}` : ""].join(" "),
		dbBytes: entry.dbSizeBytes,
		createdAt: meta.createdAt,
	};
}

export function createManagerSession(initial: Partial<ManagerSession> = {}): ManagerSession {
	return { tab: "worktrees", row: 0, filter: "", ...initial };
}

/**
 * Baseline row identity from its metadata ALONE (the db size arrives later) —
 * the baseline twin of `sandboxMetaItem`, shared by the fingerprint and the
 * full collector so the cached-key fields can never drift from the row fields.
 */
export function baselineMetaItem(dir: string, meta: BaselineMeta | undefined): ManagerBaselineItem {
	const repoRoot = meta?.repoRoot && meta.repoRoot.length > 0 ? meta.repoRoot : dir;
	const ref = meta?.baseRef ?? path.basename(dir);
	return {
		kind: "baseline",
		baselineDir: dir,
		projectKey: repoRoot,
		projectLabel: path.basename(repoRoot),
		ref,
		path: repoRoot,
		...(meta?.baseCommit ? { baseCommit: meta.baseCommit } : {}),
		...(meta?.chhoundVersion ? { chhoundVersion: meta.chhoundVersion } : {}),
		...(meta?.updatedAt ? { updatedAt: meta.updatedAt } : {}),
		searchText: [repoRoot, path.basename(repoRoot), ref, dir].join(" "),
	};
}

/**
 * Cache-key projection of one manager item: the fields whose change must drop
 * the session cache — row identity/grouping (`projectKey`/`projectLabel`/
 * `branch`/`path`), liveness, the index-claim badge, and the search/details
 * text. Probe results (checkout size, git state, PR state) are deliberately
 * absent: those refresh via `r` or on a library change, not on reopen (D10).
 *
 * Membership derives from the SAME builders the rows use
 * (`sandboxMetaItem`/`baselineMetaItem`) plus these explicit fields, so a new
 * identity field enters the cache key by construction instead of through a
 * hand-kept parallel list (review V3-04); the companion unit test composes an
 * item and asserts every listed field moves the key.
 */
export function managerItemCacheKey(item: ManagerItem): string {
	const base = [item.kind, item.projectKey, item.projectLabel, item.path, item.searchText];
	if (item.kind === "sandbox") {
		return [
			...base,
			item.sandboxId,
			item.branch,
			item.createdAt ?? "",
			item.indexed ? "indexed" : "unclaimed",
			item.gone ? "gone" : "present",
			item.live ? "live" : "idle",
		].join("\u0001");
	}
	return [...base, item.baselineDir, item.ref, item.updatedAt ?? "", item.baseCommit ?? "", item.chhoundVersion ?? ""].join("\u0001");
}

/**
 * List size cells: `{ db, checkout, total }` for sandboxes, `{ db }` for
 * baselines (no checkout copy exists). Undefined only when neither side was
 * measured (fixtures/partial data), so the row stays blank; a measured but
 * missing db file is a real 0 B. The TUI renders these under its DB/CHECKOUT/
 * TOTAL header with right-aligned numeric columns.
 */
export function formatSizeCells(dbBytes?: number, checkoutBytes?: number): ManagerSizeCells | undefined {
	if (dbBytes === undefined && checkoutBytes === undefined) return undefined;
	const db = dbBytes ?? 0;
	if (checkoutBytes === undefined) return { db: fmtSize(db) };
	return { db: fmtSize(db), checkout: fmtSize(checkoutBytes), total: fmtSize(db + checkoutBytes) };
}

/**
 * Shared size text for details: `db … · checkout … · total …` for sandboxes,
 * `db …` for baselines. Derived from the same cells the list columns show, so
 * list and details cannot drift.
 */
export function formatSizeBreakdown(dbBytes?: number, checkoutBytes?: number): string | undefined {
	const cells = formatSizeCells(dbBytes, checkoutBytes);
	if (!cells) return undefined;
	const parts = [`db ${cells.db}`];
	if (cells.checkout !== undefined) parts.push(`checkout ${cells.checkout}`);
	if (cells.total !== undefined) parts.push(`total ${cells.total}`);
	return parts.join(" · ");
}

/**
 * Project scope for the worktrees view. Keyed on projectKey, never on the
 * label: every searchText carries the shared library root, so a label filter
 * matches unrelated projects (pi-chhound vs chunkhound, repo vs repo-tools).
 * Non-sandbox items pass through untouched.
 */
export function scopedManagerItems(items: readonly ManagerItem[], projectKey?: string): readonly ManagerItem[] {
	if (!projectKey) return items;
	return items.filter((item) => item.kind !== "sandbox" || item.projectKey === projectKey);
}

/** One list row for a sandbox item (shared by the worktrees tab and the scoped project view). */
function sandboxRow(item: ManagerSandboxItem): ManagerRow {
	const badges = [
		...(item.indexed ? ["indexed"] : []),
		...(item.gone ? ["gone"] : []),
		...(item.live ? ["🔌"] : []),
		...(item.pr ? ["pr"] : []),
	];
	const sizeCells = formatSizeCells(item.dbBytes, item.sizeBytes);
	return {
		kind: "sandbox",
		sandboxId: item.sandboxId,
		label: `${item.projectLabel} · ${item.branch}${item.pr ? ` · #${item.pr.number}` : ""}`,
		badges,
		...(sizeCells ? { sizeCells } : {}),
	};
}

export function buildManagerRows(session: ManagerSession, items: readonly ManagerItem[]): ManagerRow[] {
	const filter = session.filter.toLowerCase();
	const matching = scopedManagerItems(items, session.project?.key).filter((item) => !filter || item.searchText.toLowerCase().includes(filter));
	if (session.tab === "projects") {
		// Scoped project view: the projects tab stays active and lists the
		// project's worktrees instead of the groups.
		if (session.project) {
			const rows: ManagerRow[] = [];
			for (const item of matching) {
				if (item.kind === "sandbox") rows.push(sandboxRow(item));
			}
			return rows;
		}
		const projects = new Map<string, { label: string; count: number }>();
		for (const item of matching) {
			if (item.kind !== "sandbox") continue;
			const project = projects.get(item.projectKey);
			if (project) project.count++;
			else projects.set(item.projectKey, { label: item.projectLabel, count: 1 });
		}
		return [...projects].map(([projectKey, project]) => ({
			kind: "project",
			projectKey,
			label: project.label,
			badges: [`${project.count} ${project.count === 1 ? "worktree" : "worktrees"}`],
		}));
	}
	if (session.tab === "baselines") {
		const rows: ManagerRow[] = [];
		for (const item of matching) {
			if (item.kind !== "baseline") continue;
			const sizeCells = formatSizeCells(item.dbBytes);
			rows.push({
				kind: "baseline",
				baselineDir: item.baselineDir,
				projectKey: item.projectKey,
				label: `${item.projectLabel} · ${item.ref}`,
				badges: [],
				...(sizeCells ? { sizeCells } : {}),
			});
		}
		return rows;
	}
	const rows: ManagerRow[] = [{ kind: "create", label: "+ new worktree…", badges: [] }];
	for (const item of matching) {
		if (item.kind !== "sandbox") continue;
		rows.push(sandboxRow(item));
	}
	return rows;
}

export function describeManagerItem(item: ManagerItem): string[] {
	const sizes = formatSizeBreakdown(item.dbBytes, item.sizeBytes);
	if (item.kind === "baseline") {
		return [
			`${item.projectLabel} · ${item.ref}`,
			item.path,
			[
				`repo ${item.projectKey}`,
				"baseline index (no checkout copy)",
				...(sizes ? [sizes] : []),
				...(item.baseCommit ? [`commit ${item.baseCommit.slice(0, 12)}`] : []),
				...(item.chhoundVersion ? [item.chhoundVersion] : []),
				...(item.updatedAt ? [`updated ${item.updatedAt.slice(0, 10)}`] : []),
			].join(" · "),
		];
	}
	const facts = [
		`repo ${item.projectKey}`,
		item.indexed ? "indexed" : "not indexed",
		...(item.live ? ["live MCP"] : []),
		...(item.gone ? ["checkout gone"] : []),
		...(item.pr ? [`PR #${item.pr.number} ${item.pr.state}`] : []),
		...(sizes ? [sizes] : []),
		...(item.createdAt ? [`created ${item.createdAt.slice(0, 10)}`] : []),
	];
	return [`${item.sandboxId} · ${item.projectLabel} · ${item.branch}`, item.path, facts.join(" · ")];
}

export async function runManagerSession(
	_ctx: unknown,
	presenter: ManagerPresenter,
	deps: { session?: ManagerSession; runCreate?: (session: ManagerSession, positional?: string) => Promise<WizardOutcome>; onCreated?: () => void } = {},
): Promise<void> {
	const session = deps.session ?? createManagerSession();
	for (;;) {
		const action = await presenter.next(session);
		if (!action || action.kind === "close") return;
		if (action.kind === "back") continue;
		const outcome = deps.runCreate ? await deps.runCreate(session, action.positional) : { kind: "failed" as const };
		if (outcome.kind === "created") {
			// Create success changes the library and ends the session: the
			// caller gets control back (the chat prompt in TUI, its requester
			// in RPC) instead of the panel reopening on the new row. The next
			// open collects it. Cancelled/failed creations fall through to
			// the loop with whatever the session already loaded.
			deps.onCreated?.();
			return;
		}
	}
}
