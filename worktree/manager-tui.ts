import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";
import { buildManagerRows, describeManagerItem, type ManagerRow, type ManagerSandboxItem, type ManagerSession, type PanelAction } from "./manager-core.js";

/**
 * pi-tui negotiates the terminal keyboard protocol at startup (Kitty CSI-u
 * with flags 7, modifyOtherKeys otherwise). Special keys — and, with Kitty
 * disambiguation, even plain printable keys — arrive as escape sequences, so
 * a custom component must match keys through `matchesKey` and decode text
 * through `decodeKittyPrintable`; raw `data === "\x1b"`/`"q"` checks only work
 * on legacy terminals. Model: pi-tui's own Input component + pi-agenticoding's
 * model-groups panel.
 */
function isEnter(data: string): boolean {
	return matchesKey(data, Key.enter) || data === "\n";
}

/** Esc (legacy, Kitty, modifyOtherKeys) and Ctrl+C are the panel's back/close key. */
function isCancel(data: string): boolean {
	return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
}

/** Printable text from a raw key event (Kitty CSI-u decoded, legacy passed through). */
function printableText(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	const hasControlChars = [...data].some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
	return data.length > 0 && !hasControlChars ? data : undefined;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CREATE_ROW: ManagerRow = { kind: "create", label: "+ new worktree…", badges: [] };

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
				// The create row is present from the first frame: a user who only
				// wants a new worktree never waits for the library probe to finish.
				let rows: ManagerRow[] = [CREATE_ROW];
				let loading = true;
				let failed = false;
				let filterDraft: string | undefined;
				let status: string[] = [];
				let spinnerFrame = 0;
				const loadingStartedAt = Date.now();
				let spinnerTimer: ReturnType<typeof setInterval> | undefined;
				let finished = false;
				const stopSpinner = () => {
					if (spinnerTimer !== undefined) {
						clearInterval(spinnerTimer);
						spinnerTimer = undefined;
					}
				};
				spinnerTimer = setInterval(() => {
					if (finished || !loading) return;
					spinnerFrame++;
					tui.requestRender();
				}, 100);
				spinnerTimer.unref?.();
				const finish = (action: PanelAction) => {
					if (finished) return;
					finished = true;
					stopSpinner();
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
						loading = false;
						stopSpinner();
						rebuild();
						tui.requestRender();
					},
					() => {
						if (finished) return;
						loading = false;
						failed = true;
						stopSpinner();
						tui.requestRender();
					},
				);
				return {
					invalidate(): void {},
					dispose(): void {
						finished = true;
						stopSpinner();
					},
					render(_width: number): string[] {
						const tabName = (name: ManagerSession["tab"]) => tab === name ? theme.bold(paint("accent", `[${name}]`)) : name;
						const footer = paint("dim", "Tab switch views · ↑/↓ navigate · Enter select · / filter · n new · Esc close");
						const filterLine = filterDraft !== undefined
							? `${theme.bold(paint("accent", "filter>"))} ${filterDraft}▮   ${paint("dim", "⏎ keep · Esc clear")}`
							: session.filter ? paint("dim", `(showing ${items?.filter((item) => item.searchText.toLowerCase().includes(session.filter.toLowerCase())).length ?? 0} of ${items?.length ?? 0} matching "${session.filter}" — / edits, Esc clears)`) : undefined;
						const loadingLine = loading
							? `${paint("accent", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!)} ${paint("dim", `Loading ${tab === "projects" ? "projects" : "worktrees"}… ${((Date.now() - loadingStartedAt) / 1000).toFixed(1)}s — Enter on “+ new worktree…” creates without waiting`)}`
							: failed ? paint("error", "Unable to load worktrees — Esc closes, reopen the manager to retry.") : undefined;
						const emptyLine = !loading && !failed && rows.length === 0
							? paint("dim", "(no projects yet — n starts a worktree in a repo)")
							: undefined;
						return [
							`${tabName("worktrees")}  ${tabName("projects")}`, "",
							...(filterLine ? [filterLine, ""] : []),
							...rows.map((item, index) => `${index === row ? paint("accent", "→ ") : "  "}${item.label}${item.kind !== "create" && item.badges.length ? `  ${paint("dim", item.badges.join(" "))}` : ""}`),
							...(emptyLine ? ["", emptyLine] : []),
							...(loadingLine ? ["", loadingLine] : []),
							...(status.length ? ["", ...status] : []), "", footer,
						];
					},
					handleInput(data: string): void {
						if (finished) return;
						const text = printableText(data);
						if (filterDraft !== undefined) {
							if (matchesKey(data, Key.backspace)) filterDraft = filterDraft.slice(0, -1);
							else if (isEnter(data)) {
								session.filter = filterDraft.trim(); row = 0; filterDraft = undefined; status = []; rebuild();
							} else if (isCancel(data)) {
								if (filterDraft) filterDraft = "";
								else { filterDraft = undefined; session.filter = ""; row = 0; rebuild(); }
							} else if (text !== undefined) filterDraft += text;
							tui.requestRender(); return;
						}
						if (text === "/") { filterDraft = session.filter; status = []; tui.requestRender(); return; }
						if (matchesKey(data, Key.tab) || data === "\x1b[Z") {
							tab = tab === "worktrees" ? "projects" : "worktrees"; row = 0; status = []; rebuild(); tui.requestRender(); return;
						}
						if (matchesKey(data, Key.up)) { row = Math.max(0, row - 1); tui.requestRender(); return; }
						if (matchesKey(data, Key.down)) { row = Math.max(0, Math.min(rows.length - 1, row + 1)); tui.requestRender(); return; }
						if (text === "q" || isCancel(data)) { finish({ kind: "close" }); return; }
						const selected = rows[row];
						if (text === "n" && selected) {
							const positional = selected.kind === "project" ? selected.projectKey : selected.kind === "sandbox" ? items?.find((item) => item.sandboxId === selected.sandboxId)?.projectKey : undefined;
							finish({ kind: "create", positional }); return;
						}
						if (!isEnter(data)) return;
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
