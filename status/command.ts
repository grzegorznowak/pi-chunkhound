import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listBaselines } from "../chhound/baseline.js";
import { chhoundBinary, chhoundVersion } from "../chhound/cli.js";
import { parseArgs } from "../chhound/args.js";
import { gitRootOrNull } from "../chhound/git.js";
import { baseRoot, sandboxRoot } from "../chhound/paths.js";
import { fmtSize, listSandboxes, pruneSandboxes, claimedRootMatches } from "../chhound/sandbox.js";
import { listMcpConnections } from "../mcp/manager.js";
import { loadSettings } from "../chhound/settings.js";
import type { PluginState } from "../chhound/types.js";

/** MCP connection section for /ch-status (pure — smoke-tested headless). */
export function mcpStatusLines(conns: readonly { worktree: string; prefix: string; toolNames: string[] }[]): string[] {
	const lines = ["", `mcp connections (${conns.length}):`];
	if (conns.length === 0) {
		lines.push("  (none — run /ch-mcp to connect)");
	} else {
		for (const c of conns) {
			lines.push(`  ● ${c.worktree} · prefix ${c.prefix} · ${c.toolNames.length} tools`);
		}
	}
	return lines;
}

export function registerStatusCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("ch-status", {
		description:
			"List pi-chhound sandboxes and baselines (index library). " +
			"Usage: /ch-status [--prune] (--prune removes sandboxes whose worktree is gone)",
		handler: async (args, ctx) => {
			const { flags } = parseArgs(args);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const loaded = loadSettings(repoRoot ?? ctx.cwd);
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");
			const settings = loaded.settings;

			if (flags["prune"] === true) {
				const removed = pruneSandboxes(settings);
				ctx.ui.notify(
					removed.length > 0
						? `Pruned ${removed.length} sandbox(es):\n${removed.join("\n")}`
						: "Nothing to prune — all sandboxes have a live worktree.",
					"info",
				);
			}

			const version = await chhoundVersion();
			const sandboxes = listSandboxes(settings);
			const baselines = listBaselines(settings);

			const lines: string[] = [
				`chunkhound: ${version.replace(/^chunkhound\s+/, "")} (${chhoundBinary()})`,
				`sandbox root: ${sandboxRoot(settings)}`,
				`baseline root: ${baseRoot(settings)}`,
				`worktree base: ${settings.worktreeBase ?? "— (worktrees default to the repo's parent)"}`,
				`embedding: ${settings.embedding?.provider && settings.embedding?.model
					? `${settings.embedding.provider}/${settings.embedding.model}${settings.embedding.outputDims ? ` · dims ${settings.embedding.outputDims}` : ""}`
					: "not configured — run /ch-setup"}`,
				`llm: ${settings.llm?.provider ? `${settings.llm.provider}/${settings.llm.model ?? "default"}` : "not configured — research tools need it (/ch-setup)"}`,
				`api key: ${settings.embedding?.apiKey ? "stored in settings ✓" : process.env.CHUNKHOUND_EMBEDDING__API_KEY ? "env ✓" : "not set (env or /ch-setup)"}`,
				"",
				`sandboxes (${sandboxes.length}):`,
			];
			if (sandboxes.length === 0) {
				lines.push("  (none — run /chworktree <path>)");
			} else {
				for (const s of sandboxes) {
					const alive = fs.existsSync(s.meta.worktree) ? "✓" : "✗ gone";
					let rootTxt: string;
					if (!s.claimedRoot) {
						rootTxt = "root unclaimed — run chunkhound index from the worktree";
					} else if (claimedRootMatches(s.claimedRoot, s.meta.worktree)) {
						rootTxt = `root ${s.claimedRoot}`;
					} else {
						rootTxt = `⚠ root ${s.claimedRoot} ≠ worktree — run chunkhound index/mcp from ${s.claimedRoot}`;
					}
					lines.push(
						`  ${alive} ${path.basename(s.dir)} → ${s.meta.worktree}`,
						`      ${s.meta.branch} @ base ${s.meta.baseCommit.slice(0, 8)} · db ${fmtSize(s.dbSizeBytes)} · ${s.meta.createdAt.slice(0, 10)} · ${rootTxt}`,
					);
				}
			}
			lines.push("", `baselines (${baselines.length}):`);
			if (baselines.length === 0) {
				lines.push("  (none — created on first /chworktree)");
			} else {
				for (const b of baselines) {
					const meta = b.meta;
					lines.push(
						meta
							? `  ${path.basename(b.dir)} @ ${meta.baseCommit.slice(0, 8)} · ${meta.chhoundVersion} · updated ${meta.updatedAt.slice(0, 10)}`
							: `  ${path.basename(b.dir)} (no meta — incomplete)`,
					);
				}
			}
			lines.push(...mcpStatusLines(listMcpConnections()));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
