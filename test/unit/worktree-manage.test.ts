import { describe, test } from "node:test";
import path from "node:path";
import {
	LS_VERBS,
	RM_VERBS,
	LIST_SORT_KEYS,
	buildWorktreeListLines,
	displayWorktreePath,
	entryBadges,
	groupListInfos,
	lifeMarker,
	parseListInvocation,
	searchTextOf,
	worktreeVerb,
} from "../../worktree/manage.js";
import type { WtListInfo, WtGitState } from "../../worktree/manage.js";
import type { SandboxEntry } from "../../chhound/sandbox.js";
import { check } from "../lib/checks.js";

// Inventory: manager list-model checks — verb dispatch predicates, ls
// argument validation, the pure grouping/filter/sort stage, the row badge
// composition and the full renderer (all headless, no fs, no git: rows are
// fabricated). The fs-backed collectors (real git probes, async sizing,
// gh-free pull-slot handling) live in fs/worktree-manage.test.ts.

const ROOT = "/x/sandboxes";

function mkSandbox(over: {
	dir?: string;
	worktree?: string;
	repoRoot?: string;
	branch?: string;
	headRef?: string;
	headOid?: string;
	createdAt?: string;
	baseRef?: string;
	dbSizeBytes?: number;
	claimedRoot?: string | null;
} = {}): SandboxEntry {
	const dir = over.dir ?? path.join(ROOT, "sb-aaa11111");
	return {
		dir,
		stateDir: path.join(path.dirname(dir), ".state", path.basename(dir)),
		meta: {
			version: 1,
			worktree: over.worktree ?? path.join(dir, "fix"),
			repoRoot: over.repoRoot ?? "/repos/chunkhound",
			branch: over.branch ?? "fix",
			baseRef: over.baseRef ?? "main",
			baseCommit: "0123456789abcdef0123456789abcdef01234567",
			chhoundVersion: "test",
			createdAt: over.createdAt ?? "2026-01-02T00:00:00.000Z",
			copiedFrom: "/x/bases/chunkhound",
			dbPath: path.join(path.dirname(dir), ".state", path.basename(dir), "db"),
			...(over.headRef ? { headRef: over.headRef } : {}),
			...(over.headOid ? { headOid: over.headOid } : {}),
		},
		dbSizeBytes: over.dbSizeBytes ?? 1024,
		...(over.claimedRoot === null ? {} : { claimedRoot: over.claimedRoot ?? dir }),
	};
}

function mkInfo(over: {
	entry?: SandboxEntry;
	checkoutBytes?: number;
	gone?: boolean;
	git?: WtGitState | null;
	liveMcpPrefix?: string;
	recordedConnected?: boolean;
	runsThisExtension?: boolean;
	pr?: WtListInfo["pr"];
} = {}): WtListInfo {
	const entry = over.entry ?? mkSandbox();
	const defaultGit: WtGitState = {
		dirty: false,
		ahead: 0,
		behind: 0,
		branch: entry.meta.branch ?? undefined,
		headOid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
		lastCommit: "2026-09-01T10:00:00Z",
	};
	return {
		entry,
		checkoutBytes: over.checkoutBytes ?? 2048,
		gone: over.gone ?? false,
		...(over.git === undefined ? { git: defaultGit } : over.git === null ? {} : { git: over.git }),
		liveMcpPrefix: over.liveMcpPrefix,
		recordedConnected: over.recordedConnected ?? false,
		runsThisExtension: over.runsThisExtension ?? false,
		pr: over.pr,
	};
}

const cleanGit = (over: Partial<WtGitState> = {}): WtGitState => ({
	dirty: false,
	ahead: 0,
	behind: 0,
	headOid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
	...(over.lastCommit === undefined ? { lastCommit: "2026-09-01T10:00:00Z" } : {}),
	...over,
});

