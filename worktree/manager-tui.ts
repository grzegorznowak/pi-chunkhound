import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { buildManagerRows, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

export function createWorktreeManagerTuiPresenter(
	ctx: { ui: Pick<ExtensionCommandContext["ui"], "custom"> },
	getRows: (session: ManagerSession) => readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>,
): { next(session: ManagerSession): Promise<PanelAction | undefined> } {
	return {
		next(session) {
			return ctx.ui.custom<PanelAction>((tui, theme, _keybindings, done) => {
				let tab = session.tab;
				let row = Math.max(0, session.row);
				let rows: ReturnType<typeof buildManagerRows> | undefined;
				let failed = false;
				let finished = false;
				const finish = (action: PanelAction) => {
					if (finished) return;
					finished = true;
					session.tab = tab;
					session.row = row;
					done(action);
				};
				const paint = (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text);
				void Promise.resolve(getRows(session)).then(
					(items) => {
						if (finished) return;
						rows = buildManagerRows(session, items);
						row = Math.max(0, Math.min(row, rows.length - 1));
						tui.requestRender();
					},
					() => {
						if (finished) return;
						failed = true;
						tui.requestRender();
					},
				);
				return {
					invalidate(): void {},
					render(_width: number): string[] {
						const tabName = (name: ManagerSession["tab"]) => tab === name ? (theme.bold ? theme.bold(paint("accent", `[${name}]`)) : `[${name}]`) : name;
						if (!rows) return [
							`${tabName("worktrees")}  ${tabName("projects")}`,
							"",
							failed ? paint("error", "Unable to load worktrees.") : paint("dim", "Loading worktrees…"),
							"",
							paint("dim", "Tab switch views · Esc close"),
						];
						return [
							`${tabName("worktrees")}  ${tabName("projects")}`,
							"",
							...rows.map((item, index) => `${index === row ? paint("accent", "→ ") : "  "}${item.label}${item.kind === "sandbox" && item.badges.length ? `  ${paint("dim", item.badges.join(" "))}` : ""}`),
							"",
							paint("dim", "Tab switch views · ↑/↓ navigate · Enter select · Esc close"),
						];
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.tab) || data === "\x1b[Z") {
							tab = tab === "worktrees" ? "projects" : "worktrees";
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.up)) {
							row = Math.max(0, row - 1); tui.requestRender(); return;
						}
						if (matchesKey(data, Key.down)) {
							row = Math.min((rows?.length ?? 1) - 1, row + 1); tui.requestRender(); return;
						}
						if (data === "q" || data === "\x1b") { finish({ kind: "close" }); return; }
						if ((data === "\n" || data === "\r") && rows?.[row]?.kind === "create") finish({ kind: "create" });
					},
				};
			});
		},
	};
}
