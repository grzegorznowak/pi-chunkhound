import { describe, test } from "node:test";
import { mcpFooterStatusText, mcpToolPrefix, indexLabelFor, indexDisambigToken } from "../../mcp/manager.js";
import { mcpStatusLines, buildStatusLines } from "../../status/command.js";
import { check } from "../lib/checks.js";
import type { SandboxEntry } from "../../chhound/sandbox.js";

// Inventory: 23 checks — 7 legacy checks moved from smoke.ts section 5b (mcp
// bridge integration) — the pure text helpers over supplied values: tool-prefix
// derivation and the /ch-status mcp section + footer text (no fs, no
// registry: the connection lists are arguments, not global state) — plus 16
// rich-format, join and label checks for the mcp connections section
// (repo/branch identity, tool list suffixes, listed-tools-only usage examples,
// buildStatusLines sandbox-meta join by id with recreated-sandbox guard and
// bare-format fallback, same-name repo disambiguation tokens, indexLabelFor
// PR-head / repoRoot-absent / collision behavior). The fs-backed
// target/picker lists moved to fs/sandbox-catalog.test.ts; the live
// protocol/replay to engine/mcp-bridge.test.ts.

/** Sandbox entry builder for the pure join/identity checks below. */
function mkSandbox(over: { dir?: string; worktree?: string; repoRoot?: string; branch?: string; createdAt?: string } = {}): SandboxEntry {
	const dir = over.dir ?? "/x/sandboxes/conn-a";
	return {
		dir,
		stateDir: `${dir}.state`,
		meta: {
			version: 1,
			worktree: over.worktree ?? "/wt/conn-a",
			repoRoot: over.repoRoot ?? "/repos/chunkhound",
			branch: over.branch ?? "main",
			baseRef: "main",
			baseCommit: "0123456789abcdef",
			chhoundVersion: "test",
			createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
			copiedFrom: "/x/bases/chunkhound",
			dbPath: `${dir}.state/db`,
		},
		dbSizeBytes: 10,
	};
}