describe("worktree manager verbs + ls args", () => {
	test("verb dispatch from the first positional", async (t) => {
		for (const v of LS_VERBS) {
			await check(t, `ls verb: ${v}`, worktreeVerb(v) === "list", String(worktreeVerb(v)));
		}
		for (const v of RM_VERBS) {
			await check(t, `rm verb: ${v}`, worktreeVerb(v) === "remove", String(worktreeVerb(v)));
		}
		// Everything else stays a creation invocation.
		await check(t, "no positional is no verb", worktreeVerb(undefined) === undefined);
		for (const not of ["main", "feature/x", "chunkhound", "https://github.com/o/r/pull/3", "./somewhere", "pull/3"]) {
			await check(t, `not a verb: ${not}`, worktreeVerb(not) === undefined);
		}
	});

	test("ls argument validation", async (t) => {
		const ok = (args: { p?: string[]; f?: Record<string, string | true> }) => parseListInvocation(args.p ?? [], args.f ?? {});
		// defaults
		let r = ok({});
		await check(t, "defaults: no search, created sort", r.ok && r.options.search === "" && r.options.sort === "created", JSON.stringify(r));
		// query positional + explicit flag forms
		r = ok({ p: ["fix"] });
		await check(t, "positional query", r.ok && r.options.search === "fix", JSON.stringify(r));
		r = ok({ f: { search: " mcp " } });
		await check(t, "search flag trimmed", r.ok && r.options.search === "mcp", JSON.stringify(r));
		r = ok({ p: ["ignored?"], f: { search: "mcp" } });
		await check(t, "search flag wins over positional", r.ok && r.options.search === "mcp", JSON.stringify(r));
		r = ok({ p: ["fix"], f: { sort: "db" } });
		await check(t, "query + sort", r.ok && r.options.search === "fix" && r.options.sort === "db", JSON.stringify(r));
		for (const key of LIST_SORT_KEYS) {
			const x = ok({ f: { sort: key } });
			await check(t, `sort key accepted: ${key}`, x.ok && x.options.sort === key, JSON.stringify(x));
		}
		// rejections
		for (const f of ["b", "config", "dest", "from", "no-index", "force-reindex", "refresh-baseline"]) {
			const x = ok({ f: { [f]: true } });
			await check(t, `creation flag rejected on ls: --${f}`, !x.ok && !x.ok && x.ok === false && x.error.includes(f), JSON.stringify(x));
		}
		const extra = ok({ p: ["a", "b"] });
		await check(t, "two positionals rejected", !extra.ok && extra.ok === false && extra.error.includes("at most one"), JSON.stringify(extra));
		const bareSort = ok({ f: { sort: true } });
		await check(t, "bare --sort rejected", !bareSort.ok && bareSort.ok === false && bareSort.error.includes("needs a key"), JSON.stringify(bareSort));
		const bareSearch = ok({ f: { search: true } });
		await check(t, "bare --search rejected", !bareSearch.ok && bareSearch.ok === false && bareSearch.error.includes("needs text"), JSON.stringify(bareSearch));
		const badSort = ok({ f: { sort: "size" } });
		await check(t, "unknown sort key rejected w/ key list", !badSort.ok && badSort.ok === false && badSort.error.includes("created") && badSort.error.includes("name"), JSON.stringify(badSort));
		const unknown = ok({ f: { xyz: true } });
		await check(t, "unknown flag rejected", !unknown.ok && unknown.ok === false && unknown.error.includes("xyz"), JSON.stringify(unknown));
	});
});

