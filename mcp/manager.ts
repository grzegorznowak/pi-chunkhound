/**
 * Dynamic MCP connection manager: spawns `chunkhound mcp <worktree>
 * --config <sandbox-config>` (daemonized proxy by default) and bridges the
 * server's tools into pi via registerTool() (which auto-refreshes the tool
 * registry — newly registered tools become active immediately).
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

export interface McpConnection {
	/** Sandbox dir name — the stable id for connect/disconnect. */
	id: string;
	worktree: string;
	/** Tool-name prefix, e.g. "chh_wt-fix" → tools "chh_wt-fix_search". */
	prefix: string;
	client: Client;
	transport: StdioClientTransport;
	toolNames: string[];
	connectedAt: string;
}

export interface ConnectMcpOptions {
	prefix?: string;
	noDaemon?: boolean;
	readOnly?: boolean;
	apiKey?: string;
}

const connections = new Map<string, McpConnection>();

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

	const args = ["mcp", entry.meta.worktree, "--config", sandboxConfigPath(entry.dir)];
	if (opts.noDaemon) args.push("--no-daemon");
	if (opts.readOnly) args.push("--read-only");

	const transport = new StdioClientTransport({
		command: chhoundBinary(),
		args,
		cwd: entry.meta.worktree,
		env: { ...process.env, ...(chhoundApiKeyEnv(opts.apiKey) ?? {}) } as Record<string, string>,
		stderr: "pipe",
	});
	transport.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) console.error(`[chhound-mcp:${id}] ${text}`);
	});

	const client = new Client({ name: "pi-chhound", version: "0.1.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
	} catch (e) {
		await transport.close().catch(() => undefined);
		throw new Error(`could not start 'chunkhound mcp' (${args.join(" ")}): ${(e as Error).message}`);
	}

	const prefix = mcpToolPrefix(entry.meta.worktree, opts.prefix);
	const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
	const toolNames: string[] = [];
	for (const tool of listed.tools ?? []) {
		const piName = `${prefix}_${tool.name}`;
		registerBridgeTool(pi, id, piName, tool);
		toolNames.push(piName);
	}

	const conn: McpConnection = {
		id,
		worktree: entry.meta.worktree,
		prefix,
		client,
		transport,
		toolNames,
		connectedAt: new Date().toISOString(),
	};
	connections.set(id, conn);
	return conn;
}

export async function disconnectMcp(id: string): Promise<void> {
	const conn = connections.get(id);
	if (!conn) throw new Error(`not connected: ${id}`);
	connections.delete(id);
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
	await Promise.allSettled([...connections.keys()].map((id) => disconnectMcp(id)));
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