describe("mcp view", () => {
	test("legacy prefix/status/footer text obligations", async (t) => {
		const wt = "/worktrees/wt-fix"; // pure string anchor, never created
		await check(t, "mcp: tool prefix derivation", mcpToolPrefix("/home/u/wt-fix") === "chh_wt-fix", mcpToolPrefix("/home/u/wt-fix"));
		await check(t, "mcp: tool prefix override", mcpToolPrefix("/home/u/wt-fix", "mine") === "mine");

		// /ch-status mcp connections section (pure helper).
		const idleStatus = mcpStatusLines([]).join("\n");
		await check(t, "status: mcp section idle", idleStatus.includes("mcp connections (0)") && idleStatus.includes("run /ch-mcp to connect"), idleStatus);
		const liveStatus = mcpStatusLines([
			{ worktree: wt, prefix: "chh_wt-fix", toolNames: ["chh_wt-fix_search", "chh_wt-fix_fetchurl"] },
		]).join("\n");
		await check(
			t,
			"status: mcp section live",
			liveStatus.includes("mcp connections (1)") && liveStatus.includes("●") && liveStatus.includes("2 tools"),
			liveStatus,
		);

		// Rich format: with sandbox identity joined in, each connection names the
		// source repo, the callable tools (suffixes after the first full name),
		// a usage example derived from the LISTED tools, and the sandbox path.
		const richStatus = mcpStatusLines([
			{
				worktree: wt,
				prefix: "chh_wt-fix",
				toolNames: ["chh_wt-fix_search", "chh_wt-fix_code_research", "chh_wt-fix_websearch"],
				repoRoot: "/repos/chunkhound",
				branchLabel: "main",
			},
		]).join("\n");
		await check(
			t,
			"status: rich mcp line names repo, branch and tools",
			richStatus.includes("chunkhound @ main · 3 tools") && richStatus.includes("tools: chh_wt-fix_search · _code_research · _websearch"),
			richStatus,
		);
		await check(
			t,
			"status: rich mcp line shows a usage example",
			richStatus.includes('chh_wt-fix_code_research({ query: "your question" })'),
			richStatus,
		);
		await check(t, "status: rich mcp line keeps the sandbox path", richStatus.includes(wt), richStatus);
		// The example must only ever name tools the connection actually lists
		// (capability-gated servers may lack code_research entirely).
		const searchOnly = mcpStatusLines([
			{
				worktree: "/wt/conn-b",
				prefix: "chh_b",
				toolNames: ["chh_b_search", "chh_b_daemon_status"],
				repoRoot: "/repos/chunkhound",
				branchLabel: "main",
			},
		]).join("\n");
		await check(
			t,
			"status: search-only connection shows the search example",
			searchOnly.includes('chh_b_search({ type: "regex", query: "your symbol" })') && !searchOnly.includes("code_research"),
			searchOnly,
		);
		const daemonOnly = mcpStatusLines([
			{
				worktree: "/wt/conn-c",
				prefix: "chh_c",
				toolNames: ["chh_c_daemon_status"],
				repoRoot: "/repos/chunkhound",
				branchLabel: "main",
			},
		]).join("\n");
		await check(t, "status: no example when only daemon_status is listed", !daemonOnly.includes("example:"), daemonOnly);
		// Tool-list shortening only applies to real `${prefix}_<tool>` names — a
		// name that merely starts with the prefix but lacks the separator stays full.
		const oddNames = mcpStatusLines([
			{
				worktree: "/wt/conn-d",
				prefix: "chh_wt",
				toolNames: ["chh_wt_search", "chh_wtfoo_search", "other_x"],
				repoRoot: "/repos/chunkhound",
				branchLabel: "main",
			},
		]).join("\n");
		await check(
			t,
			"status: names without the prefix separator are not shortened",
			oddNames.includes("tools: chh_wt_search · chh_wtfoo_search · other_x"),
			oddNames,
		);
		// buildStatusLines joins live connections to sandbox meta (enrichment) and
		// falls back to the bare format for connections without a matching sandbox.
		const joined = buildStatusLines({
			version: "test",
			settings: { version: 1, sandboxRoot: "/x/sandboxes", baseRoot: "/x/bases" },
			sandboxes: [
				{
					dir: "/x/sandboxes/conn-a",
					stateDir: "/x/sandboxes/conn-a.state",
					meta: {
						version: 1,
						worktree: "/wt/conn-a",
						repoRoot: "/repos/chunkhound",
						branch: "main",
						baseRef: "main",
						baseCommit: "0123456789abcdef",
						chhoundVersion: "test",
						createdAt: "2026-01-01T00:00:00.000Z",
						copiedFrom: "/x/bases/chunkhound",
						dbPath: "/x/sandboxes/conn-a.state/db",
					},
					dbSizeBytes: 10,
				},
			],
			baselines: [],
			conns: [
				{ worktree: "/wt/conn-a", prefix: "chh_a", toolNames: ["chh_a_search", "chh_a_code_research"] },
				{ worktree: "/wt/gone", prefix: "chh_g", toolNames: ["chh_g_search"] },
			],
		}).join("\n");
		await check(
			t,
			"status: buildStatusLines joins connections to sandbox meta",
			joined.includes("mcp connections (2)") && joined.includes("chunkhound @ main · 2 tools"),
			joined,
		);
		await check(t, "status: unmatched connection keeps the bare format", joined.includes("● gone · prefix chh_g · 1 tools"), joined);
		// Join hardening (review #1): real connections carry the immutable sandbox
		// id and join on it; a sandbox recreated AFTER the connection started must
		// never lend its identity to the stale connection (bare format instead).
		const idJoined = buildStatusLines({
			version: "test",
			settings: { version: 1, sandboxRoot: "/x/sandboxes", baseRoot: "/x/bases" },
			sandboxes: [mkSandbox()],
			baselines: [],
			conns: [{ id: "conn-a", worktree: "/wt/conn-a", prefix: "chh_a", toolNames: ["chh_a_search"] }],
		}).join("\n");
		await check(t, "status: connection joins on the sandbox id", idJoined.includes("chunkhound @ main · 1 tools"), idJoined);
		const staleJoin = buildStatusLines({
			version: "test",
			settings: { version: 1, sandboxRoot: "/x/sandboxes", baseRoot: "/x/bases" },
			sandboxes: [mkSandbox({ createdAt: "2026-01-03T00:00:00.000Z" })],
			baselines: [],
			conns: [
				{
					id: "conn-a",
					worktree: "/wt/conn-a",
					prefix: "chh_a",
					toolNames: ["chh_a_search"],
					connectedAt: "2026-01-02T00:00:00.000Z",
				},
			],
		}).join("\n");
		await check(
			t,
			"status: recreated sandbox never labels the stale connection",
			!staleJoin.includes("chunkhound @ main") && staleJoin.includes("● conn-a · prefix chh_a · 1 tools"),
			staleJoin,
		);
		// Two live connections whose repos share a folder name (fork + upstream)
		// both get the identity token in their header row (review #2, status side).
		const t1 = indexDisambigToken("/repos/chunkhound", "main");
		const t2 = indexDisambigToken("/work/fork/chunkhound", "main");
		const twinJoined = buildStatusLines({
			version: "test",
			settings: { version: 1, sandboxRoot: "/x/sandboxes", baseRoot: "/x/bases" },
			sandboxes: [mkSandbox(), mkSandbox({ dir: "/x/sandboxes/conn-b", worktree: "/wt/conn-b", repoRoot: "/work/fork/chunkhound" })],
			baselines: [],
			conns: [
				{ id: "conn-a", worktree: "/wt/conn-a", prefix: "chh_a", toolNames: ["chh_a_search"] },
				{ id: "conn-b", worktree: "/wt/conn-b", prefix: "chh_b", toolNames: ["chh_b_search"] },
			],
		}).join("\n");
		await check(
			t,
			"status: same-named repos get distinguishable header rows",
			twinJoined.includes(`chunkhound·${t1} @ main · 1 tools`) && twinJoined.includes(`chunkhound·${t2} @ main · 1 tools`),
			twinJoined,
		);
		// Label derivation (reviews #2, #4, #5): plain label, PR-head context,
		// repoRoot-absent fallback, and collision disambiguation with the token.
		await check(t, "label: plain repo label", indexLabelFor({ repoRoot: "/repos/chunkhound", branch: "main" }, "/x/sb/conn-a", []) === "chunkhound @ main", indexLabelFor({ repoRoot: "/repos/chunkhound", branch: "main" }, "/x/sb/conn-a", []));
		await check(
			t,
			"label: PR-head sandbox label carries head context",
			indexLabelFor(
				{ repoRoot: "/repos/chunkhound", branch: "add/pull/29", headRef: "recovery/pr27-pr-b", headOid: "0c645ce123456789abcdef0123456789abcdef" },
				"/x/sb/conn-a",
				[],
			) === "chunkhound @ add/pull/29 · head recovery/pr27-pr-b @ 0c645ce1",
			indexLabelFor({ repoRoot: "/repos/chunkhound", branch: "add/pull/29", headRef: "recovery/pr27-pr-b", headOid: "0c645ce123456789abcdef0123456789abcdef" }, "/x/sb/conn-a", []),
		);
		await check(
			t,
			"label: repoRoot-absent fallback uses the sandbox dir name",
			indexLabelFor({ branch: "main" }, "/x/sb/chunkhound-abc12345", []) === "chunkhound-abc12345 @ main",
			indexLabelFor({ branch: "main" }, "/x/sb/chunkhound-abc12345", []),
		);
		const collided = indexLabelFor({ repoRoot: "/work/fork/chunkhound", branch: "main" }, "/x/sb/conn-b", ["chunkhound @ main"]);
		await check(
			t,
			"label: same-named repo gets the disambiguating token",
			collided === `chunkhound·${indexDisambigToken("/work/fork/chunkhound", "main")} @ main`,
			collided,
		);
		await check(
			t,
			"label: no token when the label is unique",
			indexLabelFor({ repoRoot: "/work/fork/chunkhound", branch: "main" }, "/x/sb/conn-b", ["other @ main"]) === "chunkhound @ main",
			indexLabelFor({ repoRoot: "/work/fork/chunkhound", branch: "main" }, "/x/sb/conn-b", ["other @ main"]),
		);

		// Footer indicator text (pure helper — mirrors the mcp section above).
		await check(t, "footer: hidden when nothing connected", mcpFooterStatusText([]) === undefined);
		await check(t, "footer: single connection", mcpFooterStatusText([{ id: "sb-1" }]) === "🔌 ch-mcp: 1 connected");
		await check(
			t,
			"footer: multiple connections",
			mcpFooterStatusText([{ id: "sb-1" }, { id: "sb-2" }]) === "🔌 ch-mcp: 2 connected",
		);
	});
});