describe("row model: git-state/liveness badges", () => {
	test("entryBadges composition", async (t) => {
		const badges = (i: WtListInfo): string => entryBadges(i).join(" · ");
		// A calm on-branch row: identity is the branch, nothing to say but the
		// last-commit date.
		await check(t, "calm row shows only last commit", badges(mkInfo()) === "last commit 2026-09-01", badges(mkInfo()));
		await check(t, "gone rows: single ✗ gone badge", badges(mkInfo({ gone: true })) === "✗ gone", badges(mkInfo({ gone: true })));
		// git-state badges
		await check(t, "dirty badge", badges(mkInfo({ git: cleanGit({ dirty: true }) })).includes("dirty"));
		await check(t, "checkout moved to another branch", badges(mkInfo({ entry: mkSandbox({ branch: "fix" }), git: cleanGit({ branch: "main" }) })).includes("on main"));
		const detached = mkInfo({ entry: mkSandbox({ branch: "fix" }), git: cleanGit({ branch: undefined }) });
		await check(t, "unexpected detached shows the head", badges(detached).includes("detached @ a1b2c3d4"), badges(detached));
		// Detached BY DESIGN: pull/N slots and <remote>/<branch> slots get no
		// detached badge (their identity already says detached).
		const prSlot = mkInfo({ entry: mkSandbox({ branch: "pull/7", headRef: "fix/x" }), git: cleanGit({ branch: undefined }) });
		await check(t, "pull/N detached is by design", !badges(prSlot).includes("detached"));
		const remoteSlot = mkInfo({ entry: mkSandbox({ branch: "origin/x" }), git: cleanGit({ branch: undefined }) });
		await check(t, "remote-ref detached is by design", !badges(remoteSlot).includes("detached"));
		// ahead/behind vs the comparison ref — only when nonzero.
		const ab = mkInfo({ git: cleanGit({ branch: "fix", ahead: 2, behind: 1, vsRef: "origin/fix" }) });
		await check(t, "ahead/behind badge names the ref", badges(ab).includes("+2/-1 vs origin/fix"), badges(ab));
		const zero = mkInfo({ git: cleanGit({ branch: "fix", ahead: 0, behind: 0, vsRef: "main" }) });
		await check(t, "0/0 shows no count badge", !badges(zero).includes("vs main"));
		// PR outcome badge (gh) — draft renders as DRAFT when OPEN.
		await check(t, "PR open", badges(mkInfo({ pr: { number: 7, state: "OPEN", draft: false } })).includes("PR #7 OPEN"));
		await check(t, "PR draft", badges(mkInfo({ pr: { number: 7, state: "OPEN", draft: true } })).includes("PR #7 DRAFT"));
		await check(t, "PR merged", badges(mkInfo({ pr: { number: 7, state: "MERGED", draft: false } })).includes("PR #7 MERGED"));
		await check(t, "PR closed", badges(mkInfo({ pr: { number: 7, state: "CLOSED", draft: false } })).includes("PR #7 CLOSED"));
		// liveness / extension / claim badges
		await check(t, "extension-source row", badges(mkInfo({ runsThisExtension: true })).includes("runs this extension"));
		const unclaimed = mkInfo({ entry: mkSandbox({ claimedRoot: null }) });
		await check(t, "unclaimed index badge", badges(unclaimed).includes("unclaimed index"));
		const mismatch = mkInfo({ entry: mkSandbox({ claimedRoot: "/somewhere/else" }) });
		await check(t, "claim mismatch badge", badges(mismatch).includes("index root mismatch"), badges(mismatch));
	});

	test("lifeMarker (liveness column)", async (t) => {
		await check(t, "live MCP connection", lifeMarker(mkInfo({ liveMcpPrefix: "chh_x" })) === "●");
		await check(t, "recorded-only (reconnect pending)", lifeMarker(mkInfo({ recordedConnected: true })) === "↻");
		await check(t, "live beats recorded", lifeMarker(mkInfo({ liveMcpPrefix: "chh_x", recordedConnected: true })) === "●");
		await check(t, "idle", lifeMarker(mkInfo()) === "·");
	});

	test("searchTextOf covers repo/branch/head/paths/git branch", async (t) => {
		const info = mkInfo({
			entry: mkSandbox({ dir: "/x/sandboxes/ch-abc12345", worktree: "/x/sandboxes/ch-abc12345/fix", repoRoot: "/repos/MyRepo", branch: "pull/7", headRef: "FixIt", headOid: "deadbeef" }),
			git: cleanGit({ branch: "fix" }),
		});
		const s = searchTextOf(info);
		await check(t, "repo basename", s.includes("myrepo"));
		await check(t, "repo full path", s.includes("/repos/myrepo"));
		await check(t, "branch + head ref", s.includes("pull/7") && s.includes("fixit"));
		await check(t, "id + worktree path", s.includes("ch-abc12345") && s.includes("fix"));
		await check(t, "git branch", s.includes("fix"));
	});
});

