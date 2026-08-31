import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { gitRootOrNull } from "../chhound/git.js";
import { expandHome } from "../chhound/completions.js";
import { listSandboxes, fmtSize } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";
import { connectMcp, disconnectMcp, listMcpConnections } from "./manager.js";
import type { McpConnection } from "./manager.js";

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
		lines.push("  (no sandboxes — run /chworktree <path> first)");
	} else {
		for (const s of sandboxes) {
			const id = path.basename(s.dir);
			const conn = conns.find((c) => c.id === id);
			lines.push(
				`  ${conn ? "●" : "·"} ${s.meta.worktree}${conn ? "  (connected)" : ""}`,
				`      ${id} · ${s.meta.branch} @ ${s.meta.baseCommit.slice(0, 8)} · db ${fmtSize(s.dbSizeBytes)}${conn ? ` · prefix ${conn.prefix} · ${conn.toolNames.length} tools` : ""}`,
			);
		}
	}
	lines.push("connect: /ch-mcp <worktree or sandbox name>");
	if (conns.length > 0) lines.push("disconnect: /ch-mcp <sandbox name> --disconnect");
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
			"Connect pi to a sandbox's chunkhound index over MCP. " +
			"Usage: /ch-mcp [<worktree|sandbox> [--disconnect] [--no-daemon] [--read-only] [--prefix <pfx>]] — no argument opens the target picker",
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const loaded = loadSettings(repoRoot ?? ctx.cwd);
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");
			const settings = loaded.settings;

			// No argument → pick a target interactively (list fallback).
			if (positionals.length === 0) {
				const sandboxes = listSandboxes(settings);
				if (sandboxes.length === 0) {
					ctx.ui.notify("chhound MCP — no sandboxes yet (run /chworktree <path> first).", "warning");
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
						ctx.ui.notify("Selection did not match a sandbox — cancelling.", "error");
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
					`No sandbox matches '${positionals[0]}' — run /ch-status to list sandboxes.`,
					"error",
				);
				return;
			}
			if (matches.length > 1) {
				ctx.ui.notify(
					`'${positionals[0]}' matches ${matches.length} sandboxes:\n` +
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
