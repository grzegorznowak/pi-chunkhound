import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { gitRootOrNull } from "../chhound/git.js";
import { expandHome } from "../chhound/completions.js";
import { listSandboxes } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";
import { connectMcp, disconnectMcp, listMcpConnections } from "./manager.js";

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

export function registerMcpCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("ch-mcp", {
		description:
			"Connect pi to a sandbox's chunkhound index over MCP. " +
			"Usage: /ch-mcp [<worktree|sandbox> [--disconnect] [--no-daemon] [--read-only] [--prefix <pfx>]]",
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const loaded = loadSettings(repoRoot ?? ctx.cwd);
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");
			const settings = loaded.settings;

			// No argument → status.
			if (positionals.length === 0) {
				const conns = listMcpConnections();
				const lines = ["chhound MCP connections:"];
				if (conns.length === 0) {
					lines.push("  (none — run /ch-mcp <worktree> to connect)");
				} else {
					for (const c of conns) {
						lines.push(
							`  ✓ ${c.id} → ${c.worktree}`,
							`      prefix ${c.prefix} · ${c.toolNames.length} tools · since ${c.connectedAt.slice(0, 19).replace("T", " ")} · pid ${c.transport.pid ?? "?"}`,
						);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
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
		},
	});
}
