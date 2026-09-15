import { describe, test } from "node:test";
import { check } from "../lib/checks.js";

// Planned renderer-free manager input. The adapter from SandboxEntry/WtListInfo
// supplies these facts; renderers must not need filesystem or git access.
type ManagerSandboxItem = {
	kind: "sandbox";
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
	dbBytes?: number;
	createdAt?: string;
};

type ManagerBaselineItem = {
	kind: "baseline";
	baselineDir: string;
	projectKey: string;
	projectLabel: string;
	ref: string;
	path: string;
	searchText: string;
	dbBytes?: number;
	baseCommit?: string;
	chhoundVersion?: string;
	updatedAt?: string;
};

const items: ManagerSandboxItem[] = [
	{ kind: "sandbox", sandboxId: "alpha-123", projectKey: "/repos/alpha", projectLabel: "alpha", branch: "feature/one", path: "/worktrees/alpha-123/feature-one", indexed: true, gone: false, live: false, searchText: "alpha feature one" },
	{ kind: "sandbox", sandboxId: "beta-pr-42", projectKey: "/repos/beta", projectLabel: "beta", branch: "pull/42", path: "/worktrees/beta-pr-42/pull-42", indexed: true, gone: false, live: true, pr: { number: 42, state: "OPEN" }, searchText: "beta pull 42 pr" },
	{ kind: "sandbox", sandboxId: "gone-7", projectKey: "/repos/gone", projectLabel: "gone", branch: "old", path: "/worktrees/gone-7/old", indexed: false, gone: true, live: true, searchText: "gone old" },
];

const baselines: ManagerBaselineItem[] = [
	{ kind: "baseline", baselineDir: "/cache/bases/alpha/main", projectKey: "/repos/alpha", projectLabel: "alpha", ref: "main", path: "/repos/alpha", searchText: "alpha main baseline", dbBytes: 7 * 1024 * 1024, baseCommit: "c9698c47bb164ed50cae0ce3578a65887dd88560", chhoundVersion: "chhound 5.2.2", updatedAt: "2026-09-06T11:50:50.222Z" },
];

// Full SandboxEntry for the builder/cache-key pins: dir basename = sandboxId,
// claimedRoot marks it indexed without a filesystem sidecar read.
const sandboxEntry = {
	dir: "/sandboxes/alpha-123",
	stateDir: "/sandboxes/.state/alpha-123",
	meta: {
		version: 1 as const,
		worktree: "/worktrees/alpha-123/feature-one",
		repoRoot: "/repos/alpha",
		branch: "feature/one",
		baseRef: "main",
		baseCommit: "c9698c47bb164ed50cae0ce3578a65887dd88560",
		chhoundVersion: "chhound 5.2.2",
		createdAt: "2026-09-14T12:00:00.000Z",
		copiedFrom: "/cache/bases/alpha/main",
		dbPath: "/sandboxes/.state/alpha-123/.chhound.db",
	},
	dbSizeBytes: 1024,
	claimedRoot: "/worktrees/alpha-123/feature-one",
};

const baselineMeta = {
	version: 1 as const,
	repoRoot: "/repos/alpha",
	baseRef: "main",
	baseCommit: "c9698c47bb164ed50cae0ce3578a65887dd88560",
	chhoundVersion: "chhound 5.2.2",
	updatedAt: "2026-09-06T11:50:50.222Z",
};

const fullSandboxItem = async () => {
	const { sandboxMetaItem } = await import("../../worktree/manager-core.js");
	return sandboxMetaItem(sandboxEntry, { live: true, pr: { number: 7, state: "OPEN" } });
};

