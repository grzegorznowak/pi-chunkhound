import { buildManagerRows, describeManagerItem, type ManagerItem, type ManagerSession, type PanelAction } from "./manager-core.js";

export function createWorktreeManagerRpcPresenter(
	ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined> } },
	getRows: (session: ManagerSession) => readonly ManagerItem[] | Promise<readonly ManagerItem[]>,
): { next(session: ManagerSession): Promise<PanelAction> } {
	return {
		async next(session) {
			const items = await getRows(session);
			const rows = buildManagerRows(session, items);
			const count = session.tab === "worktrees" ? rows.filter((row) => row.kind === "sandbox").length : rows.length;
			const scopedProjects = session.tab === "projects" && session.project !== undefined;
			const noun = scopedProjects ? (count === 1 ? "worktree" : "worktrees") : session.tab === "worktrees" ? (count === 1 ? "worktree" : "worktrees") : session.tab === "projects" ? (count === 1 ? "project" : "projects") : (count === 1 ? "baseline" : "baselines");
			const scope = scopedProjects ? session.project : undefined;
			const title = [
				`Worktree manager — ${session.tab}`,
				`${count} ${noun}${session.filter ? ` matching “${session.filter}”` : ""}${scope ? ` in “${scope.label}”` : ""}`,
				"Select a row, create a worktree, or close. Cancel returns to this view.",
			].join("\n");

			const actions = new Map<string, () => Promise<PanelAction> | PanelAction>();
			const options: string[] = [];
			const nextView: ManagerSession["tab"] = session.tab === "worktrees" ? "projects" : session.tab === "projects" ? "baselines" : "worktrees";
			const viewLabel = `view: ${nextView}`;
			const reserved = new Set(["+ new worktree…", "close", viewLabel]);
			const addOption = (baseLabel: string, action: () => Promise<PanelAction> | PanelAction, exact = false) => {
				let label = baseLabel;
				if (!exact) {
					let suffix = 2;
					while (actions.has(label) || reserved.has(label)) label = `${baseLabel} [${suffix++}]`;
				}
				actions.set(label, action);
				options.push(label);
			};

			addOption("+ new worktree…", () => ({ kind: "create" }), true);
			if (session.project) addOption("back to all projects", () => {
				session.project = undefined; session.filter = ""; session.row = 0;
				return { kind: "back" };
			});
			for (const row of rows) {
				if (row.kind === "create") continue;
				const label = `${row.label}${row.badges.length ? ` (${row.badges.join(", ")})` : ""}`;
				if (row.kind === "project") {
					const projectKey = row.projectKey;
					addOption(label, () => {
						session.filter = ""; session.row = 0;
						session.project = projectKey ? { key: projectKey, label: row.label } : undefined;
						return { kind: "back" };
					});
					continue;
				}
				addOption(label, async () => {
					const item = row.kind === "sandbox"
						? items.find((value) => value.kind === "sandbox" && value.sandboxId === row.sandboxId)
						: items.find((value) => value.kind === "baseline" && value.baselineDir === row.baselineDir);
					if (!item) return { kind: "back" };
					const title = row.kind === "sandbox" ? "Worktree details" : "Baseline details";
					const detail = await ctx.ui.select([title, ...describeManagerItem(item)].join("\n"), ["back", "close"]);
					return detail === "close" ? { kind: "close" } : { kind: "back" };
				});
			}
			addOption(viewLabel, () => {
				session.tab = nextView; session.row = 0; session.project = undefined;
				return { kind: "back" };
			}, true);
			addOption("close", () => ({ kind: "close" }), true);

			const selected = await ctx.ui.select(title, options);
			return selected === undefined ? { kind: "back" } : await (actions.get(selected)?.() ?? { kind: "back" });
		},
	};
}
