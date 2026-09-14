import { describe, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { ManagerBaselineItem, ManagerLoadProgress, ManagerSandboxItem, ManagerSession } from "../../worktree/manager-core.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// The TUI presenter is live: Tab/Shift+Tab/arrows mutate the panel without
// ending the mount; only close/create (and future sub-screen back) resolve
// next(). The shared session is committed when that action resolves.
const items: ManagerSandboxItem[] = [
	{ kind: "sandbox", sandboxId: "one", projectKey: "/repo", projectLabel: "repo", branch: "feature", path: "/worktrees/one", indexed: true, gone: false, live: false, searchText: "repo feature" },
];

const baseline: ManagerBaselineItem = { kind: "baseline", baselineDir: "/cache/bases/repo/main", projectKey: "/repos/repo", projectLabel: "repo", ref: "main", path: "/repos/repo", searchText: "repo main baseline", dbBytes: 7 * 1024 * 1024, baseCommit: "c9698c47bb164ed50cae0ce3578a65887dd88560", chhoundVersion: "chhound 5.2.2", updatedAt: "2026-09-06T11:50:50.222Z" };

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
			const allItems = [items[0]!, { ...items[0]!, sandboxId: "two", branch: "other", path: "/worktrees/two", searchText: "repo other" }, { ...items[0]!, sandboxId: "tools", projectKey: "/repos/repo-tools", projectLabel: "repo-tools", branch: "tooling", path: "/worktrees/tools", searchText: "/repos/repo-tools repo-tools tooling repo" }];
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => typeof component) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => allItems).next(session);
			await new Promise((resolve) => setImmediate(resolve));
			component!.handleInput("\t");
			let frame = component!.render(100).join("\n");
			await check(t, "projects render grouped count", /repo\s+2 worktrees/.test(frame) && frame.includes("repo-tools"), frame);
			component!.handleInput("\n");
			frame = component!.render(100).join("\n");
			await check(t, "project Enter keeps the projects tab and lists its worktrees", session.tab === "projects" && session.project?.key === "/repo" && session.filter === "" && session.row === 0 && frame.includes("[projects]") && !frame.includes("[worktrees]") && frame.includes('project "repo"') && frame.includes("repo · feature") && !frame.includes("repo-tools") && !frame.includes("+ new worktree") && frame.includes("Esc back"), frame);
			component!.handleInput("\n");
			const detail = component!.render(100).join("\n");
			await check(t, "sandbox Enter renders details without resolving", detail.includes("feature") && detail.includes("/worktrees/one") && detail.includes("read-only"), detail);
			component!.handleInput("\x1b");
			frame = component!.render(100).join("\n");
			await check(t, "Esc backs out to the project list without closing", session.project === undefined && frame.includes("repo-tools") && !frame.includes('project "repo"') && !frame.includes("read-only"), frame);
			component!.handleInput("q");
			await check(t, "q closes after details", (await pending as { kind?: string }).kind === "close", JSON.stringify(session));
		} finally { setKeybindings(original); }
	});

	test("n creates in the selected row project", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			for (const mode of ["create", "sandbox", "project", "scoped"] as const) {
				let component: { handleInput(data: string): void } | undefined;
				const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { handleInput(data: string): void }) => await new Promise<unknown>((resolve) => { component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve); }) } };
				const session: ManagerSession = { tab: mode === "project" || mode === "scoped" ? "projects" : "worktrees", row: mode === "sandbox" ? 1 : 0, filter: "", ...(mode === "scoped" ? { project: { key: "/repo", label: "repo" } } : {}) };
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

	test("metadata rows paint before the probes, then fill in place", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const metaOne: ManagerSandboxItem = { ...items[0]! };
			const metaTwo: ManagerSandboxItem = { ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta", branch: "bugfix", path: "/worktrees/two", searchText: "beta bugfix" };
			let stream: ((progress: ManagerLoadProgress) => void) | undefined;
			let finishLoad: ((value: readonly ManagerSandboxItem[]) => void) | undefined;
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const session: ManagerSession = { tab: "worktrees", row: 1, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, (_session, onProgress) => {
				stream = onProgress;
				onProgress?.({ done: 0, total: 2, items: [metaOne, metaTwo] });
				return new Promise<readonly ManagerSandboxItem[]>((resolve) => { finishLoad = resolve; });
			}).next(session);
			const firstFrame = component!.render(100).join("\n");
			await check(t, "every metadata row and 0/2 progress paints on the first frame", firstFrame.includes("repo · feature") && firstFrame.includes("beta · bugfix") && firstFrame.includes("0/2") && /loading worktrees/i.test(firstFrame), firstFrame);
			stream!({ done: 1, total: 2, items: [{ ...metaOne, dbBytes: 2048, sizeBytes: 1024 }, metaTwo] });
			const filling = component!.render(100).join("\n");
			await check(t, "a settled probe fills its own row while the pending row stays visible", filling.includes("1/2") && filling.includes("2.0 KB") && filling.includes("1.0 KB") && filling.includes("beta · bugfix"), filling);
			finishLoad!([{ ...metaOne, dbBytes: 2048, sizeBytes: 1024 }, { ...metaTwo, dbBytes: 4096, sizeBytes: 2048 }]);
			await new Promise((resolve) => setImmediate(resolve));
			const complete = component!.render(100).join("\n");
			await check(t, "the resolved load ends the loading line", !/loading worktrees/i.test(complete) && complete.includes("4.0 KB"), complete);
			component!.handleInput("q");
			await pending;
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

	test("sandbox rows justify status labels and align size columns", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const sized = [
				{ ...items[0]!, sizeBytes: 2048, dbBytes: 1024 * 1024 },
				{ ...items[0]!, sandboxId: "two", projectKey: "/beta", projectLabel: "beta-tools", branch: "bugfix/longer", path: "/worktrees/two", searchText: "beta bugfix", live: true, pr: { number: 7, state: "OPEN" }, sizeBytes: 3 * 1024 * 1024, dbBytes: 2 * 1024 * 1024 },
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
			const header = frame.split("\n").find((line) => line.includes("CHECKOUT"))!;
			await check(t, "one DB/CHECKOUT/TOTAL header replaces the per-row labels", header.includes("DB") && header.includes("TOTAL") && !first.includes("db ") && !second.includes("checkout ") && frame.indexOf(header) < frame.indexOf(first), frame);
			await check(t, "every measured row keeps its values", first.includes("1.0 MB") && first.includes("2.0 KB") && second.includes("2.0 MB") && second.includes("3.0 MB") && second.includes("5.0 MB"), frame);
			await check(t, "status labels share a justified column", first.indexOf("indexed") === second.indexOf("indexed") && first.indexOf("indexed") > 0, `${first}\n${second}`);
			const end = (line: string, value: string): number => line.indexOf(value) + value.length;
			await check(t, "numeric cells right-align under their header columns", end(first, "2.0 KB") === end(second, "3.0 MB") && end(first, "1.0 MB") === end(second, "2.0 MB") && end(header, "DB") === end(first, "1.0 MB") && end(header, "CHECKOUT") === end(first, "2.0 KB") && end(header, "TOTAL") === end(second, "5.0 MB"), `${header}\n${first}\n${second}`);
			component!.handleInput("q");
			await pending;
		} finally { setKeybindings(original); }
	});

	test("baselines tab renders db-only rows, details, and create-in-repo", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => [...items, baseline]).next(session);
			component!.handleInput("3");
			let frame = component!.render(100).join("\n");
			await check(t, "digit 3 opens the baselines tab with a DB-only column", frame.includes("[baselines]") && frame.includes("repo · main") && frame.includes("DB") && frame.includes("7.0 MB") && !frame.includes("CHECKOUT") && !frame.includes("+ new worktree"), frame);
			component!.handleInput("\n");
			frame = component!.render(200).join("\n");
			await check(t, "baseline details explain the index and absence of a checkout", frame.includes("baseline index (no checkout copy)") && frame.includes("commit c9698c47bb16") && frame.includes("updated 2026-09-06"), frame);
			component!.handleInput("\t");
			frame = component!.render(100).join("\n");
			await check(t, "Tab wraps baselines back to worktrees", frame.includes("[worktrees]") && frame.includes("+ new worktree"), frame);
			component!.handleInput("3");
			component!.handleInput("n");
			const action = await pending as { kind: string; positional?: string };
			await check(t, "n on a baseline starts a create in its repo", action.kind === "create" && action.positional === "/repos/repo", JSON.stringify(action));
		} finally { setKeybindings(original); }
	});

	test("every rendered line is clipped to the terminal width", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const longSandbox = { ...items[0]!, branch: "feature/a-very-long-branch-name-that-keeps-going-and-going", path: "/worktrees/one/a-very-long-worktree-path-that-keeps-going-and-going/beyond" };
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => [longSandbox, baseline]).next({ tab: "worktrees", row: 1, filter: "" });
			await new Promise((resolve) => setImmediate(resolve));
			const width = 64;
			const fits = (lines: string[]): string | undefined => lines.find((line) => visibleWidth(line) > width);
			await check(t, "worktree rows clip to the width", fits(component!.render(width)) === undefined, JSON.stringify(component!.render(width)));
			component!.handleInput("\n");
			await check(t, "long worktree details clip to the width", fits(component!.render(width)) === undefined, JSON.stringify(component!.render(width)));
			component!.handleInput("3");
			await check(t, "baseline rows clip to the width", fits(component!.render(width)) === undefined, JSON.stringify(component!.render(width)));
			component!.handleInput("\n");
			await check(t, "long baseline details clip to the width", fits(component!.render(width)) === undefined, JSON.stringify(component!.render(width)));
			component!.handleInput("q");
			await pending;
		} finally { setKeybindings(original); }
	});

	test("n on an empty tab still starts a create", async (t) => {
		const { createWorktreeManagerTuiPresenter } = await import("../../worktree/manager-tui.js");
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
			const ctx = { ui: { custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
				component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
			}) } };
			const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
			const pending = createWorktreeManagerTuiPresenter(ctx as never, () => items).next(session);
			component!.handleInput("3");
			await check(t, "an empty baselines tab renders no selectable row", !component!.render(100).join("\n").includes("→ "), component!.render(100).join("\n"));
			component!.handleInput("n");
			const action = await pending as { kind: string; positional?: string };
			await check(t, "n without a selection still opens the create wizard", action.kind === "create" && action.positional === undefined, JSON.stringify(action));
		} finally { setKeybindings(original); }
	});

	test("a session keeps one manager store across command invocations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-manager-store-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const { registerWorktreeCommand } = await import("../../worktree/command.js");
			const { createManagerItemStore } = await import("../../worktree/manager-core.js");
			const { loadSettings } = await import("../../chhound/settings.js");
			const { sandboxRoot } = await import("../../chhound/paths.js");
			const { writeSandboxMeta } = await import("../../chhound/sandbox.js");
			let stores = 0;
			let collects = 0;
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const pi = { registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) { handler = def.handler; } };
			registerWorktreeCommand(pi as never, {} as never, {
				createItemStore: (loader) => {
					stores++;
					return createManagerItemStore((onProgress) => {
						collects++;
						return loader(onProgress);
					});
				},
			});
			const openManager = async (): Promise<void> => {
				let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
				const ctx = {
					cwd: root,
					mode: "tui",
					hasUI: true,
					ui: {
						notify() {},
						custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => await new Promise<unknown>((resolve) => {
							component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
						}),
					},
				};
				const pending = handler!("", ctx as never);
				await new Promise((resolve) => setTimeout(resolve, 100));
				component!.handleInput("q");
				await pending;
			};

			await openManager();
			await check(t, "the first open creates the session store and collects once", stores === 1 && collects === 1, `stores=${stores} collects=${collects}`);
			await openManager();
			await check(t, "a reopen with an unchanged library reuses the cached collect", stores === 1 && collects === 1, `stores=${stores} collects=${collects}`);
			const { settings } = loadSettings(root);
			const sandboxId = "sb-new-00000001";
			const sandboxState = path.join(sandboxRoot(settings), ".state", sandboxId);
			writeSandboxMeta(sandboxState, {
				version: 1, worktree: path.join(root, "not-checked-out"), repoRoot: path.join(root, "repo"), branch: "feat",
				baseRef: "main", baseCommit: "0000000000000000000000000000000000000000", chhoundVersion: "test",
				createdAt: "2026-09-14T00:00:00.000Z", copiedFrom: "", dbPath: path.join(sandboxState, "db"),
			});
			await openManager();
			await check(t, "a library change recollects into the same session store", stores === 1 && collects === 2, `stores=${stores} collects=${collects}`);
		} finally {
			applyEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
