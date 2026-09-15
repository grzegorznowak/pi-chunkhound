import { describe, test } from "node:test";
import { check } from "../lib/checks.js";
import type { ManagerBaselineItem, ManagerItem, ManagerSession } from "../../worktree/manager-core.js";

const items = (): ManagerItem[] => [{ kind: "sandbox", sandboxId: "one", projectKey: "/repo", projectLabel: "repo", branch: "feature", path: "/worktrees/one", indexed: true, gone: false, live: false, searchText: "repo feature" }];

describe("worktree manager RPC presenter", () => {
	test("one select round-trip maps create and conveys the active view", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		const calls: Array<{ title: string; options: string[] }> = [];
		const ctx = { ui: { select: async (title: string, options: string[]) => { calls.push({ title, options }); return "+ new worktree…"; } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, items);
		const action = await presenter.next({ tab: "worktrees", row: 0, filter: "" } satisfies ManagerSession);
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
		const session: ManagerSession = { tab: "projects", row: 0, filter: "" };
		const back = await presenter.next(session);
		await check(t, "cancel maps to shared back action", back?.kind === "back" && calls === 1, JSON.stringify({ back, calls }));
		const close = await presenter.next(session);
		await check(t, "close maps to close action with one additional call", close?.kind === "close" && calls === 2, JSON.stringify({ close, calls }));
	});

	test("view switching and project selection mutate the shared session", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		const session: ManagerSession = { tab: "worktrees", row: 2, filter: "" };
		const calls: Array<{ title: string; options: string[] }> = [];
		const responses = ["view: projects", "repo (1 worktree)", "back to all projects"];
		const ctx = { ui: { select: async (title: string, options: string[]) => { calls.push({ title, options }); return responses.shift(); } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, items);
		const switched = await presenter.next(session);
		await check(t, "view option switches in one select", switched.kind === "back" && calls.length === 1 && session.tab === "projects" && session.row === 0, JSON.stringify({ calls, session }));
		const project = await presenter.next(session);
		await check(t, "projects menu has create and grouped project", calls[1]!.options.filter((option) => option === "+ new worktree…").length === 1 && calls[1]!.options.includes("repo (1 worktree)"), JSON.stringify(calls[1]));
		await check(t, "project selection scopes the projects view by project key", project.kind === "back" && session.tab === "projects" && session.project?.key === "/repo" && session.filter === "" && session.row === 0, JSON.stringify(session));
		const unscoped = await presenter.next(session);
		await check(t, "scoped view names the project and offers a way back", calls[2]!.title.includes("1 worktree in “repo”") && calls[2]!.options.includes("back to all projects"), JSON.stringify(calls[2]));
		await check(t, "back to all projects clears the scope", unscoped.kind === "back" && session.project === undefined && session.tab === "projects" && session.row === 0, JSON.stringify(session));
	});

	test("sandbox details offer only back and close", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		for (const detailChoice of ["back", "close", undefined]) {
			const calls: Array<{ title: string; options: string[] }> = [];
			const ctx = { ui: { select: async (title: string, options: string[]) => {
				calls.push({ title, options });
				return calls.length === 1 ? "repo · feature (indexed)" : detailChoice;
			} } };
			const action = await createWorktreeManagerRpcPresenter(ctx, items).next({ tab: "worktrees", row: 0, filter: "" });
			await check(t, `${String(detailChoice)} detail result`, action.kind === (detailChoice === "close" ? "close" : "back"), JSON.stringify(action));
			await check(t, `${String(detailChoice)} uses a two-select detail`, calls.length === 2 && calls[1]!.title.includes("Worktree details") && calls[1]!.title.includes("one") && calls[1]!.title.includes("/worktrees/one") && calls[1]!.options.join(",") === "back,close", JSON.stringify(calls));
		}
	});

	test("baselines view cycles in and opens baseline details", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		const baseline: ManagerBaselineItem = { kind: "baseline", baselineDir: "/cache/bases/repo/main", projectKey: "/repos/repo", projectLabel: "repo", ref: "main", path: "/repos/repo", searchText: "repo main", dbBytes: 7 * 1024 * 1024, baseCommit: "c9698c47bb164ed50cae0ce3578a65887dd88560", chhoundVersion: "chhound 5.2.2", updatedAt: "2026-09-06T11:50:50.222Z" };
		const calls: Array<{ title: string; options: string[] }> = [];
		const responses: Array<string | undefined> = ["view: baselines", "repo · main", "close"];
		const ctx = { ui: { select: async (title: string, options: string[]) => { calls.push({ title, options }); return responses.shift(); } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, () => [items()[0]!, baseline]);
		const session: ManagerSession = { tab: "projects", row: 0, filter: "" };
		await presenter.next(session);
		await check(t, "projects view offers the baselines switch", calls[0]!.options.includes("view: baselines") && session.tab === "baselines", JSON.stringify(calls[0]));
		const detail = await presenter.next(session);
		await check(t, "baselines view lists the cached baseline", calls[1]!.title.includes("1 baseline") && calls[1]!.options.includes("repo · main"), JSON.stringify(calls[1]));
		await check(t, "baseline selection opens its own details", detail.kind === "close" && calls[2]!.title.startsWith("Baseline details") && calls[2]!.title.includes("/repos/repo") && calls[2]!.options.join(",") === "back,close", JSON.stringify(calls[2]));
	});

	test("rows are obtained afresh for every presentation", async (t) => {
		const { createWorktreeManagerRpcPresenter } = await import("../../worktree/manager-rpc.js");
		let version = 0;
		const titles: string[] = [];
		const ctx = { ui: { select: async (title: string) => { titles.push(title); return "close"; } } };
		const presenter = createWorktreeManagerRpcPresenter(ctx, () => {
			version++;
			return [{ kind: "sandbox", sandboxId: `fresh-${version}`, projectKey: "/repo", projectLabel: "repo", branch: "feature", path: `/worktrees/${version}`, indexed: true, gone: false, live: false, searchText: `fresh ${version}` }];
		});
		const session: ManagerSession = { tab: "worktrees", row: 0, filter: "" };
		await presenter.next(session);
		await presenter.next(session);
		await check(t, "provider runs once per next", version === 2, `version=${version}; titles=${JSON.stringify(titles)}`);
	});
});
