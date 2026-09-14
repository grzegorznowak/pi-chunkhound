import { describe, test } from "node:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ManagerSession } from "../../worktree/manager-core.js";
import { check } from "../lib/checks.js";

// The TUI presenter is live: Tab/Shift+Tab/arrows mutate the panel without
// ending the mount; only close/create (and future sub-screen back) resolve
// next(). The shared session is committed when that action resolves.
const items = [
	{ sandboxId: "one", projectKey: "/repo", projectLabel: "repo", branch: "feature", path: "/worktrees/one", indexed: true, gone: false, live: false, searchText: "repo feature" },
];

describe("worktree manager TUI presenter", () => {
	test("live navigation commits to the session when the panel action resolves", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const tui = { requestRender() {} };
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory(tui, theme, getKeybindings(), resolve); }) } };
			const presenter = createWorktreeManagerTuiPresenter(ctx as never, () => items);
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			// The real presenter may await its row provider before mounting; wait one
			// macrotask so the fake ui.custom has constructed the component.
			const tick = () => new Promise((resolve) => setImmediate(resolve));

			const rendered = presenter.next(session);
			await tick();
			const firstFrame = component!.render(100).join("\n");
			await check(t, "footer advertises Tab and a close hint", /tab/i.test(firstFrame) && /esc|close/i.test(firstFrame), firstFrame);

			component!.handleInput("\t");
			component!.handleInput("q");
			await check(t, "Tab stays live and the session commits on close", (await rendered as { kind?: string })?.kind === "close" && session.tab === "projects", JSON.stringify(session));

			const back = presenter.next(session);
			await tick();
			component!.handleInput("\x1b[Z");
			component!.handleInput("\x1b");
			await check(t, "Shift+Tab and Esc commit the worktrees view", (await back as { kind?: string })?.kind === "close" && session.tab === "worktrees", JSON.stringify(session));

			session.row = 0;
			const moved = presenter.next(session);
			await tick();
			component!.handleInput("\x1b[B");
			component!.handleInput("\x1b[A");
			component!.handleInput("q");
			await check(t, "Down then Up returns to the create row", (await moved as { kind?: string })?.kind === "close" && session.row === 0, JSON.stringify(session));

			const down = presenter.next(session);
			await tick();
			component!.handleInput("\x1b[B");
			component!.handleInput("q");
			await check(t, "Down reaches the first sandbox row", (await down as { kind?: string })?.kind === "close" && session.row === 1, JSON.stringify(session));

			session.row = 0;
			const create = presenter.next(session);
			await tick();
			component!.handleInput("\n");
			await check(t, "Enter on the selected create row requests creation", (await create as { kind?: string })?.kind === "create", JSON.stringify(session));
		} finally {
			setKeybindings(original);
		}
	});

	test("inline filter edits loaded rows and Esc clears in two stages", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const allItems = [items[0]!, { ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta", branch: "bugfix", path: "/worktrees/two", searchText: "beta bugfix" }];
			let providerCalls = 0;
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => typeof component) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const presenter = createWorktreeManagerTuiPresenter(ctx as never, () => { providerCalls++; return allItems; });
			const session: ManagerSession = { tab: "worktrees", row: 1, filter: "beta" };
			const pending = presenter.next(session);
			await new Promise((resolve) => setImmediate(resolve));
			component!.handleInput("/"); component!.handleInput("x"); component!.handleInput("\x7f");
			await check(t, "draft is seeded and printable/backspace edit it", component!.render(100).join("\n").includes("filter> beta▮"), component!.render(100).join("\n"));
			component!.handleInput("\x1b");
			let frame = component!.render(100).join("\n");
			await check(t, "first Esc clears draft but preserves applied rows", frame.includes("filter> ▮") && frame.includes("beta") && !frame.includes("repo · feature"), frame);
			component!.handleInput("\x1b");
			frame = component!.render(100).join("\n");
			await check(t, "second Esc closes editor and clears applied filter", !frame.includes("filter>") && frame.includes("repo · feature") && frame.includes("beta · bugfix"), frame);
			component!.handleInput("/"); component!.handleInput(" "); component!.handleInput("b"); component!.handleInput("e"); component!.handleInput("t"); component!.handleInput("a"); component!.handleInput(" "); component!.handleInput("\n");
			frame = component!.render(100).join("\n");
			await check(t, "Enter trims, filters, and anchors the create row", frame.includes("→ + new worktree") && !frame.includes("repo · feature") && session.filter === "beta" && session.row === 0, JSON.stringify({ frame, session }));
			await check(t, "filter interaction does not re-probe", providerCalls === 1, `calls=${providerCalls}`);
			component!.handleInput("q"); await pending;
			await check(t, "filter session commits on close", session.filter === "beta" && session.row === 0, JSON.stringify(session));
		} finally { setKeybindings(original); }
	});

	test("projects drill down and sandbox details stay in the panel", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const allItems = [items[0]!, { ...items[0]!, sandboxId: "two", branch: "other", path: "/worktrees/two", searchText: "repo other" }];
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => typeof component) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => allItems).next(session);
			await new Promise((resolve) => setImmediate(resolve));
			component!.handleInput("\t");
			await check(t, "projects render grouped count", component!.render(100).join("\n").includes("repo  2 worktrees"), component!.render(100).join("\n"));
			component!.handleInput("\n");
			await check(t, "project Enter drills into anchored filtered worktrees", session.tab === "worktrees" && session.filter === "repo" && session.row === 0 && component!.render(100).join("\n").includes("→ + new worktree"), JSON.stringify(session));
			component!.handleInput("\x1b[B"); component!.handleInput("\n");
			const detail = component!.render(100).join("\n");
			await check(t, "sandbox Enter renders details without resolving", detail.includes("feature") && detail.includes("/worktrees/one") && detail.includes("read-only"), detail);
			component!.handleInput("q");
			await check(t, "q closes after details", (await pending as { kind?: string }).kind === "close", JSON.stringify(session));
		} finally { setKeybindings(original); }
	});

	test("n creates in the selected row project", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			for (const mode of ["create", "sandbox", "project"] as const) {
				let component: { handleInput(data: string): void } | undefined;
				const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
				const session: ManagerSession = { tab: mode === "project" ? "projects" : "worktrees", row: mode === "sandbox" ? 1 : 0, filter: "" };
				const pending = createWorktreeManagerTuiPresenter(ctx as never, () => items).next(session);
				await new Promise((resolve) => setImmediate(resolve)); component!.handleInput("n");
				const action = await pending as { kind: string; positional?: string };
				await check(t, `${mode} n positional`, action.kind === "create" && action.positional === (mode === "create" ? undefined : "/repo"), JSON.stringify(action));
			}
		} finally { setKeybindings(original); }
	});

	test("mounts a loading frame before rows resolve and ignores late rows after close", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let resolveRows: ((value: typeof items) => void) | undefined;
			const rows = new Promise<typeof items>((resolve) => { resolveRows = resolve; });
			let renders = 0;
			const tui = { requestRender: () => { renders++; } };
			const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory(tui, theme, getKeybindings(), resolve); }) } };
			const presenter = createWorktreeManagerTuiPresenter(ctx as never, () => rows);
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = presenter.next(session);
			await check(t, "loading frame renders before the deferred provider", /loading worktrees/i.test(component!.render(100).join("\n")), component!.render(100).join("\n"));
			component!.handleInput("q");
			await pending;
			const rendersBeforeLateRows = renders;
			resolveRows!(items);
			await new Promise((resolve) => setImmediate(resolve));
			await check(t, "late rows neither re-render nor reopen a closed panel", renders === rendersBeforeLateRows, String(renders));
		} finally {
			setKeybindings(original);
		}
	});

	test("keyboard-protocol encoded keys drive the panel", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			// A live pi TUI negotiates Kitty CSI-u / modifyOtherKeys at startup:
			// Esc/Enter/q arrive encoded, so raw "\x1b"/"\n"/"q" checks miss them
			// (the stuck-panel bug). These sequences pin the real terminal path.
			const twoItems = [items[0]!, { ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta", branch: "bugfix", path: "/worktrees/two", searchText: "beta bugfix" }];
			const mount = async (row = 0) => {
				let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
				const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
				const session: ManagerSession = { tab: "worktrees", row, filter: "" };
				const pending = createWorktreeManagerTuiPresenter(ctx as never, () => twoItems).next(session);
				await new Promise((resolve) => setImmediate(resolve));
				return { component: component!, pending, session };
			};

			const kittyEsc = await mount();
			kittyEsc.component.handleInput("\x1b[27u");
			await check(t, "Kitty Esc closes the panel", (await kittyEsc.pending as { kind?: string })?.kind === "close", JSON.stringify(kittyEsc.session));

			const modifyOtherEsc = await mount();
			modifyOtherEsc.component.handleInput("\x1b[27;1;27~");
			await check(t, "modifyOtherKeys Esc closes the panel", (await modifyOtherEsc.pending as { kind?: string })?.kind === "close", "");

			const kittyCtrlC = await mount();
			kittyCtrlC.component.handleInput("\x1b[99;5u");
			await check(t, "Kitty Ctrl+C closes the panel", (await kittyCtrlC.pending as { kind?: string })?.kind === "close", "");

			const kittyQ = await mount();
			kittyQ.component.handleInput("\x1b[113u");
			await check(t, "Kitty q closes the panel", (await kittyQ.pending as { kind?: string })?.kind === "close", "");

			const kittyEnter = await mount();
			kittyEnter.component.handleInput("\x1b[13u");
			await check(t, "Kitty Enter selects the create row", (await kittyEnter.pending as { kind?: string })?.kind === "create", "");

			const kittyN = await mount(1);
			kittyN.component.handleInput("\x1b[110u");
			const nAction = await kittyN.pending as { kind: string; positional?: string };
			await check(t, "Kitty n creates in the selected project", nAction.kind === "create" && nAction.positional === "/repo", JSON.stringify(nAction));

			const kittyFilter = await mount();
			for (const sequence of ["\x1b[47u", "\x1b[98u", "\x1b[101u", "\x1b[116u", "\x1b[97u", "\x1b[13u"]) kittyFilter.component.handleInput(sequence);
			const frame = kittyFilter.component.render(100).join("\n");
			await check(t, "Kitty-encoded / typing filters the list", frame.includes("→ + new worktree") && !frame.includes("repo · feature") && kittyFilter.session.filter === "beta", JSON.stringify({ frame, session: kittyFilter.session }));
			kittyFilter.component.handleInput("\x1b[113u");
			await check(t, "filter session commits on close", (await kittyFilter.pending as { kind?: string })?.kind === "close" && kittyFilter.session.filter === "beta", JSON.stringify(kittyFilter.session));
		} finally { setKeybindings(original); }
	});

	test("loading frame offers creation immediately and shows progression", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		t.mock.timers.enable({ apis: ["setInterval"] });
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let resolveRows: ((value: typeof items) => void) | undefined;
			const rows = new Promise<typeof items>((resolve) => { resolveRows = resolve; });
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => rows).next(session);
			const firstFrame = component!.render(100).join("\n");
			await check(t, "create row and spinner are available before the library loads", firstFrame.includes("+ new worktree…") && /loading worktrees/i.test(firstFrame) && /creates without waiting/i.test(firstFrame), firstFrame);
			t.mock.timers.tick(250);
			await check(t, "spinner advances while loading", component!.render(100).join("\n") !== firstFrame, component!.render(100).join("\n"));
			component!.handleInput("\x1b[13u");
			await check(t, "Enter creates without waiting for rows", (await pending as { kind?: string })?.kind === "create", JSON.stringify(session));
			resolveRows!(items);
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			t.mock.timers.reset();
			setKeybindings(original);
		}
	});

	test("streams completed sandboxes with real done/total progress", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const twoItems = [items[0]!, { ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta", branch: "bugfix", path: "/worktrees/two", searchText: "beta bugfix" }];
			let finishLoad: ((value: typeof twoItems) => void) | undefined;
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, (_session, onProgress) => {
				onProgress?.({ done: 0, total: 2, items: [] });
				onProgress?.({ done: 1, total: 2, items: [twoItems[0]!] });
				return new Promise<typeof twoItems>((resolve) => { finishLoad = resolve; });
			}).next(session);
			const streaming = component!.render(100).join("\n");
			await check(t, "partial progress shows done/total and the completed row", streaming.includes("1/2") && streaming.includes("repo · feature") && !streaming.includes("beta · bugfix"), streaming);
			finishLoad!(twoItems);
			await new Promise((resolve) => setImmediate(resolve));
			const complete = component!.render(100).join("\n");
			await check(t, "resolved load shows every row and ends the loading line", complete.includes("beta · bugfix") && !/loading worktrees/i.test(complete), complete);
			component!.handleInput("q");
			await check(t, "loaded session still closes", (await pending as { kind?: string })?.kind === "close", JSON.stringify(session));
		} finally { setKeybindings(original); }
	});

	test("a store-backed remount reuses cached rows without recollecting", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let calls = 0;
			const store = createManagerItemStore(async () => { calls++; return items; });
			const mount = () => {
				let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
				const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
					component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
				}) } };
				const session: ManagerSession = { tab: "worktrees", row: 1, filter: "" };
				const pending = createWorktreeManagerTuiPresenter(ctx as never, (_session, onProgress) => store.load(onProgress), { onRefresh: () => store.invalidate() }).next(session);
				return { component: component!, pending, session };
			};

			const first = mount();
			await check(t, "the first mount paints the loading frame", /loading worktrees/i.test(first.component.render(100).join("\n")), first.component.render(100).join("\n"));
			await new Promise((resolve) => setImmediate(resolve));
			await check(t, "the collect lands once and paints the row", calls === 1 && first.component.render(100).join("\n").includes("repo · feature"), `calls=${calls}`);
			first.component.handleInput("q");
			await first.pending;

			const second = mount();
			const frame = second.component.render(100).join("\n");
			await check(t, "the remount paints cached rows on its first frame without a spinner", frame.includes("repo · feature") && !/loading worktrees/i.test(frame), frame);
			await check(t, "the remount starts no second collect", calls === 1, `calls=${calls}`);
			second.component.handleInput("q");
			await check(t, "the cached panel still closes", (await second.pending as { kind?: string })?.kind === "close", "");
		} finally { setKeybindings(original); }
	});

	test("r invalidates the cache and reloads the panel", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let calls = 0;
			const extra = { ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta", branch: "bugfix", path: "/worktrees/two", searchText: "beta bugfix" };
			const store = createManagerItemStore(async () => { calls++; return calls === 1 ? items : [...items, extra]; });
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const session: ManagerSession = { tab: "worktrees", row: 1, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, (_session, onProgress) => store.load(onProgress), { onRefresh: () => store.invalidate() }).next(session);
			await new Promise((resolve) => setImmediate(resolve));
			await check(t, "initial load shows the cached row", calls === 1 && component!.render(100).join("\n").includes("repo · feature"), `calls=${calls}`);
			component!.handleInput("r");
			const refreshing = component!.render(100).join("\n");
			await check(t, "refresh re-enters the loading state while rows stay visible", /loading worktrees/i.test(refreshing) && refreshing.includes("repo · feature"), refreshing);
			await new Promise((resolve) => setImmediate(resolve));
			const refreshed = component!.render(100).join("\n");
			await check(t, "refresh recollects and paints the new row", calls === 2 && refreshed.includes("beta · bugfix") && !/loading worktrees/i.test(refreshed), `${refreshed}\ncalls=${calls}`);
			component!.handleInput("q");
			await pending;
		} finally { setKeybindings(original); }
	});

	test("sandbox rows justify status labels and show checkout size", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const sized = [
				{ ...items[0]!, sizeBytes: 2048 },
				{ ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta-tools", branch: "bugfix/longer", path: "/worktrees/two", searchText: "beta bugfix", live: true, pr: { number: 7, state: "OPEN" }, sizeBytes: 3 * 1024 * 1024 },
			];
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const session: ManagerSession = { tab: "worktrees", row: 1, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => sized).next(session);
			const frame = component!.render(100).join("\n");
			const first = frame.split("\n").find((line) => line.includes("repo · feature"))!;
			const second = frame.split("\n").find((line) => line.includes("beta-tools · bugfix/longer"))!;
			await check(t, "every sandbox row shows its checkout size before drilling in", first.includes("checkout 2.0 KB") && second.includes("checkout 3.0 MB"), frame);
			await check(t, "status labels share a justified column", first.indexOf("indexed") === second.indexOf("indexed") && first.indexOf("indexed") > 0, `${first}\n${second}`);
			await check(t, "the size column lines up after the badges", first.indexOf("checkout") === second.indexOf("checkout"), `${first}\n${second}`);
			component!.handleInput("q");
			await pending;
		} finally { setKeybindings(original); }
	});
});
