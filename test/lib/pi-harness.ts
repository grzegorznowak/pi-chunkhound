import fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "./isolation.js";

// Pending operator literal confirmation: rename the dispatcher in this ONE place.
export const MODEL_TOOL_NAME = "ch-chhound";
export const READ_ACTIONS = ["status", "worktree.list", "mcp.list", "setup.show"] as const;
export const MUTATING_ACTIONS = ["worktree.create", "baseline.refresh", "mcp.connect", "mcp.disconnect", "setup.update"] as const;
export const MODEL_ACTIONS = [...READ_ACTIONS, ...MUTATING_ACTIONS] as const;

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Command = { handler: (args: string, ctx: any) => unknown | Promise<unknown> };
export function makePiHarness(cwd: string, options: { hasUI?: boolean; answers?: boolean[]; mode?: "tui" | "rpc" | "print" | "json" } = {}) {
	const tools = new Map<string, ToolDefinition>();
	const registrations: ToolDefinition[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const activeChanges: string[][] = [];
	let active: string[] = [];
	const entries: any[] = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const selections: string[] = [];
	const widgets: Array<{ key: string; content: unknown; options?: unknown }> = [];
	const answers = [...(options.answers ?? [])];
	const hasUI = options.hasUI ?? true;
	const pi = {
		registerTool(def: ToolDefinition) {
			registrations.push(def);
			if (!tools.has(def.name)) active.push(def.name);
			tools.set(def.name, def);
		},
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name: string, def: Command) { commands.set(name, def); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; activeChanges.push([...names]); },
		getAllTools() { return [...tools.values()]; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd, hasUI, mode: options.mode ?? (hasUI ? "tui" : "print"),
		ui: {
			// Record attempted noOp calls, but never grant consent without UI.
			confirm: async (title: string, message: string) => { confirms.push({ title, message }); return hasUI ? (answers.shift() ?? false) : false; },
			notify: (message: string, type?: string) => { notices.push({ message, type }); },
			select: async (title: string) => { selections.push(title); return undefined; },
			input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
			setStatus() {}, setWidget(key: string, content: unknown, options?: unknown) { widgets.push({ key, content, options }); }, addAutocompleteProvider() {},
		},
		sessionManager: { getBranch: () => [...entries], getEntries: () => [...entries], getSessionId: () => "test-session", getSessionFile: () => undefined, getCwd: () => cwd },
		isIdle: () => true, isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	return { pi, ctx, tools, registrations, handlers, commands, activeChanges, entries, confirms, notices, selections, widgets };
}
export type PiHarness = ReturnType<typeof makePiHarness>;

export async function runExtension(pi: ExtensionAPI): Promise<void> {
	const extension = await import("../../index.js");
	await extension.default(pi);
}

export async function fireToolCall(harness: PiHarness, event: { toolName: string; input: Record<string, unknown>; toolCallId?: string }): Promise<unknown> {
	for (const handler of harness.handlers.get("tool_call") ?? []) {
		const result = await handler({ type: "tool_call", toolCallId: "test-call", ...event }, harness.ctx);
		if (result && typeof result === "object" && "block" in result && result.block) return result;
	}
	return undefined;
}

/** Fire and await every captured session_shutdown hook (including async cleanup). */
export async function fireSessionShutdown(harness: PiHarness): Promise<void> {
	for (const handler of harness.handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown" }, harness.ctx);
	}
}

/** Factory execution, not session_start: no automatic connection restoration. */
export async function withPiHarness(body: (h: PiHarness) => Promise<void>, options: { hasUI?: boolean; answers?: boolean[]; mode?: "tui" | "rpc" | "print" | "json" } = {}): Promise<void> {
	const env = snapshotEnv();
	const root = await makeFixtureRoot("pi-chhound-model-tools-");
	try {
		const home = await makeFakeHome(root);
		// No test may accidentally resolve a real chunkhound executable.
		applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: `${root}/no-engine` } }));
		await body(makePiHarness(root, options));
	} finally {
		applyEnv(env);
		await fs.rm(root, { recursive: true, force: true });
	}
}