describe("worktree manager core", () => {
	test("create row is first and normalized sandbox facts survive in rows", async (t) => {
		const { buildManagerRows, createManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession();
		const rows = buildManagerRows(session, items);
		await check(t, "default lands on the first create row", session.tab === "worktrees" && session.row === 0 && session.filter === "", JSON.stringify(session));
		await check(t, "create is first", rows[0]?.kind === "create" && rows[0]?.label === "+ new worktree…", JSON.stringify(rows[0]));
		const pr = rows.find((row: { sandboxId?: string }) => row.sandboxId === "beta-pr-42");
		const gone = rows.find((row: { sandboxId?: string }) => row.sandboxId === "gone-7");
		await check(t, "indexed row exposes its stable id and badge", rows.some((row: { sandboxId?: string; badges?: string[] }) => row.sandboxId === "alpha-123" && row.badges?.includes("indexed")), JSON.stringify(rows));
		await check(t, "PR row carries PR identity, not merely its branch", Boolean(pr?.label.includes("42") && pr.badges.includes("pr")), JSON.stringify(pr));
		await check(t, "gone/live row exposes both state badges, live as the plug glyph", Boolean(gone?.badges.includes("gone") && gone.badges.includes("🔌") && !gone.badges.includes("live")), JSON.stringify(gone));
	});

	test("back and unsuccessful creates redisplay the same session values", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		for (const outcome of [{ kind: "cancelled" } as const, { kind: "failed" } as const]) {
			const session = createManagerSession({ tab: "projects", row: 3, filter: "fix", project: { key: "/repos/alpha", label: "alpha" } });
			const seen: Array<{ tab: string; row: number; filter: string; projectKey?: string }> = [];
			const actions = [{ kind: "back" } as const, { kind: "create", positional: "./repo" } as const, { kind: "close" } as const];
			const positionals: Array<string | undefined> = [];
			await runManagerSession({}, { next: async (current: typeof session) => { seen.push({ tab: current.tab, row: current.row, filter: current.filter, projectKey: current.project?.key }); return actions.shift(); } }, {
				session,
				runCreate: async (_current: typeof session, positional?: string) => { positionals.push(positional); return outcome; },
			});
			await check(t, `${outcome.kind}: one back and one create each redisplay`, seen.length === 3, JSON.stringify(seen));
			await check(t, `${outcome.kind}: session values survive`, seen.every((value) => value.tab === "projects" && value.row === 3 && value.filter === "fix" && value.projectKey === "/repos/alpha"), JSON.stringify({ seen, session }));
			await check(t, `${outcome.kind}: positional forwarded`, positionals[0] === "./repo", JSON.stringify(positionals));
		}
	});

	test("a created sandbox exits the loop instead of reopening on the new row", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession({ row: 2, filter: "beta" });
		const seen: Array<{ tab: string; row: number; filter: string }> = [];
		let calls = 0;
		await runManagerSession({}, { next: async (current: typeof session) => {
			calls++;
			seen.push({ tab: current.tab, row: current.row, filter: current.filter });
			return calls === 1 ? { kind: "create" } as const : { kind: "close" } as const;
		} }, { session, runCreate: async () => ({ kind: "created", sandboxId: "new-sandbox" }) });
		await check(t, "the presenter is never asked to redisplay after a create", calls === 1, `calls=${calls}`);
		await check(t, "the session was presented exactly as it came in", seen.every((value) => value.row === 2 && value.filter === "beta" && value.tab === "worktrees"), JSON.stringify(seen));
	});

	test("created from a project scope returns to the caller without switching tabs", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		const session = createManagerSession({ tab: "projects", row: 3, filter: "fix", project: { key: "/repos/alpha", label: "alpha" } });
		let calls = 0;
		await runManagerSession({}, { next: async () => {
			calls++;
			return calls === 1 ? { kind: "create", positional: "/repos/alpha" } as const : { kind: "close" } as const;
		} }, { session, runCreate: async () => ({ kind: "created", sandboxId: "fresh" }) });
		await check(t, "create success from the scoped projects view exits after one presentation", calls === 1, `calls=${calls}`);
		await check(t, "the scoped session is left untouched", session.tab === "projects" && session.row === 3 && session.filter === "fix" && session.project?.key === "/repos/alpha", JSON.stringify(session));
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

	test("project scope keys on projectKey, not label substrings", async (t) => {
		const { buildManagerRows, createManagerSession, scopedManagerItems } = await import("../../worktree/manager-core.js");
		// Live bug: every searchText carries the shared library root, so a label
		// filter matched unrelated projects (chunkhound/pi-chhound, repo/repo-tools).
		const lookalike: ManagerSandboxItem = { ...items[0]!, sandboxId: "alpha-tools-1", projectKey: "/repos/alpha-tools", projectLabel: "alpha-tools", branch: "main", path: "/worktrees/alpha-tools-1/main", searchText: "/repos/alpha-tools alpha-tools main /worktrees/alpha-tools-1/main alpha" };
		const scoped = buildManagerRows(createManagerSession({ tab: "projects", project: { key: "/repos/alpha", label: "alpha" } }), [...items, lookalike]);
		await check(t, "scoped projects view lists only the project's worktree rows", scoped.length === 1 && scoped[0]?.kind === "sandbox" && scoped[0]?.sandboxId === "alpha-123", JSON.stringify(scoped));
		const textFiltered = buildManagerRows(createManagerSession({ tab: "projects", project: { key: "/repos/alpha", label: "alpha" }, filter: "feature" }), [...items, lookalike]);
		await check(t, "text filter still applies within the scope", textFiltered.length === 1 && textFiltered[0]?.sandboxId === "alpha-123", JSON.stringify(textFiltered));
		const grouped = buildManagerRows(createManagerSession({ tab: "projects" }), [...items, lookalike]);
		await check(t, "unscoped projects tab still groups sandboxes", grouped.length === 4 && grouped.every((row) => row.kind === "project"), JSON.stringify(grouped.map((row) => row.label)));
		await check(t, "without scope the lookalike stays visible", buildManagerRows(createManagerSession(), [...items, lookalike]).filter((row) => row.kind === "sandbox").length === 4, "");
		await check(t, "scope passes baselines through untouched", scopedManagerItems([...items, ...baselines], "/repos/alpha").filter((item) => item.kind === "baseline").length === 1, "");
	});

	test("sandbox details include identity, path, and optional facts", async (t) => {
		const { describeManagerItem } = await import("../../worktree/manager-core.js");
		const lines = describeManagerItem({ ...items[1]!, sizeBytes: 2048, createdAt: "2026-09-14T12:00:00Z" });
		const text = lines.join("\n");
		await check(t, "details expose the read-only sandbox facts", lines.length === 3 && text.includes("beta-pr-42 · beta · pull/42") && text.includes("/worktrees/beta-pr-42/pull-42") && text.includes("repo /repos/beta") && text.includes("indexed") && text.includes("live MCP") && text.includes("PR #42 OPEN") && text.includes("checkout 2.0 KB") && text.includes("created 2026-09-14"), text);
	});

	test("sandbox rows carry the same size breakdown as the details", async (t) => {
		const { buildManagerRows, createManagerSession, describeManagerItem } = await import("../../worktree/manager-core.js");
		const sized = { ...items[0]!, sizeBytes: 2048, dbBytes: 1024 * 1024 };
		const row = buildManagerRows(createManagerSession(), [sized]).find((value: { sandboxId?: string }) => value.sandboxId === "alpha-123");
		const details = describeManagerItem(sized).join("\n");
		const expected = "db 1.0 MB · checkout 2.0 KB · total 1.0 MB";
		await check(t, "row size cells are the shared db/checkout/total breakdown", row?.sizeCells?.db === "1.0 MB" && row?.sizeCells?.checkout === "2.0 KB" && row?.sizeCells?.total === "1.0 MB" && details.includes(expected), JSON.stringify({ row, details }));
		const unmeasured = buildManagerRows(createManagerSession(), [items[0]!]).find((value: { sandboxId?: string }) => value.sandboxId === "alpha-123");
		await check(t, "unmeasured items stay blank rather than claiming 0 B", unmeasured?.sizeCells === undefined && !describeManagerItem(items[0]!).join("\n").includes("0 B"), JSON.stringify(unmeasured));
	});

	test("baselines render on their own tab with db-only size and details", async (t) => {
		const { buildManagerRows, createManagerSession, describeManagerItem } = await import("../../worktree/manager-core.js");
		const rows = buildManagerRows(createManagerSession({ tab: "baselines" }), [...items, ...baselines]);
		await check(t, "baseline tab has no create row and only baseline rows", rows.length === 1 && rows[0]?.kind === "baseline" && rows[0]?.baselineDir === "/cache/bases/alpha/main", JSON.stringify(rows));
		await check(t, "baseline rows carry label, repo key, and a db-only size cell", rows[0]?.label === "alpha · main" && rows[0]?.projectKey === "/repos/alpha" && rows[0]?.sizeCells?.db === "7.0 MB" && rows[0]?.sizeCells?.checkout === undefined && rows[0]?.sizeCells?.total === undefined, JSON.stringify(rows[0]));
		const details = describeManagerItem(baselines[0]!).join("\n");
		await check(t, "baseline details explain the db-only nature", details.includes("alpha · main") && details.includes("/repos/alpha") && details.includes("baseline index (no checkout copy)") && details.includes("db 7.0 MB") && details.includes("commit c9698c47bb16") && details.includes("updated 2026-09-06"), details);
		const worktrees = buildManagerRows(createManagerSession(), [...items, ...baselines]);
		await check(t, "baselines never leak into the worktrees tab", worktrees.every((row) => row.kind !== "baseline"), JSON.stringify(worktrees.map((row) => row.kind)));
		const projects = buildManagerRows(createManagerSession({ tab: "projects" }), [...items, ...baselines]);
		await check(t, "baselines never join project grouping", projects.find((row) => row.label === "alpha")?.badges.includes("1 worktree") === true, JSON.stringify(projects));
	});

	test("only a created outcome invalidates loaded items", async (t) => {
		const { createManagerSession, runManagerSession } = await import("../../worktree/manager-core.js");
		for (const outcome of [{ kind: "created", sandboxId: "new-sandbox" } as const, { kind: "cancelled" } as const, { kind: "failed" } as const]) {
			const session = createManagerSession();
			let calls = 0;
			let invalidations = 0;
			await runManagerSession({}, { next: async () => {
				calls++;
				return calls === 1 ? { kind: "create" } as const : { kind: "close" } as const;
			} }, { session, runCreate: async () => outcome, onCreated: () => { invalidations++; } });
			const created = outcome.kind === "created";
			await check(t, `${outcome.kind} ${created ? "invalidates once and ends the session" : "reuses the cache and returns to the panel"}`, invalidations === (created ? 1 : 0) && calls === (created ? 1 : 2), `invalidations=${invalidations} calls=${calls}`);
		}
	});

	test("a completed load is cached and the in-flight collect is shared", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		let calls = 0;
		let resolveLoad: ((value: typeof items) => void) | undefined;
		const store = createManagerItemStore((onProgress) => {
			calls++;
			onProgress?.({ done: 0, total: 2, items: [] });
			onProgress?.({ done: 1, total: 2, items: [items[0]!] });
			return new Promise<typeof items>((resolve) => { resolveLoad = resolve; });
		});
		const streamed: number[] = [];
		const first = store.load((update) => streamed.push(update.done));
		const late: number[] = [];
		const second = store.load((update) => late.push(update.done));
		await check(t, "a rapid remount shares the in-flight collect", calls === 1 && first === second, `calls=${calls}`);
		await check(t, "a late subscriber receives the latest streamed progress", late.join(",") === "1", JSON.stringify(late));
		resolveLoad!(items);
		await check(t, "the first subscriber saw every streamed step", (await first) === items && streamed.join(",") === "0,1", JSON.stringify(streamed));
		const hit = store.load();
		await check(t, "a cache hit returns synchronously without a new collect", Array.isArray(hit) && hit === items && calls === 1, `calls=${calls}`);
	});

	test("invalidate drops the cache and expires an in-flight result", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		let calls = 0;
		const resolvers: Array<(value: typeof items) => void> = [];
		const store = createManagerItemStore(() => {
			calls++;
			return new Promise<typeof items>((resolve) => { resolvers.push(resolve); });
		});
		const stale = store.load();
		store.invalidate();
		const recollect = store.load();
		await check(t, "the next load starts a fresh collect instead of joining the expired one", calls === 2 && !Array.isArray(recollect), `calls=${calls}`);
		resolvers[0]!(items);
		await stale;
		await check(t, "the expired result is neither cached nor clobbers the fresh load", !Array.isArray(store.load()) && calls === 2, `calls=${calls}`);
		const fresh = [items[1]!];
		resolvers[1]!(fresh);
		await check(t, "the recollected result is cached", (await recollect) === fresh && calls === 2 && store.load() === fresh, `calls=${calls}`);
	});

	test("a subscriber that joined an in-flight load is released when it settles", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		const resolvers: Array<(value: typeof items) => void> = [];
		const store = createManagerItemStore((onProgress) => {
			onProgress?.({ done: 0, total: 1, items: [] });
			return new Promise<typeof items>((resolve) => { resolvers.push(resolve); });
		});
		const joined: number[] = [];
		const first = store.load();
		const shared = store.load((update) => joined.push(update.done));
		resolvers[0]!(items);
		await first;
		await shared;
		store.invalidate();
		const published: number[] = [];
		const fresh = store.load((update) => published.push(update.done));
		resolvers[1]!(items);
		await fresh;
		await check(t, "progress from the later collect never reaches the settled subscriber", joined.join(",") === "0", JSON.stringify(joined));
		await check(t, "the live subscriber still receives progress", published.join(",") === "0", JSON.stringify(published));
	});

	test("an unchanged fingerprint reuses the cached collect", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		let calls = 0;
		const store = createManagerItemStore(async () => { calls++; return items; });
		const first = store.load(undefined, "library-a");
		await check(t, "the first stamped load collects", !Array.isArray(first) && calls === 1, `calls=${calls}`);
		await first;
		const hit = store.load(undefined, "library-a");
		await check(t, "a reopen with the same fingerprint is a synchronous cache hit", Array.isArray(hit) && hit === items && calls === 1, `calls=${calls}`);
		const changed = store.load(undefined, "library-b");
		await check(t, "a changed fingerprint drops the cache and recollects", !Array.isArray(changed) && calls === 2, `calls=${calls}`);
		await changed;
		await check(t, "the recollected result is cached under the new fingerprint", Array.isArray(store.load(undefined, "library-b")) && calls === 2, `calls=${calls}`);
	});

	test("a fingerprint change while collecting expires the stale load", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		let calls = 0;
		const resolvers: Array<(value: typeof items) => void> = [];
		const store = createManagerItemStore(() => {
			calls++;
			return new Promise<typeof items>((resolve) => { resolvers.push(resolve); });
		});
		const stale = store.load(undefined, "library-a");
		const fresh = store.load(undefined, "library-b");
		await check(t, "the changed fingerprint starts a fresh collect instead of joining the stale one", calls === 2 && !Array.isArray(fresh), `calls=${calls}`);
		resolvers[0]!([items[0]!]);
		await stale;
		const freshItems = [items[1]!];
		resolvers[1]!(freshItems);
		const resolved = await fresh;
		await check(t, "the stale result is discarded and the fresh one cached", resolved === freshItems && Array.isArray(store.load(undefined, "library-b")) && calls === 2, `calls=${calls}`);
	});

	test("a failed collect is not cached and the next load retries", async (t) => {
		const { createManagerItemStore } = await import("../../worktree/manager-core.js");
		let calls = 0;
		const store = createManagerItemStore(async () => {
			calls++;
			if (calls === 1) throw new Error("collect failed");
			return items;
		});
		let message = "";
		try { await store.load(); } catch (error) { message = String(error); }
		await check(t, "the failure reaches the caller", message.includes("collect failed"), message);
		const retry = store.load();
		await check(t, "the retry starts a new collect rather than reusing the rejection", !Array.isArray(retry) && calls === 2, `calls=${calls}`);
		await check(t, "a successful retry is cached", (await retry) === items && Array.isArray(store.load()) && calls === 2, `calls=${calls}`);
	});

	test("sandbox cache keys are deterministic and every identity field moves them", async (t) => {
		const { sandboxMetaItem, managerItemCacheKey } = await import("../../worktree/manager-core.js");
		const item = await fullSandboxItem();
		const key = managerItemCacheKey(item);
		await check(t, "the builder composes identity from the entry and options",
			item.kind === "sandbox" && item.sandboxId === "alpha-123" && item.projectKey === "/repos/alpha" && item.projectLabel === "alpha" && item.branch === "feature/one" && item.path === "/worktrees/alpha-123/feature-one" && item.createdAt === "2026-09-14T12:00:00.000Z" && item.indexed && typeof item.gone === "boolean" && item.live && item.pr?.number === 7 && item.dbBytes === 1024,
			JSON.stringify(item));
		await check(t, "the same input yields the same cache key", managerItemCacheKey(sandboxMetaItem(sandboxEntry, { live: true, pr: { number: 7, state: "OPEN" } })) === key, key);
		const variants: Array<[string, typeof item]> = [
			["sandboxId", { ...item, sandboxId: "alpha-999" }],
			["projectKey", { ...item, projectKey: "/repos/other" }],
			["projectLabel", { ...item, projectLabel: "alpha-renamed" }],
			["branch", { ...item, branch: "feature/two" }],
			["path", { ...item, path: "/worktrees/alpha-999/feature-nine" }],
			["createdAt", { ...item, createdAt: "2026-01-01T00:00:00.000Z" }],
			["indexed", { ...item, indexed: !item.indexed }],
			["gone", { ...item, gone: !item.gone }],
			["live", { ...item, live: !item.live }],
			["searchText", { ...item, searchText: "unrelated search text" }],
		];
		for (const [field, variant] of variants) {
			await check(t, `${field} participates in the cache key`, managerItemCacheKey(variant) !== key, `${field}: ${managerItemCacheKey(variant)}`);
		}
	});

	test("probe results are deliberately excluded from the cache key (D10)", async (t) => {
		const { managerItemCacheKey } = await import("../../worktree/manager-core.js");
		const item = await fullSandboxItem();
		const key = managerItemCacheKey(item);
		// D10: checkout size, db size, and PR state are probe results. They refresh
		// via `r` or on a library change, not on reopen, so they MUST NOT enter the
		// session cache key. Changing one below is deliberate — do not "fix" this
		// by adding probe fields to managerItemCacheKey.
		await check(t, "D10: checkout size is not part of the key", managerItemCacheKey({ ...item, sizeBytes: 4096 }) === key, "");
		await check(t, "D10: a changed checkout size is still the same key", managerItemCacheKey({ ...item, sizeBytes: 8192 }) === managerItemCacheKey({ ...item, sizeBytes: 4096 }), "");
		await check(t, "D10: db size is not part of the key", managerItemCacheKey({ ...item, dbBytes: 1048576 }) === key, "");
		await check(t, "D10: a changed PR result is still the same key", managerItemCacheKey({ ...item, pr: { number: 99, state: "CLOSED" } }) === key, "");
		const { pr: _pr, ...withoutPr } = item;
		await check(t, "D10: gaining or losing a PR result is still the same key", managerItemCacheKey(withoutPr) === key, "");
	});

	test("baseline cache keys are deterministic and every metadata field moves them", async (t) => {
		const { baselineMetaItem, managerItemCacheKey } = await import("../../worktree/manager-core.js");
		const dir = "/cache/bases/alpha/main";
		const item = baselineMetaItem(dir, baselineMeta);
		const key = managerItemCacheKey(item);
		await check(t, "the builder composes baseline identity from dir and metadata",
			item.kind === "baseline" && item.baselineDir === dir && item.projectKey === "/repos/alpha" && item.projectLabel === "alpha" && item.ref === "main" && item.path === "/repos/alpha" && item.baseCommit === baselineMeta.baseCommit && item.chhoundVersion === baselineMeta.chhoundVersion && item.updatedAt === baselineMeta.updatedAt && item.searchText.includes("/repos/alpha") && item.searchText.includes("main") && item.searchText.includes(dir),
			JSON.stringify(item));
		await check(t, "the same input yields the same cache key", managerItemCacheKey(baselineMetaItem(dir, baselineMeta)) === key, key);
		const variants: Array<[string, typeof item]> = [
			["baselineDir", { ...item, baselineDir: "/cache/bases/alpha/develop" }],
			["ref", { ...item, ref: "develop" }],
			["updatedAt", { ...item, updatedAt: "2026-01-01T00:00:00.000Z" }],
			["baseCommit", { ...item, baseCommit: "0000000000000000000000000000000000000000" }],
			["chhoundVersion", { ...item, chhoundVersion: "chhound 9.9.9" }],
			["projectKey", { ...item, projectKey: "/repos/other" }],
			["projectLabel", { ...item, projectLabel: "other" }],
			["path", { ...item, path: "/repos/other" }],
			["searchText", { ...item, searchText: "unrelated search text" }],
		];
		for (const [field, variant] of variants) {
			await check(t, `${field} participates in the baseline cache key`, managerItemCacheKey(variant) !== key, `${field}: ${managerItemCacheKey(variant)}`);
		}
	});

	test("baseline identity falls back to the directory when repoRoot is absent or empty", async (t) => {
		const { baselineMetaItem } = await import("../../worktree/manager-core.js");
		const dir = "/cache/bases/alpha/main";
		const { repoRoot: _repoRoot, ...withoutRepoRoot } = baselineMeta;
		const cases: Array<[string, Parameters<typeof baselineMetaItem>[1]]> = [
			["absent meta", undefined],
			["empty repoRoot", { ...baselineMeta, repoRoot: "" }],
			["omitted repoRoot", withoutRepoRoot],
		];
		for (const [label, meta] of cases) {
			const item = baselineMetaItem(dir, meta);
			await check(t, `${label}: projectKey/projectLabel/path/searchText come from the dir`,
				item.projectKey === dir && item.projectLabel === "main" && item.path === dir && item.searchText.includes(dir),
				JSON.stringify(item));
		}
	});

	test("sandbox and baseline items with identical base fields have distinct cache keys", async (t) => {
		const { baselineMetaItem, managerItemCacheKey } = await import("../../worktree/manager-core.js");
		const sandbox = await fullSandboxItem();
		const baseline = baselineMetaItem("/cache/bases/alpha/main", baselineMeta);
		const twin = { ...sandbox, projectKey: baseline.projectKey, projectLabel: baseline.projectLabel, path: baseline.path, searchText: baseline.searchText };
		await check(t, "base identity fields now match exactly", twin.projectKey === baseline.projectKey && twin.projectLabel === baseline.projectLabel && twin.path === baseline.path && twin.searchText === baseline.searchText, JSON.stringify({ twin, baseline }));
		await check(t, "kind alone keeps the sandbox and baseline keys distinct", managerItemCacheKey(twin) !== managerItemCacheKey(baseline), `${managerItemCacheKey(twin)} vs ${managerItemCacheKey(baseline)}`);
	});
});
