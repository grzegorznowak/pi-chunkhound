import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildManagerRows, describeManagerItem, scopedManagerItems, type ManagerItem, type ManagerLoadProgress, type ManagerRow, type ManagerSession, type PanelAction } from "./manager-core.js";

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
const TABS: ReadonlyArray<ManagerSession["tab"]> = ["worktrees", "projects", "baselines"];

/**
 * Right-pad to a display width. List columns are laid out in terminal cells,
 * so wide/CJK labels must pad by `visibleWidth` — never by code units — or
 * the badge/size columns drift from the header (V2-19). Never pads past the
 * requested width and never trims: the render-time clip owns truncation.
 */
function padToWidth(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? text + " ".repeat(missing) : text;
}

/** Cache hits arrive synchronously; misses arrive as a shared promise. */
function isLoadedRows(
	value: readonly ManagerItem[] | Promise<readonly ManagerItem[]>,
): value is readonly ManagerItem[] {
	return Array.isArray(value);
}

export function createWorktreeManagerTuiPresenter(
	ctx: { ui: Pick<ExtensionCommandContext["ui"], "custom"> },
	getRows: (
		session: ManagerSession,
		onProgress?: (progress: ManagerLoadProgress) => void,
	) => readonly ManagerItem[] | Promise<readonly ManagerItem[]>,
	options: { onRefresh?: () => void } = {},
): { next(session: ManagerSession): Promise<PanelAction | undefined> } {
	return {
		next(session) {
			return ctx.ui.custom<PanelAction>((tui, theme, _keybindings, done) => {
				let tab = session.tab;
				let row = Math.max(0, session.row);
				let items: readonly ManagerItem[] | undefined;
				// The create row is present from the first frame on the worktrees tab:
				// a user who only wants a new worktree never waits for the library
				// probe to finish. Every other tab seeds no row until its items
				// resolve, so a cold-load Enter can never create off-tab (V2-20).
				let rows: ManagerRow[] = tab === "worktrees" ? [CREATE_ROW] : [];
				let loading = true;
				let failed = false;
				let progress: { done: number; total: number } | undefined;
				let filterDraft: string | undefined;
				let status: string[] = [];
				let spinnerFrame = 0;
				let loadingStartedAt = Date.now();
				let spinnerTimer: ReturnType<typeof setInterval> | undefined;
				let finished = false;
				const stopSpinner = () => {
					if (spinnerTimer !== undefined) {
						clearInterval(spinnerTimer);
						spinnerTimer = undefined;
					}
				};
				const startSpinner = () => {
					if (spinnerTimer !== undefined || finished) return;
					loadingStartedAt = Date.now();
					spinnerTimer = setInterval(() => {
						if (finished || !loading) return;
						spinnerFrame++;
						tui.requestRender();
					}, 100);
					spinnerTimer.unref?.();
				};
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
				const showTab = (next: ManagerSession["tab"]): void => {
					if (next === tab) return;
					tab = next;
					row = 0;
					status = [];
					session.project = undefined;
					rebuild();
					// A cold load has no built rows yet: re-seed the tab's own set so the
					// create row disappears when switching off worktrees while loading
					// (covers 1/2/3 and Tab/Shift+Tab) (V2-20).
					if (!items) rows = tab === "worktrees" ? [CREATE_ROW] : [];
					tui.requestRender();
				};
				const cycleTab = (step: number): void => showTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!);
				const paint = (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text);
				const settle = (loaded: readonly ManagerItem[]): void => {
					if (finished) return;
					items = loaded;
					progress = { done: loaded.length, total: loaded.length };
					loading = false;
					stopSpinner();
					rebuild();
					tui.requestRender();
				};
				const failLoad = (): void => {
					if (finished) return;
					loading = false;
					failed = true;
					stopSpinner();
					tui.requestRender();
				};
				/** Initial mount and `r` refresh share this path: a cache hit — the
				 * store's synchronous return — paints rows on the first frame, with no
				 * spinner; a miss streams progress into whichever mount is live. */
				const beginLoad = (): void => {
					progress = undefined;
					const applyProgress = (update: ManagerLoadProgress): void => {
						if (finished) return;
						items = update.items;
						progress = { done: update.done, total: update.total };
						loading = update.done < update.total;
						if (!loading) stopSpinner();
						rebuild();
						tui.requestRender();
					};
					let loaded: readonly ManagerItem[] | Promise<readonly ManagerItem[]>;
					try {
						loaded = getRows(session, applyProgress);
					} catch {
						failLoad();
						return;
					}
					if (isLoadedRows(loaded)) { settle(loaded); return; }
					loading = true;
					startSpinner();
					tui.requestRender();
					void loaded.then(settle, failLoad);
				};
				beginLoad();
				return {
					invalidate(): void {},
					dispose(): void {
						finished = true;
						stopSpinner();
					},
					render(width: number): string[] {
						const tabName = (name: ManagerSession["tab"]) => tab === name ? theme.bold(paint("accent", `[${name}]`)) : name;
						const footer = paint("dim", `Tab·1/2/3 views · ↑/↓ navigate · Enter select · / filter · n new · r refresh · ${session.project ? "Esc back" : "Esc close"}`);
						const scope = session.project;
						const visibleItems = items ? scopedManagerItems(items, scope?.key) : undefined;
						const filterLine = filterDraft !== undefined
							? `${theme.bold(paint("accent", "filter>"))} ${filterDraft}▮   ${paint("dim", "⏎ keep · Esc clear")}`
							: session.filter ? paint("dim", `(showing ${visibleItems?.filter((item) => item.searchText.toLowerCase().includes(session.filter.toLowerCase())).length ?? 0} of ${visibleItems?.length ?? 0} matching "${session.filter}" — / edits, Esc clears)`) : undefined;
						const scopeLine = scope
							? paint("dim", `(project "${scope.label}" — showing ${rows.filter((item) => item.kind === "sandbox").length} of ${visibleItems?.filter((item) => item.kind === "sandbox").length ?? 0} worktrees · Esc back to projects)`)
							: undefined;
						const notices = [filterLine, scopeLine].filter((line): line is string => line !== undefined);
						const loadingLine = loading
							? `${paint("accent", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!)} ${paint("dim", `Loading ${tab}…${progress ? ` ${progress.done}/${progress.total}` : ""} ${((Date.now() - loadingStartedAt) / 1000).toFixed(1)}s${tab === "worktrees" ? " — Enter on “+ new worktree…” creates without waiting" : ""}`)}`
							: failed ? paint("error", "Unable to load the worktree library — Esc closes, reopen the manager to retry.") : undefined;
						const emptyLine = !loading && !failed && rows.length === 0
							? paint("dim", tab === "baselines" ? "(no cached baselines — the create wizard primes them)" : "(no projects yet — n starts a worktree in a repo)")
							: undefined;
						// Justified columns: labels and status badges share a width across
						// rows, then measured rows line up under a dim DB/CHECKOUT/TOTAL
						// header with right-aligned numeric cells (the labelled
						// `db … · checkout … · total …` one-liner lives in the details).
						const badgeText = (item: ManagerRow): string => item.kind !== "create" && item.badges.length ? item.badges.join(" ") : "";
						// Columns are justified in terminal cells, not code units: a wide/CJK
						// label must not shift the badge or size columns (V2-19).
						const labelWidth = rows.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
						const badgeWidth = rows.reduce((max, item) => Math.max(max, visibleWidth(badgeText(item))), 0);
						const sizeColumnKeys = ["db", "checkout", "total"] as const;
						const sizeHeader: Record<(typeof sizeColumnKeys)[number], string> = { db: "DB", checkout: "CHECKOUT", total: "TOTAL" };
						// A column exists only when a visible row measured it: baselines carry db
						// alone, projects carry none, and unmeasured fixtures carry no cells.
						const sizeColumnWidths = new Map<(typeof sizeColumnKeys)[number], number>();
						for (const key of sizeColumnKeys) {
							const width = rows.reduce((max, item) => Math.max(max, item.sizeCells?.[key]?.length ?? 0), 0);
							if (width > 0) sizeColumnWidths.set(key, Math.max(width, sizeHeader[key].length));
						}
						const sizeColumns = sizeColumnKeys.filter((key) => sizeColumnWidths.has(key));
						const sizeSegment = (item: ManagerRow): string | undefined => {
							if (!item.sizeCells || sizeColumns.length === 0) return undefined;
							// A cell this row could not measure renders as `—` (the same marker
							// `ls`/fmtSizeMaybe uses) instead of a blank slot under a column a
							// sibling row earned (N-04): unmeasured stays unmeasured, never blank
							// and never a made-up 0.
							return sizeColumns.map((key) => (item.sizeCells?.[key] ?? "—").padStart(sizeColumnWidths.get(key) ?? 0)).join("  ");
						};
						// The header shares the row prefix (marker · padded label · padded
						// badges) so its labels sit exactly over the numeric columns.
						// Callers pad in display cells; padding happens before any styling.
						const rowPrefix = (marker: string, label: string, badges: string): string => `${marker}${label}${badgeWidth > 0 ? `  ${badges}` : ""}`;
						const headerSegment = sizeColumns.map((key) => sizeHeader[key].padStart(sizeColumnWidths.get(key) ?? 0)).join("  ");
						const headerLine = sizeColumns.length > 0 ? paint("dim", `${rowPrefix("  ", " ".repeat(labelWidth), " ".repeat(badgeWidth))}  ${headerSegment}`) : undefined;
						// Selected rows get pi's own list-selection treatment (session/tree
						// pickers): the label goes bold and the whole line is painted with the
						// theme's selectedBg, extended to the full panel width so the cursor
						// reads as a band rather than a lone arrow.
						const selectedBand = (line: string): string => theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
						const rowLine = (item: ManagerRow, index: number): string => {
							const selected = index === row;
							const marker = selected ? paint("accent", "→ ") : "  ";
							if (item.kind === "create") {
								const label = selected ? theme.bold(item.label) : item.label;
								return selected ? selectedBand(`${marker}${label}`) : `${marker}${label}`;
							}
							const label = padToWidth(item.label, labelWidth);
							let line = rowPrefix(marker, selected ? theme.bold(label) : label, paint("dim", padToWidth(badgeText(item), badgeWidth)));
							const segment = sizeSegment(item);
							if (segment) line += `  ${paint("dim", segment)}`;
							return selected ? selectedBand(line) : line;
						};
						// pi-tui aborts the whole TUI when a custom component renders a line
						// wider than the terminal: details lines and long paths overflow, so every
						// line is clipped to the width pi hands us (ANSI-safe, ellipsis on cut).
						return [
							TABS.map((name) => tabName(name)).join("  "), "",
							...(notices.length ? [...notices, ""] : []),
							...(headerLine ? [headerLine] : []),
							...rows.map(rowLine),
							...(emptyLine ? ["", emptyLine] : []),
							...(loadingLine ? ["", loadingLine] : []),
							...(status.length ? ["", ...status] : []), "", footer,
						].map((line) => truncateToWidth(line, width, "…"));
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
						if (matchesKey(data, Key.escape) && session.project) {
							session.project = undefined;
							row = 0;
							status = [];
							rebuild();
							tui.requestRender();
							return;
						}
						if (text === "/") { filterDraft = session.filter; status = []; tui.requestRender(); return; }
						if (text === "1" || text === "2" || text === "3") { showTab(TABS[Number(text) - 1]!); return; }
						if (text === "r") {
							if (loading) return; // a collect is already running
							options.onRefresh?.();
							failed = false;
							status = [];
							beginLoad();
							tui.requestRender();
							return;
						}
						if (data === "\x1b[Z" || matchesKey(data, Key.shift("tab"))) { cycleTab(-1); return; }
						if (matchesKey(data, Key.tab)) { cycleTab(1); return; }
						if (matchesKey(data, Key.up)) { row = Math.max(0, row - 1); tui.requestRender(); return; }
						if (matchesKey(data, Key.down)) { row = Math.max(0, Math.min(rows.length - 1, row + 1)); tui.requestRender(); return; }
						if (text === "q" || isCancel(data)) { finish({ kind: "close" }); return; }
						const selected = rows[row];
						if (text === "n") {
							const positional = selected?.kind === "project" ? selected.projectKey
								: selected?.kind === "sandbox" ? items?.find((item) => item.kind === "sandbox" && item.sandboxId === selected.sandboxId)?.projectKey
									: selected?.kind === "baseline" ? items?.find((item) => item.kind === "baseline" && item.baselineDir === selected.baselineDir)?.projectKey
										: session.project?.key;
							finish({ kind: "create", positional }); return;
						}
						if (!isEnter(data)) return;
						if (selected?.kind === "create") {
							// Belt and braces for the loading window: rows are seeded per tab,
							// so Enter only ever creates from the worktrees view (V2-20).
							if (tab === "worktrees") finish({ kind: "create", positional: session.project?.key });
							return;
						}
						if (selected?.kind === "project") {
							if (selected.projectKey) session.project = { key: selected.projectKey, label: selected.label };
							session.filter = "";
							row = 0;
							status = [];
							rebuild();
							tui.requestRender(); return;
						}
						if (selected?.kind === "sandbox" || selected?.kind === "baseline") {
							const item = selected.kind === "sandbox"
								? items?.find((value) => value.kind === "sandbox" && value.sandboxId === selected.sandboxId)
								: items?.find((value) => value.kind === "baseline" && value.baselineDir === selected.baselineDir);
							if (item) {
								const note = selected.kind === "baseline" ? "read-only — baseline refresh/removal arrive in a later slice" : "read-only — connect/remove arrive in a later slice";
								status = [...describeManagerItem(item), paint("dim", note)];
							}
							tui.requestRender();
						}
					},
				};
			});
		},
	};
}
