import { describe, test } from "node:test";
import { mcpFooterStatusText, mcpToolPrefix } from "../../../mcp/manager.js";
import { mcpStatusLines } from "../../../status/command.js";
import { check } from "../lib/checks.js";

// Inventory: 7 legacy checks moved from smoke.ts section 5b (mcp bridge
// integration) — the pure text helpers over supplied values: tool-prefix
// derivation and the /ch-status mcp section + footer text (no fs, no
// registry: the connection lists are arguments, not global state). The
// fs-backed target/picker lists moved to fs/sandbox-catalog.test.ts; the live
// protocol/replay to engine/mcp-bridge.test.ts.

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
