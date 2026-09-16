import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { ensureBaseline } from "./chhound/baseline.js";
import { chhoundVersion } from "./chhound/cli.js";
import { findRepoRoot, gitRootOrNull } from "./chhound/git.js";
import { listSandboxes } from "./chhound/sandbox.js";
import { loadSettings, saveSettings } from "./chhound/settings.js";
import type { ChhoundSettings, PluginState } from "./chhound/types.js";
import { connectEntry, disconnectEntry, resolveSandboxMatches } from "./mcp/command.js";
import { listMcpConnections, mcpConnectionSummary } from "./mcp/manager.js";
import { refreshMaterializedConfigs } from "./setup/command.js";
import { buildStatusLines } from "./status/command.js";
import { createIndexedWorktree, oneGoLocation } from "./worktree/command.js";

export const MODEL_TOOL_NAME = "ch-chhound";
export const READ_ACTIONS = ["status", "worktree.list", "mcp.list", "setup.show"] as const;
export const MUTATING_ACTIONS = ["worktree.create", "baseline.refresh", "mcp.connect", "mcp.disconnect", "setup.update"] as const;
export const MODEL_ACTIONS = [...READ_ACTIONS, ...MUTATING_ACTIONS] as const;
type ModelAction = (typeof MODEL_ACTIONS)[number];

type Input = Record<string, unknown> & { action?: string };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { action: string; [key: string]: unknown } };

const parameters = Type.Object({
	action: StringEnum(MODEL_ACTIONS, { description: "Operation to perform." }),
	target: Type.Optional(Type.String()),
	repo: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	newBranch: Type.Optional(Type.String()),
	from: Type.Optional(Type.String()),
	dest: Type.Optional(Type.String()),
	config: Type.Optional(Type.String()),
	forceReindex: Type.Optional(Type.Boolean()),
	refreshBaseline: Type.Optional(Type.Boolean()),
	connect: Type.Optional(Type.Boolean()),
	ref: Type.Optional(Type.String()),
	force: Type.Optional(Type.Boolean()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	rerankModel: Type.Optional(Type.String()),
	outputDims: Type.Optional(Type.Number()),
	llmProvider: Type.Optional(Type.String()),
	llmModel: Type.Optional(Type.String()),
	baselineRef: Type.Optional(Type.String()),
	baselineMaxAge: Type.Optional(Type.Number()),
	sandboxRoot: Type.Optional(Type.String()),
	autoReconnect: Type.Optional(Type.Boolean()),
	modelTools: Type.Optional(StringEnum(["off", "read-only", "on"] as const)),
});

/** Settings safe to hand to the model: persisted API keys must never leave the host. */
function redact(settings: ChhoundSettings): ChhoundSettings {
	return {
		...settings,
		embedding: settings.embedding ? { ...settings.embedding, apiKey: settings.embedding.apiKey ? "[redacted]" : undefined } : settings.embedding,
		llm: settings.llm ? { ...settings.llm, apiKey: settings.llm.apiKey ? "[redacted]" : undefined } : settings.llm,
	};
}

function text(action: string, value: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text: value || `${action}: complete` }], details: { action, ...extra } };
}

