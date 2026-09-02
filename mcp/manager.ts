/**
 * Dynamic MCP connection manager: spawns `chunkhound mcp <sandbox-dir>
 * --config <sandbox-config>` (daemonized proxy by default) and bridges the
 * server's tools into pi via registerTool() (which auto-refreshes the tool
 * registry — newly registered tools become active immediately).
 *
 * Design 1 (sandbox-anchored): the daemon's project dir is the SANDBOX DIR,
 * never the worktree — .chunkhound/ (daemon.log, watchman) and the index db
 * live next to the config, while the checkout stays pristine.
 *
 * Lifecycle:
 * - connect: spawn → SDK stdio connect → listTools → register `chh_*` tools.
 * - disconnect: close the transport → stdio EOF → proxy exits → chunkhound
 *   daemon shuts itself down (shutdown delay 0) and removes its lock/socket.
 *   Belt-and-braces SIGTERM for a lingering child.
 * - Tools stay registered after disconnect (pi has no unregisterTool); their
 *   execute() then throws a clear "reconnect" error. Reconnecting with the
 *   same id re-registers fresh closures over the new connection.
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chhoundApiKeyEnv, chhoundBinary } from "../chhound/cli.js";
import { slugify } from "../chhound/paths.js";
import { sandboxConfigPath } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

/** Raw MCP tool metadata as listed by the server — replayable into other sessions. */
export interface McpToolMeta {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpConnection {
	/** Sandbox dir name — the stable id for connect/disconnect. */
	id: string;
	worktree: string;
	/** Tool-name prefix, e.g. "chh_wt-fix" → tools "chh_wt-fix_search". */
	prefix: string;
	client: Client;
	transport: StdioClientTransport;
	toolNames: string[];
	/** The tools as listed at connect (registerBridgeTool input). */
	tools: McpToolMeta[];
	connectedAt: string;
}

export interface ConnectMcpOptions {
	prefix?: string;
	noDaemon?: boolean;
	readOnly?: boolean;
	apiKey?: string;
	/** Extra CLI args for the chunkhound mcp server (test seam, mirrors hotStartIndex). */
	extraArgs?: string[];
}

const connections = new Map<string, McpConnection>();

/** Footer status key (distinct from the index-progress "chhound" line). */
export const MCP_STATUS_KEY = "chhound-mcp";

/**
 * Footer text for the live dynamic connections (pure — smoke-tested
 * headless). Mirrors pi-mcp-adapter's "🔌 MCP: …" segment; undefined =
 * nothing connected = hide the segment.
 */
export function mcpFooterStatusText(conns: readonly Pick<McpConnection, "id">[]): string | undefined {
	if (conns.length === 0) return undefined;
	return `🔌 ch-mcp: ${conns.length} connected`;
}

/** Transient shown while session-start auto-restore is still in flight. */
export const MCP_FOOTER_RESTORING = "🔌 ch-mcp: restoring…";

let statusListener: (() => void) | undefined;

/**
 * Bind/unbind the footer refresh. index.ts re-binds it to the session's
 * ctx.ui on every session_start (pi clears extension statuses on session
 * end, so each session starts from a clean footer) and unbinds on
 * session_shutdown before the teardown disconnects.
 */
export function setMcpStatusListener(listener: (() => void) | undefined): void {
	statusListener = listener;
}

/** Refresh the footer after any connection-state change (no-op unbound). */
export function refreshMcpStatus(): void {
	statusListener?.();
}

/** Default tool prefix: `chh_<worktree basename slug>` (overrideable). */
export function mcpToolPrefix(worktree: string, override?: string): string {
	return override || `chh_${slugify(path.basename(worktree))}`;
}

export function listMcpConnections(): McpConnection[] {
	return [...connections.values()];
}

export function getMcpConnection(id: string): McpConnection | undefined {
	return connections.get(id);
}

export async function connectMcp(pi: ExtensionAPI, entry: SandboxEntry, opts: ConnectMcpOptions = {}): Promise<McpConnection> {
	const id = path.basename(entry.dir);
	if (connections.has(id)) throw new Error(`already connected (${id}) — run /ch-mcp ${id} --disconnect first`);

	const args = ["mcp", entry.dir, "--config", sandboxConfigPath(entry.dir)];
	if (opts.noDaemon) args.push("--no-daemon");
	if (opts.readOnly) args.push("--read-only");
	if (opts.extraArgs) args.push(...opts.extraArgs);

	const transport = new StdioClientTransport({
		command: chhoundBinary(),
		args,
		cwd: entry.dir,
		env: { ...process.env, ...(chhoundApiKeyEnv(opts.apiKey) ?? {}) } as Record<string, string>,
		stderr: "pipe",
	});
	transport.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) console.error(`[chhound-mcp:${id}] ${text}`);
	});

	const client = new Client({ name: "pi-chhound", version: "0.1.0" }, { capabilities: {} });

	// Unexpected-daemon-death detection. Hook the SDK Client's OWN close/error
	// callbacks — NOT transport.onclose after connect: Protocol.connect()
	// installs chained wrappers on the transport, and overwriting them would
	// bypass Protocol._onclose()'s cleanup (in-flight request rejection,
	// timers, _transport reset). _onclose() runs first and ends by calling
	// client.onclose, so by the time ours fires the SDK state is already
	// consistent. The identity guard (conn assigned below, map entry set at
	// the end) makes the handler a no-op for explicit disconnects (they delete
	// the entry before closing) and connect failures (conn still undefined).
	// The session-log record intentionally stays `connected`: crash semantics
	// are "retry next session", while an explicit --disconnect writes a
	// tombstone.
	let conn: McpConnection | undefined;
	client.onclose = () => {
		if (conn !== undefined && connections.get(id) === conn) {
			connections.delete(id);
			refreshMcpStatus();
		}
	};
	client.onerror = (error) => {
		console.error(`[chhound-mcp:${id}] connection error: ${error instanceof Error ? error.message : String(error)}`);
	};

	try {
		await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
	} catch (e) {
		await transport.close().catch(() => undefined);
		throw new Error(`could not start 'chunkhound mcp' (${args.join(" ")}): ${(e as Error).message}`);
	}

	const prefix = mcpToolPrefix(entry.meta.worktree, opts.prefix);
	let mcpTools: McpToolMeta[];
	try {
		const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
		mcpTools = listed.tools ?? [];
	} catch (e) {
		// Daemon died between connect and list, or refused to list: close the
		// client so the child/daemon exits, then surface the failure — no map
		// entry, no orphaned daemon.
		await client.close().catch(() => undefined);
		throw new Error(`could not list tools from 'chunkhound mcp' for ${id}: ${(e as Error).message}`);
	}
	// Connect race (session-start restore vs a manual /ch-mcp for the same
	// id): both spawned; the loser closes its own daemon. Registered only
	// after the check, so a failed race leaves no tool registrations.
	if (connections.has(id)) {
		await client.close().catch(() => undefined);
		throw new Error(`already connected (${id}) — run /ch-mcp ${id} --disconnect first`);
	}
	const toolNames: string[] = [];
	for (const tool of mcpTools) {
		const piName = `${prefix}_${tool.name}`;
		registerBridgeTool(pi, id, piName, tool);
		toolNames.push(piName);
	}

	conn = {
		id,
		worktree: entry.meta.worktree,
		prefix,
		client,
		transport,
		toolNames,
		tools: mcpTools,
		connectedAt: new Date().toISOString(),
	};
	connections.set(id, conn);
	refreshMcpStatus();
	return conn;
}

