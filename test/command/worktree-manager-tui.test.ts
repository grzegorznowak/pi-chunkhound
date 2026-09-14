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
});
