import { describe, test } from "node:test";
import { check } from "../lib/checks.js";
import type { ManagerSession } from "../../worktree/manager-core.js";

const items = () => [{ sandboxId: "one", projectKey: "/repo", projectLabel: "repo", branch: "feature", path: "/worktrees/one", indexed: true, gone: false, live: false, searchText: "repo feature" }];

describe("worktree manager RPC presenter", () => {
	test("one select round-trip maps create and conveys the active view", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		const calls: Array<{ title: string; options: string[] }> = [];
		const ctx = { ui: { select: async (title: string, options: string[]) => { calls.push({ title, options }); return "+ new worktree…"; } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, items);
		const action = await presenter.next({ tab: "worktrees", row: 0, filter: "", preselect: undefined } satisfies ManagerSession);
		await check(t, "create selection maps to create", action?.kind === "create", JSON.stringify(action));
		await check(t, "one select call per next", calls.length === 1, JSON.stringify(calls));
		await check(t, "title conveys active worktrees view", calls[0]!.title.includes("worktrees"), calls[0]!.title);
		await check(t, "menu has an explicit close option", calls[0]!.options.includes("close"), JSON.stringify(calls[0]!.options));
	});

	test("cancel is back and close is explicit, each in one round-trip", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		const responses: Array<string | undefined> = [undefined, "close"];
		let calls = 0;
		const ctx = { ui: { select: async () => { calls++; return responses.shift(); } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, items);
		const session: ManagerSession = { tab: "projects", row: 0, filter: "", preselect: undefined };
		const back = await presenter.next(session);
		await check(t, "cancel maps to shared back action", back?.kind === "back" && calls === 1, JSON.stringify({ back, calls }));
		const close = await presenter.next(session);
		await check(t, "close maps to close action with one additional call", close?.kind === "close" && calls === 2, JSON.stringify({ close, calls }));
	});

	test("rows are obtained afresh for every presentation", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		let version = 0;
		const titles: string[] = [];
		const ctx = { ui: { select: async (title: string) => { titles.push(title); return "close"; } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, () => {
			version++;
			return [{ sandboxId: `fresh-${version}`, projectKey: "/repo", projectLabel: "repo", branch: "feature", path: `/worktrees/${version}`, indexed: true, gone: false, live: false, searchText: `fresh ${version}` }];
		});
		const session: ManagerSession = { tab: "worktrees", row: 0, filter: "", preselect: undefined };
		await presenter.next(session);
		await presenter.next(session);
		await check(t, "provider runs once per next", version === 2, `version=${version}; titles=${JSON.stringify(titles)}`);
	});
});