describe("grouping / filter / sort", () => {
	const repoA = "/repos/alpha";
	const repoB = "/repos/beta";
	const fork = "/work/fork/alpha";
	const mk = (over: { repoRoot?: string; branch?: string; createdAt?: string; db?: number; co?: number; dir?: string }): WtListInfo =>
		mkInfo({
			entry: mkSandbox({
				dir: over.dir ?? `/x/sandboxes/sb-${over.branch?.replace(/\W/g, "") ?? "x"}-00000000`,
				worktree: `/x/sandboxes/wt-${over.branch ?? "x"}`,
				repoRoot: over.repoRoot ?? repoA,
				branch: over.branch ?? "main",
				createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
				dbSizeBytes: over.db ?? 1000,
			}),
			checkoutBytes: over.co ?? 2000,
		});

	test("groups by project, orders by created desc (default)", async (t) => {
		const rows = [
			mk({ branch: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
			mk({ branch: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
			mk({ repoRoot: repoB, branch: "b1", createdAt: "2026-02-01T00:00:00.000Z" }),
		];
		const { groups } = groupListInfos(rows, {});
		await check(t, "two groups", groups.length === 2, JSON.stringify(groups.map((g) => g.label)));
		// group order: newest entry first → alpha (new 03-01) before beta (02-01)
		await check(t, "groups ordered by newest row", groups[0]!.key === repoA && groups[1]!.key === repoB, JSON.stringify(groups.map((g) => g.label)));
		// within alpha: new before old
		await check(t, "rows ordered by created desc", groups[0]!.infos[0]!.entry.meta.branch === "new" && groups[0]!.infos[1]!.entry.meta.branch === "old");
		// rollup-visible labels carry the project basename
		await check(t, "labels are repo basenames", groups[0]!.label === "alpha" && groups[1]!.label === "beta");
	});

	test("name sort: A→Z by identity, groups by label", async (t) => {
		const rows = [
			mk({ branch: "zeta", createdAt: "2026-03-01T00:00:00.000Z" }),
			mk({ branch: "alpha", createdAt: "2026-01-01T00:00:00.000Z" }),
			mk({ repoRoot: repoB, branch: "b1", createdAt: "2026-02-01T00:00:00.000Z" }),
		];
		const { groups } = groupListInfos(rows, { sort: "name" });
		await check(t, "groups by label asc", groups[0]!.label === "alpha" && groups[1]!.label === "beta");
		await check(t, "rows by identity asc", groups[0]!.infos.map((i) => i.entry.meta.branch).join(",") === "alpha,zeta");
	});

	test("numeric sorts: db / checkout / total, largest first", async (t) => {
		const rows = [
			mk({ branch: "small", db: 100, co: 100 }),
			mk({ branch: "big", db: 9000, co: 1000 }),
			mk({ repoRoot: repoB, branch: "b1", db: 500, co: 500 }),
		];
		const byDb = groupListInfos(rows, { sort: "db" });
		await check(t, "db sort: biggest group first", byDb.groups[0]!.key === repoA, JSON.stringify(byDb.groups.map((g) => g.label)));
		await check(t, "db sort: biggest row first", byDb.groups[0]!.infos[0]!.entry.meta.branch === "big");
		const byTotal = groupListInfos(rows, { sort: "total" });
		await check(t, "total sort uses db+checkout", byTotal.groups[0]!.infos[0]!.entry.meta.branch === "big");
		const byCo = groupListInfos(rows, { sort: "checkout" });
		await check(t, "checkout sort", byCo.groups[0]!.infos[0]!.entry.meta.branch === "big");
	});

	test("search filter is case-insensitive over the row haystack", async (t) => {
		const rows = [
			mk({ repoRoot: repoA, branch: "fix/mcp", dir: "/x/sandboxes/sb-fixmcp-11111111" }),
			mk({ repoRoot: repoB, branch: "other" }),
			mk({ repoRoot: "/work/alphafork", branch: "x" }),
		];
		const byBranch = groupListInfos(rows, { search: "MCP" });
		await check(t, "branch substring (case-insensitive)", byBranch.groups.length === 1 && byBranch.groups[0]!.infos.length === 1);
		const byRepo = groupListInfos(rows, { search: "beta" });
		await check(t, "repo basename", byRepo.groups.length === 1 && byRepo.groups[0]!.key === repoB);
		const byPath = groupListInfos(rows, { search: "alphafork" });
		await check(t, "repo path segment", byPath.groups.length === 1 && byPath.groups[0]!.key === "/work/alphafork");
		const none = groupListInfos(rows, { search: "zzz" });
		await check(t, "no match", none.groups.length === 0);
		// Substring semantics over the full haystack: "alpha" matches repoA's
		// basename AND the /work/alphafork path — both groups surface.
		const alpha = groupListInfos(rows, { search: "alpha" });
		await check(
			t,
			"'alpha' matches repo + alphafork path",
			alpha.groups.length === 2 && alpha.groups.some((g) => g.key === repoA) && alpha.groups.some((g) => g.key === "/work/alphafork"),
			JSON.stringify(alpha.groups.map((g) => g.key)),
		);
	});

	test("unknown-project grouping + duplicate-basename labels", async (t) => {
		const rows = [
			mk({ repoRoot: repoA }),
			mk({ repoRoot: fork, branch: "forked" }),
			mkInfo({
				entry: mkSandbox({ repoRoot: "", branch: "orphan", dir: "/x/sandboxes/sb-orphan-00000000" }),
			}),
		];
		const { groups } = groupListInfos(rows, {});
		await check(t, "three groups incl. unknown project", groups.length === 3, JSON.stringify(groups.map((g) => g.label)));
		const unknown = groups.find((g) => g.key === "");
		await check(t, "no-repoRoot rows group under (unknown project)", unknown !== undefined && unknown!.label === "(unknown project)");
		const alphaLabels = groups.map((g) => g.label).filter((l) => l.startsWith("alpha")).sort();
		await check(
			t,
			"same-basename groups get a token",
			alphaLabels.length === 2 && alphaLabels[0] !== "alpha" && alphaLabels[1] !== "alpha" && alphaLabels[0] !== alphaLabels[1],
			groups.map((g) => g.label).join("|"),
		);
	});

	test("deterministic ties (same createdAt → storage id asc)", async (t) => {
		const rows = [
			mk({ branch: "b2", createdAt: "2026-01-01T00:00:00.000Z", dir: "/x/sandboxes/sb-b2-00000002" }),
			mk({ branch: "b1", createdAt: "2026-01-01T00:00:00.000Z", dir: "/x/sandboxes/sb-b1-00000001" }),
		];
		const { groups } = groupListInfos(rows, {});
		await check(t, "tie broken by id asc", groups[0]!.infos[0]!.entry.meta.branch === "b1", groups[0]!.infos.map((i) => i.entry.meta.branch).join(","));
	});
});

describe("renderer", () => {
	const render = (rows: WtListInfo[], opts: { search?: string; ghFailed?: number; ghAttempted?: number; total?: number } = {}): string[] =>
		buildWorktreeListLines({
			libraryRoot: ROOT,
			groups: groupListInfos(rows, { search: opts.search }).groups,
			total: opts.total ?? rows.length,
			search: opts.search,
			ghFailed: opts.ghFailed ?? 0,
			ghAttempted: opts.ghAttempted ?? 0,
		});

	test("header, group rollups and db-first size columns", async (t) => {
		const rows = [
			mkInfo({ entry: mkSandbox({ dir: "/x/sandboxes/sb-a-11111111", worktree: "/x/sandboxes/sb-a-11111111/fix", repoRoot: "/repos/chunkhound", branch: "fix" }) }),
		];
		const lines = render(rows);
		const text = lines.join("\n");
		await check(t, "header counts", lines[0]!.includes("1 sandbox in 1 project") && lines[0]!.includes(ROOT), lines[0]);
		await check(t, "group header", lines.some((l) => l.startsWith("chunkhound (1)")), text);
		const sizes = text.split("\n").find((l) => l.includes("created 2026-01-02"));
		await check(
			t,
			"row line carries db · checkout · total · created · wt",
			sizes !== undefined && sizes.includes("db 1.0 KB") && sizes.includes("checkout 2.0 KB") && sizes.includes("total 3.0 KB") && sizes.includes("created 2026-01-02") && sizes.includes("wt sb-a-11111111/fix"),
			text,
		);
		// db-first order: the db column precedes checkout in the line
		const dbAt = sizes!.indexOf("db ");
		const coAt = sizes!.indexOf("checkout ");
		const totAt = sizes!.indexOf("total ");
		await check(t, "db column comes first", dbAt >= 0 && dbAt < coAt && coAt < totAt, sizes);
		await check(t, "identity line", lines.some((l) => l.includes("· fix")), text);
	});

	test("life markers, badges and gh note", async (t) => {
		const rows = [
			mkInfo({ liveMcpPrefix: "chh_x", pr: { number: 3, state: "OPEN", draft: false } }),
			mkInfo({ recordedConnected: true, entry: mkSandbox({ branch: "other", dir: "/x/sandboxes/sb-b-22222222" }) }),
			mkInfo({ gone: true, entry: mkSandbox({ branch: "gone", dir: "/x/sandboxes/sb-c-33333333" }) }),
		];
		const text = render(rows, { ghFailed: 1, ghAttempted: 2 }).join("\n");
		await check(t, "live row ● with PR badge", text.includes("● fix") && text.includes("PR #3 OPEN"), text);
		await check(t, "recorded row ↻", text.includes("↻ other"));
		await check(t, "gone row ✗", text.includes("✗ gone"));
		await check(t, "gh failure note", text.includes("gh PR lookup failed for 1 of 2 pull sandboxes"));
	});

	test("empty library and no-match search", async (t) => {
		const empty = buildWorktreeListLines({ libraryRoot: ROOT, groups: [], total: 0, ghFailed: 0, ghAttempted: 0 }).join("\n");
		await check(t, "empty library hint", empty.includes("0 sandboxes") && empty.includes("creates the first"), empty);
		const filtered = render([mkInfo()], { search: "zzz" }).join("\n");
		await check(t, "no-match hint", filtered.includes("no worktree matches") && filtered.includes("zzz"), filtered);
		const partial = render([mkInfo()], { search: "fix", total: 3 }).join("\n");
		await check(t, "showing N of M", partial.includes("showing 1 of 3 matching"), partial);
	});

	test("worktree path display: relative under the library root, absolute outside", async (t) => {
		await check(t, "inside root → relative", displayWorktreePath("/x/sandboxes", "/x/sandboxes/sb-a/fix") === "sb-a/fix");
		await check(t, "outside root → absolute", displayWorktreePath("/x/sandboxes", "/elsewhere/wt") === "/elsewhere/wt");
		await check(t, "empty path", displayWorktreePath("/x/sandboxes", "") === "");
	});
});
