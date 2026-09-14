import { describe, test } from "node:test";
import { check } from "../lib/checks.js";

// Planned renderer-free manager input. The adapter from SandboxEntry/WtListInfo
// supplies these facts; renderers must not need filesystem or git access.
type ManagerSandboxItem = {
	sandboxId: string;
	projectKey: string;
	projectLabel: string;
	branch: string;
	path: string;
	indexed: boolean;
	gone: boolean;
	live: boolean;
	pr?: { number: number; state: string };
	searchText: string;
	sizeBytes?: number;
	createdAt?: string;
};

const items: ManagerSandboxItem[] = [
	{ sandboxId: "alpha-123", projectKey: "/repos/alpha", projectLabel: "alpha", branch: "feature/one", path: "/worktrees/alpha-123/feature-one", indexed: true, gone: false, live: false, searchText: "alpha feature one" },
	{ sandboxId: "beta-pr-42", projectKey: "/repos/beta", projectLabel: "beta", branch: "pull/42", path: "/worktrees/beta-pr-42/pull-42", indexed: true, gone: false, live: true, pr: { number: 42, state: "OPEN" }, searchText: "beta pull 42 pr" },
	{ sandboxId: "gone-7", projectKey: "/repos/gone", projectLabel: "gone", branch: "old", path: "/worktrees/gone-7/old", indexed: false, gone: true, live: true, searchText: "gone old" },
];

