import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { buildManagerRows, describeManagerItem, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

export function createWorktreeManagerTuiPresenter(
	ctx: { ui: Pick<ExtensionCommandContext["ui"], "custom"> },
	getRows: (session: ManagerSession) => readonly ManagerSandboxItem[] | Promise<readonly ManagerSandboxItem[]>,
): { next(session: ManagerSession): Promise<PanelAction | undefined> } {
	return {
		next(session) {
			return ctx.ui.custom<PanelAction>((tui, theme, _keybindings, done) => {
				let tab = session.tab;
				let row = Math.max(0, session.row);
				let items: readonly ManagerSandboxItem[] | undefined;
				let rows: ReturnType<typeof buildManagerRows> | undefined;
				let filterDraft: string | undefined;
				let status: string[] = [];
				let failed = false;
				let finished = false;
				const finish = (action: PanelAction) => {
					if (finished) return;
					finished = true;
					session.tab = tab;
					session.row = row;
					done(action);
				};
				const rebuild = () => {
					if (!items) return;
					session.tab = tab;
					session.row = row;
					rows = buildManagerRows(session, items);
					row = Math.max(0, Math.min(session.row, Math.max(0, rows.length - 1)));
					session.row = row;
				};
				const paint = (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text);
				void Promise.resolve(getRows(session)).then(
					(loaded) => {
						if (finished) return;
						items = loaded;
						rebuild();
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
						const tabName = (name: ManagerSession["tab"]) => tab === name ? theme.bold(paint("accent", `[${name}]`)) : name;
						const footer = paint("dim", "Tab switch views · ↑/↓ navigate · Enter select · / filter · n new · Esc close");
						if (!rows) return [
							`${tabName("worktrees")}  ${tabName("projects")}`, "",
							failed ? paint("error", "Unable to load worktrees.") : paint("dim", "Loading worktrees…"), "", footer,
						];
						const filterLine = filterDraft !== undefined
							? `${theme.bold(paint("accent", "filter>"))} ${filterDraft}▮   ${paint("dim", "⏎ keep · Esc clear")}`
							: session.filter ? paint("dim", `(showing ${items?.filter((item) => item.searchText.toLowerCase().includes(session.filter.toLowerCase())).length ?? 0} of ${items?.length ?? 0} matching "${session.filter}" — / edits, Esc clears)`) : undefined;
						return [
							`${tabName("worktrees")}  ${tabName("projects")}`, "",
							...(filterLine ? [filterLine, ""] : []),
							...rows.map((item, index) => `${index === row ? paint("accent", "→ ") : "  "}${item.label}${item.kind !== "create" && item.badges.length ? `  ${paint("dim", item.badges.join(" "))}` : ""}`),
							...(status.length ? ["", ...status] : []), "", footer,
						];
					},
					handleInput(data: string): void {
						if (filterDraft !== undefined) {
							if (matchesKey(data, Key.backspace)) filterDraft = filterDraft.slice(0, -1);
							else if (data === "\n" || data === "\r") {
								session.filter = filterDraft.trim(); row = 0; filterDraft = undefined; status = []; rebuild();
							} else if (data === "\x1b") {
								if (filterDraft) filterDraft = "";
								else { filterDraft = undefined; session.filter = ""; row = 0; rebuild(); }
							} else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) filterDraft += data;
							tui.requestRender(); return;
						}
						if (data === "/") { filterDraft = session.filter; status = []; tui.requestRender(); return; }
						if (matchesKey(data, Key.tab) || data === "\x1b[Z") {
							tab = tab === "worktrees" ? "projects" : "worktrees"; row = 0; status = []; rebuild(); tui.requestRender(); return;
						}
						if (matchesKey(data, Key.up)) { row = Math.max(0, row - 1); tui.requestRender(); return; }
						if (matchesKey(data, Key.down)) { row = Math.min((rows?.length ?? 1) - 1, row + 1); tui.requestRender(); return; }
						if (data === "q" || data === "\x1b") { finish({ kind: "close" }); return; }
						const selected = rows?.[row];
						if (data === "n" && selected) {
							const positional = selected.kind === "project" ? selected.projectKey : selected.kind === "sandbox" ? items?.find((item) => item.sandboxId === selected.sandboxId)?.projectKey : undefined;
							finish({ kind: "create", positional }); return;
						}
						if (data !== "\n" && data !== "\r") return;
						if (selected?.kind === "create") { finish({ kind: "create" }); return; }
						if (selected?.kind === "project") {
							tab = "worktrees"; session.filter = selected.label; row = 0; status = [paint("dim", `Showing worktrees for ${selected.label}.`)]; rebuild(); tui.requestRender(); return;
						}
						if (selected?.kind === "sandbox") {
							const item = items?.find((value) => value.sandboxId === selected.sandboxId);
							if (item) status = [...describeManagerItem(item), paint("dim", "read-only — connect/remove arrive in a later slice")];
							tui.requestRender();
						}
					},
				};
			});
		},
	};
}
