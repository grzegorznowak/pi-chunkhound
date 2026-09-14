import { buildManagerRows, describeManagerItem, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

export function createWorktreeManagerRpcPresenter(
	ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined> } },
	getRows: (session: ManagerSession) => readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>,
): { next(session: ManagerSession): Promise<PanelAction> } {
	return {
		async next(session) {
			const items = await getRows(session);
			const rows = buildManagerRows(session, items);
			const count = session.tab === "projects" ? rows.length : rows.filter((row) => row.kind === "sandbox").length;
			const noun = session.tab === "projects" ? (count === 1 ? "project" : "projects") : (count === 1 ? "worktree" : "worktrees");
			const title = [
				`Worktree manager — ${session.tab}`,
				`${count} ${noun}${session.filter ? ` matching “${session.filter}”` : ""}`,
				"Select a row, create a worktree, or close. Cancel returns to this view.",
			].join("\n");

			const actions = new Map<string, () => Promise<PanelAction> | PanelAction>();
			const options: string[] = [];
			const viewLabel = `view: ${session.tab === "worktrees" ? "projects" : "worktrees"}`;
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
			for (const row of rows) {
				if (row.kind === "create") continue;
				const label = `${row.label}${row.badges.length ? ` (${row.badges.join(", ")})` : ""}`;
				if (row.kind === "project") {
					addOption(label, () => {
						session.tab = "worktrees"; session.filter = row.label; session.row = 0;
						return { kind: "back" };
					});
					continue;
				}
				addOption(label, async () => {
					const item = items.find((value) => value.sandboxId === row.sandboxId);
					if (!item) return { kind: "back" };
					const detail = await ctx.ui.select(["Worktree details", ...describeManagerItem(item)].join("\n"), ["back", "close"]);
					return detail === "close" ? { kind: "close" } : { kind: "back" };
				});
			}
			addOption(viewLabel, () => {
				session.tab = session.tab === "worktrees" ? "projects" : "worktrees"; session.row = 0;
				return { kind: "back" };
			}, true);
			addOption("close", () => ({ kind: "close" }), true);

			const selected = await ctx.ui.select(title, options);
			return selected === undefined ? { kind: "back" } : await (actions.get(selected)?.() ?? { kind: "back" });
		},
	};
}
