import { Key, matchesKey } from "@earendil-works/pi-tui";
import { buildManagerRows, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

type ThemeLike = { fg?: (color: any, text: string) => string; bold?: (text: string) => string };
type TuiLike = { requestRender(): void };

export function createWorktreeManagerTuiPresenter(
	ctx: { ui: { custom: any } },
	getRows: (session: ManagerSession) => readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>,
): { next(session: ManagerSession): Promise<PanelAction> } {
	return {
		async next(session) {
			const rows = buildManagerRows(session, await getRows(session));
			return ctx.ui.custom((tui: TuiLike, theme: ThemeLike, _keybindings: unknown, done: (value: PanelAction) => void) => {
				let tab = session.tab;
				let row = Math.max(0, Math.min(session.row, rows.length - 1));
				let finished = false;
				const finish = (action: PanelAction) => {
					if (finished) return;
					finished = true;
					session.tab = tab;
					session.row = row;
					done(action);
				};
				const paint = (color: string, text: string) => theme.fg ? theme.fg(color, text) : text;
				return {
					render(_width: number): string[] {
						const tabName = (name: ManagerSession["tab"]) => tab === name ? (theme.bold ? theme.bold(paint("accent", `[${name}]`)) : `[${name}]`) : name;
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
							row = Math.min(rows.length - 1, row + 1); tui.requestRender(); return;
						}
						if (data === "q" || data === "\x1b") { finish({ kind: "close" }); return; }
						if (data === "\n" || data === "\r") {
							if (rows[row]?.kind === "create") finish({ kind: "create" });
						}
					},
				};
			});
		},
	};
}
