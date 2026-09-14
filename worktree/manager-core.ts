import { fmtSize } from "../chhound/sandbox.js";

export interface ManagerSandboxItem {
	sandboxId: string;
	projectKey: string;
	projectLabel: string;
	branch: string;
	path: string;
	indexed: boolean;
	gone: boolean;
	live: boolean;
	pr?: { number: number; state: string };
	searchText: string;
	sizeBytes?: number;
	createdAt?: string;
}

export interface ManagerRow {
	kind: "create" | "sandbox" | "project";
	/** Present on sandbox rows; the create row has none. */
	sandboxId?: string;
	projectKey?: string;
	label: string;
	badges: string[];
	/** Sandbox rows only: the same "checkout <size>" text the details show. */
	sizeLabel?: string;
}

export interface ManagerSession {
	tab: "worktrees" | "projects";
	row: number;
	filter: string;
	preselect?: string;
}

export type PanelAction = { kind: "close" } | { kind: "create"; positional?: string } | { kind: "back" };
export type WizardOutcome = { kind: "created"; sandboxId: string } | { kind: "cancelled" } | { kind: "failed" };

/** Incremental load state: completed items in library order (prefix-stable, never reordered). */
export interface ManagerLoadProgress {
	done: number;
	total: number;
	items: readonly ManagerSandboxItem[];
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
 * cache — create success calls it so the new sandbox is collected for the
 * preselect.
 */
export interface ManagerItemStore {
	load(onProgress?: (progress: ManagerLoadProgress) => void): readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>;
	invalidate(): void;
}

export function createManagerItemStore(
	loader: (onProgress?: (progress: ManagerLoadProgress) => void) => Promise<readonly ManagerSandboxItem[]>,
): ManagerItemStore {
	let cached: readonly ManagerSandboxItem[] | undefined;
	let inFlight: { promise: Promise<readonly ManagerSandboxItem[]>; generation: number } | undefined;
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
	return {
		load(onProgress) {
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
			inFlight = { promise: pending, generation: startedAt };
			return pending;
		},
		invalidate() {
			generation++;
			cached = undefined;
			lastProgress = undefined;
		},
	};
}

export function createManagerSession(initial: Partial<ManagerSession> = {}): ManagerSession {
	return { tab: "worktrees", row: 0, filter: "", preselect: undefined, ...initial };
}

/** The list row and the details share this exact "checkout <size>" text. */
export function formatCheckoutSize(sizeBytes?: number): string | undefined {
	return sizeBytes !== undefined ? `checkout ${fmtSize(sizeBytes)}` : undefined;
}

export function buildManagerRows(session: ManagerSession, items: readonly ManagerSandboxItem[]): ManagerRow[] {
	const filter = session.filter.toLowerCase();
	const matching = items.filter((item) => !filter || item.searchText.toLowerCase().includes(filter));
	if (session.tab === "projects") {
		const projects = new Map<string, { label: string; count: number }>();
		for (const item of matching) {
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
	const rows: ManagerRow[] = [{ kind: "create", label: "+ new worktree…", badges: [] }];
	for (const item of matching) {
		const badges = [
			...(item.indexed ? ["indexed"] : []),
			...(item.gone ? ["gone"] : []),
			...(item.live ? ["live"] : []),
			...(item.pr ? ["pr"] : []),
		];
		const sizeLabel = formatCheckoutSize(item.sizeBytes);
		rows.push({
			kind: "sandbox",
			sandboxId: item.sandboxId,
			label: `${item.projectLabel} · ${item.branch}${item.pr ? ` · #${item.pr.number}` : ""}`,
			badges,
			...(sizeLabel ? { sizeLabel } : {}),
		});
	}
	if (session.preselect) {
		const index = rows.findIndex((row) => row.kind === "sandbox" && row.sandboxId === session.preselect);
		if (index >= 0) {
			session.row = index;
			session.preselect = undefined;
		}
	}
	return rows;
}

export function describeManagerItem(item: ManagerSandboxItem): string[] {
	const checkout = formatCheckoutSize(item.sizeBytes);
	const facts = [
		`repo ${item.projectKey}`,
		item.indexed ? "indexed" : "not indexed",
		...(item.live ? ["live MCP"] : []),
		...(item.gone ? ["checkout gone"] : []),
		...(item.pr ? [`PR #${item.pr.number} ${item.pr.state}`] : []),
		...(checkout ? [checkout] : []),
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
			session.preselect = outcome.sandboxId;
			session.tab = "worktrees";
			// Only a created sandbox changes the library; cancelled/failed
			// creations reuse whatever the session already loaded.
			deps.onCreated?.();
		}
	}
}
