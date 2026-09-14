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

export function createManagerSession(initial: Partial<ManagerSession> = {}): ManagerSession {
	return { tab: "worktrees", row: 0, filter: "", preselect: undefined, ...initial };
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
		rows.push({
			kind: "sandbox",
			sandboxId: item.sandboxId,
			label: `${item.projectLabel} · ${item.branch}${item.pr ? ` · #${item.pr.number}` : ""}`,
			badges,
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
	const facts = [
		`repo ${item.projectKey}`,
		item.indexed ? "indexed" : "not indexed",
		...(item.live ? ["live MCP"] : []),
		...(item.gone ? ["checkout gone"] : []),
		...(item.pr ? [`PR #${item.pr.number} ${item.pr.state}`] : []),
		...(item.sizeBytes !== undefined ? [`checkout ${fmtSize(item.sizeBytes)}`] : []),
		...(item.createdAt ? [`created ${item.createdAt.slice(0, 10)}`] : []),
	];
	return [`${item.sandboxId} · ${item.projectLabel} · ${item.branch}`, item.path, facts.join(" · ")];
}

export async function runManagerSession(
	_ctx: unknown,
	presenter: ManagerPresenter,
	deps: { session?: ManagerSession; runCreate?: (session: ManagerSession, positional?: string) => Promise<WizardOutcome> } = {},
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
		}
	}
}
