import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { gitRootOrNull } from "../chhound/git.js";
import { expandHome } from "../chhound/completions.js";
import { MCP_VALUE_FLAGS } from "../chhound/args.js";
import { listSandboxes, fmtSize, sandboxBranchLabel } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";
import { connectMcp, disconnectMcp, listMcpConnections } from "./manager.js";
import type { McpConnection } from "./manager.js";
import { recordConnection } from "./persist.js";

/**
 * No-argument view: every sandbox is a connectable target, marked when a
 * connection is already live. Shown when the interactive picker is
 * unavailable (non-TUI contexts). Pure — smoke-tested headless.
 */
export function mcpTargetLines(
	settings: ChhoundSettings,
	conns: readonly { id: string; prefix: string; toolNames: string[] }[],
): string[] {
	const sandboxes = listSandboxes(settings);
	const lines = ["chhound MCP — available targets:"];
	if (sandboxes.length === 0) {
		lines.push("  (no worktrees — run /chworktree <path> first)");
	} else {
		for (const s of sandboxes) {
			const id = path.basename(s.dir);
			const conn = conns.find((c) => c.id === id);
			lines.push(
				`  ${conn ? "●" : "·"} ${s.meta.worktree}${conn ? "  (connected)" : ""}`,
				`      ${id} · ${sandboxBranchLabel(s.meta)} @ base commit ${s.meta.baseCommit.slice(0, 8)} · index ${fmtSize(s.dbSizeBytes)}${conn ? ` · prefix ${conn.prefix} · ${conn.toolNames.length} tools` : ""}`,
			);
		}
	}
	lines.push("connect: /ch-mcp <worktree path/name or storage ID>");
	if (conns.length > 0) lines.push("disconnect: /ch-mcp <worktree or storage ID> --disconnect");
	return lines;
}

/** One select-dialog option per sandbox, in listSandboxes order. */
export function mcpSelectOptions(settings: ChhoundSettings, conns: readonly { id: string }[]): string[] {
	return listSandboxes(settings).map((s) => {
		const connected = conns.some((c) => c.id === path.basename(s.dir));
		return `${connected ? "●" : "·"} ${s.meta.worktree}${connected ? " (connected)" : ""}`;
	});
}

/**
 * Resolve a /ch-mcp argument to the sandboxes it names:
 * an absolute/relative worktree path, a sandbox dir name, or a worktree
 * basename. Returns all matches (ambiguity is reported by the caller).
 */
export function resolveSandboxMatches(arg: string, settings: ChhoundSettings, cwd: string): SandboxEntry[] {
	const resolved = path.resolve(cwd, expandHome(arg));
	return listSandboxes(settings).filter(
		(e) =>
			e.meta.worktree === resolved ||
			e.dir === resolved ||
			path.basename(e.dir) === arg ||
			path.basename(e.meta.worktree) === arg,
	);
}

type McpCmdCtx = {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(title: string, options: string[]): Promise<string | undefined>;
	};
};

async function connectEntry(
	pi: ExtensionAPI,
	ctx: McpCmdCtx,
	state: PluginState,
	entry: SandboxEntry,
	flags: Record<string, string | true>,
): Promise<void> {
	const id = path.basename(entry.dir);
	if (listMcpConnections().some((c) => c.id === id)) {
		ctx.ui.notify(`Already connected: ${id} — /ch-mcp ${id} --disconnect to stop.`, "info");
		return;
	}
	try {
		const conn = await connectMcp(pi, entry, {
			prefix: typeof flags["prefix"] === "string" ? flags["prefix"] : undefined,
			noDaemon: flags["no-daemon"] === true,
			readOnly: flags["read-only"] === true,
			apiKey: state.apiKey,
		});
		// Session-log record → auto-restored on the next session start. Only
		// daemon-mode connections are recorded: read-only / --no-daemon force
		// single-process stdio and would clash on the DuckDB file lock if two
		// of them targeted one database. API keys never go into the log.
		if (!flags["no-daemon"] && !flags["read-only"]) {
			recordConnection(pi, {
				sandboxId: conn.id,
				state: "connected",
				prefix: typeof flags["prefix"] === "string" ? flags["prefix"] : undefined,
			});
		}
		ctx.ui.notify(
			`Connected chhound MCP '${conn.id}' → ${conn.worktree}\n` +
				`tools: ${conn.toolNames.join(", ")}\n` +
				`disconnect: /ch-mcp ${conn.id} --disconnect`,
			"info",
		);
	} catch (e) {
		ctx.ui.notify(`Connect failed: ${(e as Error).message}`, "error");
	}
}

export function registerMcpCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("ch-mcp", {
		description:
			"Connect pi to a worktree's chunkhound index over MCP. " +
			"Usage: /ch-mcp [<worktree|storage-id> [--disconnect] [--no-daemon] [--read-only] [--prefix <pfx>]] — no argument opens the target picker",
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args, MCP_VALUE_FLAGS);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const loaded = loadSettings(repoRoot ?? ctx.cwd);
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");
			const settings = loaded.settings;

			// No argument → pick a target interactively (list fallback).
			if (positionals.length === 0) {
				const sandboxes = listSandboxes(settings);
				if (sandboxes.length === 0) {
					ctx.ui.notify("chhound MCP — no worktrees yet (run /chworktree <path> first).", "warning");
					return;
				}
				if (typeof ctx.ui.select === "function") {
					const options = mcpSelectOptions(settings, listMcpConnections());
					const choice = await ctx.ui.select("Connect chhound MCP to:", options);
					if (choice === undefined) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}
					const entry = sandboxes[options.indexOf(choice)];
					if (!entry) {
						ctx.ui.notify("Selection did not match a worktree — cancelling.", "error");
						return;
					}
					await connectEntry(pi, ctx, state, entry, {});
					return;
				}
				ctx.ui.notify(mcpTargetLines(settings, listMcpConnections()).join("\n"), "info");
				return;
			}

			const matches = resolveSandboxMatches(positionals[0]!, settings, ctx.cwd);
			if (matches.length === 0) {
				ctx.ui.notify(
					`No worktree or storage ID matches '${positionals[0]}' — run /ch-status to list worktrees.`,
					"error",
				);
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify(
					`'${positionals[0]}' matches ${matches.length} worktrees:\n` +
						matches.map((m) => `  ${path.basename(m.dir)} → ${m.meta.worktree}`).join("\n") +
						"\nUse the full worktree path.",
					"error",
				);
				return;
			}
			const entry = matches[0]!;
			const id = path.basename(entry.dir);

			if (flags["disconnect"] === true) {
				try {
					await disconnectMcp(id);
					// Tombstone: the append-only log keeps the old `connected` record,
					// but the latest record per sandbox wins on rehydrate.
					recordConnection(pi, { sandboxId: id, state: "disconnected" });
					ctx.ui.notify(`Disconnected ${id} — the chunkhound daemon exits on its own.`, "info");
				} catch (e) {
					ctx.ui.notify(`Disconnect failed: ${(e as Error).message}`, "error");
				}
				return;
			}

			await connectEntry(pi, ctx, state, entry, flags);
		},
	});
}