describe("worktree manager core", () => {
	test("create row is first and normalized sandbox facts survive in rows", async (t) => {
		const { buildManagerRows, createManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession();
		const rows = buildManagerRows(session, items);
		await check(t, "default lands on the first create row", session.tab === "worktrees" && session.row === 0 && session.filter === "" && session.preselect === undefined, JSON.stringify(session));
		await check(t, "create is first", rows[0]?.kind === "create" && rows[0]?.label === "+ new worktree…", JSON.stringify(rows[0]));
		const pr = rows.find((row: { sandboxId?: string }) => row.sandboxId === "beta-pr-42");
		const gone = rows.find((row: { sandboxId?: string }) => row.sandboxId === "gone-7");
		await check(t, "indexed row exposes its stable id and badge", rows.some((row: { sandboxId?: string; badges?: string[] }) => row.sandboxId === "alpha-123" && row.badges?.includes("indexed")), JSON.stringify(rows));
		await check(t, "PR row carries PR identity, not merely its branch", Boolean(pr?.label.includes("42") && pr.badges.includes("pr")), JSON.stringify(pr));
		await check(t, "gone/live row exposes both state badges", Boolean(gone?.badges.includes("gone") && gone.badges.includes("live")), JSON.stringify(gone));
	});

	test("pending preselect resolves only when its row is visible", async (t) => {
		const { buildManagerRows, createManagerSession } = await import("../../worktree/manager-core.js");
		const visible = createManagerSession({ row: 0, preselect: "beta-pr-42" });
		const visibleRows = buildManagerRows(visible, items);
		await check(t, "visible preselect moves the cursor and clears itself", visibleRows[visible.row]?.sandboxId === "beta-pr-42" && visible.preselect === undefined, JSON.stringify({ visible, visibleRows }));
		const hidden = createManagerSession({ row: 0, filter: "alpha", preselect: "beta-pr-42" });
		const hiddenRows = buildManagerRows(hidden, items);
		await check(t, "hidden preselect preserves filter, cursor, and pending id", hidden.filter === "alpha" && hidden.row === 0 && hidden.preselect === "beta-pr-42" && !hiddenRows.some((row: { sandboxId?: string }) => row.sandboxId === "beta-pr-42"), JSON.stringify({ hidden, hiddenRows }));
	});

	test("back and unsuccessful creates redisplay the same session values", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		for (const outcome of [{ kind: "cancelled" } as const, { kind: "failed" } as const]) {
			const session = createManagerSession({ tab: "projects", row: 3, filter: "fix" });
			const seen: Array<{ tab: string; row: number; filter: string }> = [];
			const actions = [{ kind: "back" } as const, { kind: "create", positional: "./repo" } as const, { kind: "close" } as const];
			const positionals: Array<string | undefined> = [];
			await runManagerSession({}, { next: async (current: typeof session) => { seen.push({ tab: current.tab, row: current.row, filter: current.filter }); return actions.shift(); } }, {
				session,
				runCreate: async (_current: typeof session, positional?: string) => { positionals.push(positional); return outcome; },
			});
			await check(t, `${outcome.kind}: one back and one create each redisplay`, seen.length === 3, JSON.stringify(seen));
			await check(t, `${outcome.kind}: session values survive`, seen.every((value) => value.tab === "projects" && value.row === 3 && value.filter === "fix"), JSON.stringify({ seen, session }));
			await check(t, `${outcome.kind}: positional forwarded`, positionals[0] === "./repo", JSON.stringify(positionals));
		}
	});

	test("created sandbox becomes pending preselection before redisplay", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession();
		let calls = 0;
		await runManagerSession({}, { next: async (current: typeof session) => {
			calls++;
			if (calls === 1) return { kind: "create" } as const;
			await check(t, "new id is visible to the next presentation", current.preselect === "new-sandbox", JSON.stringify(current));
			return { kind: "close" } as const;
		} }, { session, runCreate: async () => ({ kind: "created", sandboxId: "new-sandbox" }) });
		await check(t, "exactly one redisplay", calls === 2, `calls=${calls}`);
	});

	test("projects group matching worktrees in first-appearance order", async (t) => {
		const { buildManagerRows, createManagerSession } = await import("../../worktree/manager-core.js");
		const grouped = [...items, { ...items[0]!, sandboxId: "alpha-456", branch: "feature/two", searchText: "alpha feature two" }];
		const session = createManagerSession({ tab: "projects" });
		const rows = buildManagerRows(session, grouped);
		await check(t, "projects have no create row and retain order", rows.map((row) => row.label).join(",") === "alpha,beta,gone" && rows.every((row) => row.kind === "project"), JSON.stringify(rows));
		await check(t, "project keys and aggregate badges survive", rows[0]?.projectKey === "/repos/alpha" && rows[0]?.badges.includes("2 worktrees") === true && rows[1]?.badges.includes("1 worktree") === true, JSON.stringify(rows));
		session.filter = "pull 42";
		const filtered = buildManagerRows(session, grouped);
		await check(t, "filter applies before grouping", filtered.length === 1 && filtered[0]?.label === "beta", JSON.stringify(filtered));
	});

	test("sandbox details include identity, path, and optional facts", async (t) => {
		const { describeManagerItem } = await import("../../worktree/manager-core.js");
		const lines = describeManagerItem({ ...items[1]!, sizeBytes: 2048, createdAt: "2026-09-14T12:00:00Z" });
		const text = lines.join("\n");
		await check(t, "details expose the read-only sandbox facts", lines.length === 3 && text.includes("beta-pr-42 · beta · pull/42") && text.includes("/worktrees/beta-pr-42/pull-42") && text.includes("repo /repos/beta") && text.includes("indexed") && text.includes("live MCP") && text.includes("PR #42 OPEN") && text.includes("checkout 2.0 KB") && text.includes("created 2026-09-14"), text);
	});

	test("created from projects switches to worktrees before redisplay", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession({ tab: "projects" });
		let calls = 0;
		await runManagerSession({}, { next: async (current: typeof session) => {
			calls++;
			if (calls === 1) return { kind: "create" } as const;
			await check(t, "redisplay sees worktrees and pending id", current.tab === "worktrees" && current.preselect === "fresh", JSON.stringify(current));
			return { kind: "close" } as const;
		} }, { session, runCreate: async () => ({ kind: "created", sandboxId: "fresh" }) });
	});

	test("close and an absent action terminate", async (t) => {
		const { runManagerSession } = await import("../../worktree/manager-core.js");
		for (const finalAction of [{ kind: "close" } as const, undefined]) {
			let calls = 0;
			await runManagerSession({}, { next: async () => { calls++; return finalAction; } });
			await check(t, `${finalAction ? "close" : "undefined"} stops`, calls === 1, `next=${calls}`);
		}
	});
});
