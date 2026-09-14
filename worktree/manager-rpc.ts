import { buildManagerRows, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

export function createWorktreeManagerRpcPresenter(
	ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined> } },
	getRows: (session: ManagerSession) => readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>,
): { next(session: ManagerSession): Promise<PanelAction> } {
	return {
		async next(session) {
			const rows = buildManagerRows(session, await getRows(session));
			const sandboxCount = rows.filter((row) => row.kind === "sandbox").length;
			const title = [
				`Worktree manager — ${session.tab}`,
				`${sandboxCount} ${sandboxCount === 1 ? "worktree" : "worktrees"}${session.filter ? ` matching “${session.filter}”` : ""}`,
				"Select a row, create a worktree, or close. Cancel returns to this view.",
			].join("\n");

			const actions = new Map<string, PanelAction>();
			const options: string[] = [];
			const addOption = (baseLabel: string, action: PanelAction, exact = false) => {
				let label = baseLabel;
				if (!exact) {
					let suffix = 2;
					while (actions.has(label) || label === "+ new worktree…" || label === "close") label = `${baseLabel} [${suffix++}]`;
				}
				actions.set(label, action);
				options.push(label);
			};

			for (const row of rows) {
				if (row.kind === "create") {
					addOption("+ new worktree…", { kind: "create" }, true);
					continue;
				}
				const label = `${row.label}${row.badges.length ? ` (${row.badges.join(", ")})` : ""}`;
				// Sandbox details/actions are deferred in v1; selecting one redisplays the manager.
				addOption(label, { kind: "back" });
			}
			addOption("close", { kind: "close" }, true);

			const selected = await ctx.ui.select(title, options);
			return selected === undefined ? { kind: "back" } : (actions.get(selected) ?? { kind: "back" });
		},
	};
}
