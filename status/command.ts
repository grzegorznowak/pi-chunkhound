import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listBaselines, sweepBaselineGarbage } from "../chhound/baseline.js";
import { chhoundBinary, chhoundVersion } from "../chhound/cli.js";
import { parseArgs } from "../chhound/args.js";
import { gitRootOrNull } from "../chhound/git.js";
import { baseRoot, sandboxRoot } from "../chhound/paths.js";
import { fmtSize, listSandboxes, pruneSandboxes, claimedRootMatches, sandboxBranchLabel } from "../chhound/sandbox.js";
import { listMcpConnections } from "../mcp/manager.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";
import type { BaselineMeta } from "../chhound/types.js";
import type { SandboxEntry } from "../chhound/sandbox.js";

/**
 * Full /ch-status rendering (pure — the handler assembles the inputs and
 * notifies the result). Kept headless so the exact output is verifiable.
 */
export function buildStatusLines(opts: {
	version: string;
	settings: ChhoundSettings;
	sandboxes: SandboxEntry[];
	baselines: Array<{ dir: string; meta?: BaselineMeta }>;
	conns: readonly { worktree: string; prefix: string; toolNames: string[] }[];
}): string[] {
	const { version, settings, sandboxes, baselines, conns } = opts;
	const lines: string[] = [
		`chunkhound: ${version.replace(/^chunkhound\s+/, "")} (${chhoundBinary()})`,
		`worktree library root: ${sandboxRoot(settings)}${settings.worktreeBase && !settings.sandboxRoot ? ` (legacy worktreeBase)` : ""}`,
		`baseline library root: ${baseRoot(settings)}`,
		`embedding: ${settings.embedding?.provider && settings.embedding?.model
			? `${settings.embedding.provider}/${settings.embedding.model}${settings.embedding.outputDims ? ` · dims ${settings.embedding.outputDims}` : ""}`
			: "not configured — run /ch-setup"}`,
		`llm: ${settings.llm?.provider ? `${settings.llm.provider}/${settings.llm.model ?? "default"}` : "not configured — research tools need it (/ch-setup)"}`,
		`api key: ${settings.embedding?.apiKey ? "stored in settings ✓" : process.env.CHUNKHOUND_EMBEDDING__API_KEY ? "env ✓" : "not set (env or /ch-setup)"}`,
		"",
		`worktrees (${sandboxes.length}):`,
	];
	if (sandboxes.length === 0) {
		lines.push("  (none — run /chworktree <path>)");
	} else {
		for (const s of sandboxes) {
			const alive = fs.existsSync(s.meta.worktree) ? "✓ live" : "✗ gone";
			const repoName = s.meta.repoRoot ? path.basename(s.meta.repoRoot) : path.basename(s.dir);
			// Design 1: the claimed root is the SANDBOX dir (the daemon's
			// project dir — the checkout lives inside it), not the worktree.
			let rootTxt: string[];
			if (!s.claimedRoot) {
				rootTxt = [`⚠ unclaimed — run chunkhound index/mcp from ${s.dir}`];
			} else if (claimedRootMatches(s.claimedRoot, s.dir)) {
				rootTxt = [`✓ ${s.claimedRoot}`];
			} else {
				rootTxt = [
					"⚠ mismatch",
					`claimed:  ${s.claimedRoot}`,
					`expected: ${s.dir}`,
					"fix: run chunkhound index/mcp from the expected root",
				];
			}
			lines.push(
				`  ${alive}  ${repoName}/${sandboxBranchLabel(s.meta)}`,
				`      worktree:   ${s.meta.worktree}`,
				`      base commit: ${s.meta.baseCommit.slice(0, 8)} · index: ${fmtSize(s.dbSizeBytes)} · created: ${s.meta.createdAt.slice(0, 10)}`,
				`      index root: ${rootTxt[0]}`,
				...rootTxt.slice(1).map((l) => `          ${l}`),
			);
		}
	}
	lines.push("", `baselines (${baselines.length}):`);
	if (baselines.length === 0) {
		lines.push("  (none — created on first /chworktree)");
	} else {
		for (const b of baselines) {
			const meta = b.meta;
			// Dir layout is <baseRoot>/<repo-slug>-<hash8>/<ref> — show the
			// repo (slug part) so multi-repo libraries are readable.
			const repoDirName = path.basename(path.dirname(b.dir));
			const repoName = repoDirName.length > 9 ? repoDirName.slice(0, -9) : repoDirName;
			lines.push(
				meta
					? `  ${repoName}/${path.basename(b.dir)} @ ${meta.baseCommit.slice(0, 8)} · ${meta.chhoundVersion} · updated ${meta.updatedAt.slice(0, 10)}`
					: `  ${repoName}/${path.basename(b.dir)} (no meta — incomplete)`,
			);
		}
	}
	lines.push(...mcpStatusLines(conns));
	lines.push(
		`cleanup: /ch-status --prune removes storage for gone worktrees and unused or incomplete baselines` +
			(conns.length === 0 ? " · connect: /ch-mcp <worktree>" : ""),
	);
	return lines;
}

/** MCP connection section for /ch-status (pure — smoke-tested headless). */
export function mcpStatusLines(conns: readonly { worktree: string; prefix: string; toolNames: string[] }[]): string[] {
	const lines = ["", `mcp connections (${conns.length}):`];
	if (conns.length === 0) {
		lines.push("  (none — run /ch-mcp to connect)");
	} else {
		for (const c of conns) {
			lines.push(
				`  ● ${path.basename(c.worktree)} · prefix ${c.prefix} · ${c.toolNames.length} tools`,
				`      ${c.worktree}`,
			);
		}
	}
	return lines;
}

export function registerStatusCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("ch-status", {
		description:
			"List pi-chhound worktrees and baselines (index library). " +
			"Usage: /ch-status [--prune] (--prune removes storage for gone worktrees and garbage baselines: " +
			"incomplete, dead repo, superseded)",
		handler: async (args, ctx) => {
			const { flags } = parseArgs(args);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const loaded = loadSettings(repoRoot ?? ctx.cwd);
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");
			const settings = loaded.settings;

			if (flags["prune"] === true) {
				const removed = pruneSandboxes(settings);
				const removedBases = sweepBaselineGarbage(settings);
				if (removed.length > 0 || removedBases.length > 0) {
					ctx.ui.notify(
						[
							removed.length > 0 ? `Pruned storage for ${removed.length} gone worktree(s):\n${removed.join("\n")}` : "",
							removedBases.length > 0 ? `Pruned ${removedBases.length} baseline(s):\n${removedBases.join("\n")}` : "",
						].filter(Boolean).join("\n"),
						"info",
					);
				} else {
					ctx.ui.notify("Nothing to prune — all worktrees are live and all baselines are valid.", "info");
				}
			}

			const version = await chhoundVersion();
			const sandboxes = listSandboxes(settings);
			const baselines = listBaselines(settings);

			ctx.ui.notify(
				buildStatusLines({ version, settings, sandboxes, baselines, conns: listMcpConnections() }).join("\n"),
				"info",
			);
		},
	});
}