function required(action: string, input: Input, name: string): string {
	const value = input[name];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${action} requires '${name}'.`);
	return value;
}

function access(action: string, cwd: string): void {
	const mode = loadSettings(cwd).settings.modelTools ?? "on";
	if (mode === "off") throw new Error(`${action} is disabled by modelTools=off. Enable it with /ch-setup --model-tools on.`);
	if (mode === "read-only" && (MUTATING_ACTIONS as readonly string[]).includes(action)) {
		throw new Error(`${action} is blocked while model tools are read-only. Enable mutations with /ch-setup --model-tools on.`);
	}
}

async function projectRoot(cwd: string): Promise<string> {
	return (await gitRootOrNull(cwd)) ?? cwd;
}

/**
 * Reporter progress → pi tool-update relay.
 *
 * The worktree/MCP reporter seams speak UI shapes ({message,type},
 * {kind:"line",line}, …). pi forwards whatever `onUpdate` receives straight
 * into the TUI as a partial result and expects a ToolResult patch — forwarding
 * a raw UI shape makes its renderer read `result.content.filter` on undefined
 * and crash the process (seen live on mcp.connect). Only pi's shape may pass.
 */
export function progressRelay(action: string, onUpdate: ((update: unknown) => void) | undefined): (update: unknown) => void {
	return (update) => {
		if (!onUpdate) return;
		if (update && typeof update === "object" && Array.isArray((update as { content?: unknown }).content)) {
			onUpdate(update); // already a ToolResult patch (e.g. the web relay)
			return;
		}
		const text = progressText(update);
		if (text === undefined) return;
		onUpdate({ content: [{ type: "text", text }], details: { action } });
	};
}

/** Text a reporter update should surface; undefined = nothing model-facing. */
function progressText(update: unknown): string | undefined {
	if (typeof update === "string") return update;
	if (!update || typeof update !== "object") return undefined;
	const value = update as Record<string, unknown>;
	if (typeof value.message === "string") return value.message;
	if (typeof value.line === "string") return value.line;
	if (typeof value.note === "string") return value.note;
	if (typeof value.phase === "string") return `[${value.phase}]`;
	return undefined; // {kind:"watch"|"done"} and unknown UI frames carry no text
}

function updates(settings: ChhoundSettings, input: Input): string[] {
	const changed: string[] = [];
	if (typeof input.provider === "string") { settings.embedding = { ...settings.embedding, provider: input.provider }; changed.push("provider"); }
	if (typeof input.model === "string") { settings.embedding = { ...settings.embedding, model: input.model }; changed.push("model"); }
	if (typeof input.rerankModel === "string") { settings.embedding = { ...settings.embedding, rerankModel: input.rerankModel }; changed.push("rerankModel"); }
	if (input.outputDims !== undefined) {
		if (!Number.isInteger(input.outputDims) || Number(input.outputDims) <= 0) throw new Error("setup.update requires outputDims to be a positive integer.");
		settings.embedding = { ...settings.embedding, outputDims: Number(input.outputDims) }; changed.push("outputDims");
	}
	if (typeof input.llmProvider === "string") { settings.llm = { ...settings.llm, provider: input.llmProvider }; changed.push("llmProvider"); }
	if (typeof input.llmModel === "string") { settings.llm = { ...settings.llm, model: input.llmModel }; changed.push("llmModel"); }
	if (typeof input.baselineRef === "string") { settings.baseline = { ...settings.baseline, ref: input.baselineRef }; changed.push("baselineRef"); }
	if (input.baselineMaxAge !== undefined) {
		if (!Number.isFinite(input.baselineMaxAge) || Number(input.baselineMaxAge) <= 0) throw new Error("setup.update requires baselineMaxAge to be positive.");
		settings.baseline = { ...settings.baseline, maxAgeDays: Number(input.baselineMaxAge) }; changed.push("baselineMaxAge");
	}
	if (typeof input.sandboxRoot === "string") { settings.sandboxRoot = path.resolve(input.sandboxRoot); changed.push("sandboxRoot"); }
	if (typeof input.autoReconnect === "boolean") { settings.autoReconnect = input.autoReconnect; changed.push("autoReconnect"); }
	if (typeof input.modelTools === "string") { settings.modelTools = input.modelTools as ChhoundSettings["modelTools"]; changed.push("modelTools"); }
	return changed;
}

async function execute(pi: ExtensionAPI, state: PluginState, input: Input, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, ctx: ExtensionContext): Promise<ToolResult> {
	const action = input.action;
	if (!(MODEL_ACTIONS as readonly string[]).includes(action ?? "")) {
		throw new Error(`Unknown ch-chhound action '${String(action)}'. Supported actions: ${MODEL_ACTIONS.join(", ")}.`);
	}
	const selected = action as ModelAction;
	access(selected, ctx.cwd);
	const root = await projectRoot(ctx.cwd);
	const settings = loadSettings(root).settings;
	const report = { cwd: ctx.cwd, hasUI: false, pi, state, signal, onProgress: progressRelay(selected, onUpdate as ((update: unknown) => void) | undefined) };

	switch (selected) {
		case "status": {
			const lines = buildStatusLines({ version: await chhoundVersion(), settings, sandboxes: listSandboxes(settings), conns: listMcpConnections() });
			return text(selected, lines.join("\n"));
		}
		case "worktree.list": {
			const entries = listSandboxes(settings);
			return text(selected, entries.length ? entries.map((s) => `${s.meta.worktree} (${path.basename(s.dir)})`).join("\n") : "No indexed worktrees.", { worktrees: entries });
		}
		case "mcp.list": {
			const connections = listMcpConnections();
			// Plain-data projection only: raw connections hold the live MCP client
			// (functions + cyclic ajv validators), which breaks pi's session JSON
			// write and its per-request structuredClone of the message history.
			return text(selected, connections.length ? connections.map((c) => `${c.id}: ${c.worktree}`).join("\n") : "No MCP connections.", { connections: connections.map(mcpConnectionSummary) });
		}
		case "setup.show": {
			const safe = redact(settings);
			return text(selected, JSON.stringify(safe, null, 2), { settings: safe });
		}
		case "setup.update": {
			const changed = updates(settings, input);
			if (!changed.length) throw new Error("setup.update requires at least one settings field.");
			const file = saveSettings(settings, "global");
			const refreshed = refreshMaterializedConfigs(settings);
			return text(selected, `Updated settings: ${changed.join(", ")} → ${file}${refreshed.length ? `\nRefreshed ${refreshed.length} config(s).` : ""}`, { changed, file });
		}
		case "mcp.connect": {
			const target = required(selected, input, "target");
			const matches = resolveSandboxMatches(target, settings, ctx.cwd);
			if (matches.length !== 1) throw new Error(`mcp.connect target '${target}' ${matches.length ? "is ambiguous" : "was not found"}; run status to list worktrees.`);
			const result = await connectEntry(pi, report, state, matches[0]!, {});
			return text(selected, result.message ?? result.kind, { result });
		}
		case "mcp.disconnect": {
			const target = required(selected, input, "target");
			const match = resolveSandboxMatches(target, settings, ctx.cwd);
			const id = match.length === 1 ? path.basename(match[0]!.dir) : target;
			const result = await disconnectEntry(pi, report, id);
			return text(selected, result.message ?? result.kind, { result });
		}
		case "baseline.refresh": {
			const repo = typeof input.repo === "string" ? (await findRepoRoot(path.resolve(ctx.cwd, input.repo))) : await gitRootOrNull(ctx.cwd);
			if (!repo) throw new Error("baseline.refresh requires repo when the current directory is not a git repository.");
			const baseline = await ensureBaseline({ repoRoot: repo, settings, ref: typeof input.ref === "string" ? input.ref : undefined, force: input.force === true, signal, onLine: (line) => (onUpdate as any)?.({ content: [{ type: "text", text: line }], details: { action: selected } }) });
			return text(selected, `Baseline ${baseline.ref}: ${baseline.reason}`, { baseline });
		}
		case "worktree.create": {
			const repoArg = typeof input.repo === "string" ? path.resolve(ctx.cwd, input.repo) : ctx.cwd;
			const repo = await findRepoRoot(repoArg);
			if (!repo) throw new Error(`worktree.create requires repo to name a git repository (or run it from one).`);
			if (input.branch !== undefined && input.newBranch !== undefined) throw new Error("worktree.create accepts either branch or newBranch, not both.");
			const slot = typeof input.newBranch === "string" ? input.newBranch : typeof input.branch === "string" ? input.branch : undefined;
			const dest = typeof input.dest === "string" ? path.resolve(ctx.cwd, input.dest) : undefined;
			const location = await oneGoLocation(repo, slot, settings, dest, () => {});
			if (!location) throw new Error("worktree.create could not select a safe worktree location.");
			const flags: Record<string, string | true> = {};
			if (typeof input.config === "string") flags.config = input.config;
			if (input.forceReindex) flags["force-reindex"] = true;
			if (input.refreshBaseline) flags["refresh-baseline"] = true;
			await createIndexedWorktree(report, state, { repoRoot: repo, sandboxDir: location.sandboxDir, wtPath: location.wtPath, settings, createBranch: typeof input.newBranch === "string" ? input.newBranch : undefined, branch: typeof input.branch === "string" ? input.branch : undefined, commitIsh: typeof input.from === "string" ? input.from : undefined, connect: input.connect === true, flags });
			return text(selected, `Created worktree request for ${location.wtPath}.`, { location });
		}
	}
}

export function registerModelTools(pi: ExtensionAPI, state: PluginState): void {
	pi.registerTool({
		name: MODEL_TOOL_NAME,
		label: "ChunkHound",
		description: `ChunkHound platform operations. Actions: ${MODEL_ACTIONS.join(", ")}. Use status/worktree.list/mcp.list/setup.show for inspection; mutating actions require user consent.`,
		promptSnippet: "Use ch-chhound to inspect or operate ChunkHound worktrees, baselines, MCP, and settings.",
		parameters,
		executionMode: "sequential",
		execute: (_id, input, signal, onUpdate, ctx) => execute(pi, state, input as Input, signal, onUpdate as any, ctx),
		renderResult(result) {
			// pi forwards onUpdate payloads into this renderer as partial results;
			// tolerate a content-less carry so its own fallback (which assumes
			// `result.content` exists) is never reached on a renderer throw.
			const body = (result.content ?? []).map((part) => part.type === "text" ? part.text : "").join("\n");
			switch ((result.details as { action?: string } | undefined)?.action) {
				case "status": case "worktree.list": case "mcp.list": case "setup.show": case "worktree.create": case "baseline.refresh": case "mcp.connect": case "mcp.disconnect": case "setup.update": return new Text(body, 0, 0);
				default: return new Text(body, 0, 0);
			}
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== MODEL_TOOL_NAME || !(MUTATING_ACTIONS as readonly string[]).includes((event.input as Input).action ?? "")) return;
		if (!ctx.hasUI) return { block: true, reason: "Mutating ch-chhound actions require interactive confirmation." };
		const action = (event.input as Input).action!;
		if (!await ctx.ui.confirm("Allow ChunkHound change?", `Allow ch-chhound to run ${action}?`)) {
			return { block: true, reason: `User declined ${action}.` };
		}
	});
}