export async function disconnectMcp(id: string): Promise<void> {
	const conn = connections.get(id);
	if (!conn) throw new Error(`not connected: ${id}`);
	connections.delete(id);
	refreshMcpStatus();
	await conn.client.close().catch(() => undefined);
	// stdio EOF makes the proxy exit; the chunkhound daemon then shuts itself
	// down (delay 0). Belt-and-braces: SIGTERM a child that lingers.
	const pid = conn.transport.pid;
	if (pid !== null) {
		for (let i = 0; i < 25; i++) {
			if (!isAlive(pid)) return;
			await new Promise((r) => setTimeout(r, 200));
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}
}

/** Disconnect everything (session_shutdown / /reload). */
export async function closeAllMcp(): Promise<void> {
	// Sweep: a connect started by a session-start restore that races a session
	// switch can land in the registry AFTER the first snapshot (closeAllMcp
	// runs while that connect is still in flight). Repeat until the registry
	// stays empty — normally one pass.
	for (let i = 0; i < 5 && connections.size > 0; i++) {
		const ids = [...connections.keys()];
		await Promise.allSettled(ids.map((id) => disconnectMcp(id)));
	}
}

/**
 * Re-register bridge tools for connections into a session's extension api.
 *
 * pi re-runs every extension factory once per session (main, spawned children,
 * post-reload registry rebuilds). Runtime registrations like /ch-mcp's live
 * only in the extension object of the session that connected — without a
 * replay, a spawned child's tool whitelist (built from the parent's active
 * tools) silently drops chh_* names because the child's registry never had
 * them. The execute closures target the shared module-level connections
 * registry, so replayed tools work in any in-process session.
 */
export function reRegisterBridgeTools(
	pi: ExtensionAPI,
	conns: readonly Pick<McpConnection, "id" | "prefix" | "tools">[] = [...connections.values()],
): void {
	for (const conn of conns) {
		for (const tool of conn.tools) {
			registerBridgeTool(pi, conn.id, `${conn.prefix}_${tool.name}`, tool);
		}
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── tool bridging ──────────────────────────────────────────────────────────

function registerBridgeTool(
	pi: ExtensionAPI,
	id: string,
	piName: string,
	tool: { name: string; description?: string; inputSchema?: unknown },
): void {
	pi.registerTool({
		name: piName,
		label: piName,
		description: `[chhound:${id}] ${tool.description || tool.name}`,
		promptSnippet: `Call chhound MCP tool ${id}/${tool.name}`,
		parameters: objectSchemaOrEmpty(tool.inputSchema) as any,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate) {
			const conn = connections.get(id);
			if (!conn) throw new Error(`chhound MCP '${id}' is not connected — run /ch-mcp ${id} to reconnect`);
			onUpdate?.({
				content: [{ type: "text", text: `Calling chhound MCP tool ${tool.name}...` }],
				details: { server: id, tool: tool.name },
			});
			const result = (await conn.client.callTool(
				{ name: tool.name, arguments: params as Record<string, unknown> },
				undefined,
				{
					signal,
					timeout: CALL_TIMEOUT_MS,
					resetTimeoutOnProgress: true,
					onprogress: (progress) => {
						onUpdate?.({
							content: [{ type: "text", text: `chhound progress: ${stringifyUnknown(progress)}` }],
							details: { server: id, tool: tool.name, progress },
						});
					},
				},
			)) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
			const text = formatMcpContent(result);
			if (result.isError === true) throw new Error(text);
			return { content: [{ type: "text", text }], details: { server: id, tool: tool.name, mcp: result } };
		},
	});
}

function objectSchemaOrEmpty(schema: unknown): Record<string, unknown> {
	if (schema && typeof schema === "object" && !Array.isArray(schema)) {
		const candidate = schema as Record<string, unknown>;
		if (candidate.type === "object") return candidate;
	}
	return { type: "object", properties: {}, additionalProperties: true };
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncateHead(content: string): { content: string; truncated: boolean; totalLines: number; totalBytes: number } {
	const totalBytes = Buffer.byteLength(content, "utf8");
	const lines = content.split("\n");
	let usedBytes = 0;
	const output: string[] = [];
	for (const line of lines) {
		if (output.length >= DEFAULT_MAX_LINES) break;
		const lineBytes = Buffer.byteLength(line + (output.length < lines.length - 1 ? "\n" : ""), "utf8");
		if (usedBytes + lineBytes > DEFAULT_MAX_BYTES) break;
		output.push(line);
		usedBytes += lineBytes;
	}
	return {
		content: output.join("\n"),
		truncated: output.length < lines.length || usedBytes < totalBytes,
		totalLines: lines.length,
		totalBytes,
	};
}

function formatMcpContent(result: { isError?: boolean; content?: unknown; structuredContent?: unknown }): string {
	const parts: string[] = [];
	const content = Array.isArray(result.content) ? result.content : [];
	for (const item of content) {
		if (!item || typeof item !== "object") {
			parts.push(stringifyUnknown(item));
			continue;
		}
		const block = item as Record<string, unknown>;
		switch (block.type) {
			case "text":
				parts.push(typeof block.text === "string" ? block.text : stringifyUnknown(block));
				break;
			case "image":
				parts.push(`[image: ${String(block.mimeType ?? "unknown")}, base64 bytes: ${String(block.data ?? "").length}]`);
				break;
			default:
				parts.push(stringifyUnknown(block));
		}
	}
	if (result.structuredContent !== undefined) {
		parts.push(`[structuredContent]\n${stringifyUnknown(result.structuredContent)}`);
	}
	if (parts.length === 0) {
		parts.push(stringifyUnknown(result));
	}
	const raw = parts.join("\n\n");
	const truncated = truncateHead(raw);
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Truncated MCP output: original ${truncated.totalLines} lines, ${truncated.totalBytes} bytes; showing first ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes max]`;
}
