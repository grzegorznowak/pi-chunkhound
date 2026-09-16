import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chhoundBinary } from "../chhound/cli.js";
import { materializeConfig } from "../chhound/config.js";
import { xdgStateHome, PKG_DIR_NAME } from "../chhound/paths.js";
import { loadSettings } from "../chhound/settings.js";

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 600_000;
type WebToolName = "websearch" | "fetchurl";
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
export type SpawnSpec = { command: string; args: readonly string[]; cwd: string; env?: Record<string, string> };
type ServerHandle = {
	client: { callTool(request: { name: string; arguments: Record<string, unknown> }, options?: unknown, extra?: unknown): Promise<unknown>; close(): Promise<void> };
	child: { kill(signal?: NodeJS.Signals | number): boolean | void };
};
type Options = Partial<{
	spawnServer(spec: SpawnSpec): Promise<ServerHandle>;
	primeDatabase(databasePath: string): Promise<void>;
}>;
export interface GlobalWebManager {
	execute(name: WebToolName, input: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void): Promise<ToolResult>;
	close(): Promise<void>;
}

function globalDir(): string {
	return path.join(xdgStateHome(), PKG_DIR_NAME, "global");
}

function configured(): boolean {
	const settings = loadSettings().settings;
	return Boolean(settings.llm?.provider && settings.llm?.model && settings.embedding?.provider && settings.embedding?.model && settings.embedding?.rerankModel);
}

function setupError(): Error {
	return new Error("Global websearch/fetchurl requires configured LLM and embedding provider/model (including reranker). Run /ch-setup to configure them.");
}

async function defaultSpawnServer(spec: SpawnSpec): Promise<ServerHandle> {
	const transport = new StdioClientTransport({ command: spec.command, args: [...spec.args], cwd: spec.cwd, env: spec.env, stderr: "pipe" });
	transport.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) console.error(`[chhound-global-web] ${text}`);
	});
	const client = new Client({ name: "pi-chhound", version: "0.1.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
	} catch (cause) {
		await transport.close().catch(() => undefined);
		throw new Error(`could not start shared chunkhound web MCP server: ${(cause as Error).message}`);
	}
	return {
		client,
		child: { kill(signal) { const pid = transport.pid; return pid === null ? false : (() => { try { process.kill(pid, signal); return true; } catch { return false; } })() } },
	};
}

/** Create the empty shared DB once, from a disposable RW server cwd. */
async function hasDuckDbHeader(databasePath: string): Promise<boolean> {
	try {
		const file = await fs.open(databasePath, "r");
		try {
			const b = Buffer.alloc(12);
			await file.read(b, 0, b.length, 0);
			return b.subarray(8, 12).toString("ascii") === "DUCK";
		} finally { await file.close(); }
	} catch { return false; }
}

async function defaultPrimeDatabase(databasePath: string): Promise<void> {
	if (await hasDuckDbHeader(databasePath)) return;
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chhound-global-prime-"));
	try {
		const settings = loadSettings().settings;
		const config = materializeConfig(temp, { settings, dbDir: databasePath });
		const child = spawn(chhoundBinary(), ["mcp", "--no-daemon", "--config", config], { cwd: temp, stdio: "ignore" });
		let exited = false;
		let spawnError: Error | undefined;
		child.once("exit", () => { exited = true; });
		child.once("error", (error) => { spawnError = error; exited = true; });
		const deadline = Date.now() + 15_000;
		while (!exited && !(await hasDuckDbHeader(databasePath)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (!exited) {
			child.kill("SIGTERM");
			while (!exited) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (spawnError) throw spawnError;
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
	if (!(await hasDuckDbHeader(databasePath))) throw new Error("could not prime the shared web database: invalid DuckDB header");
}

export function createGlobalWebManager(options: Options = {}): GlobalWebManager {
	const spawnServer = options.spawnServer ?? defaultSpawnServer;
	const primeDatabase = options.primeDatabase ?? defaultPrimeDatabase;
	let handle: ServerHandle | undefined;
	let starting: Promise<ServerHandle> | undefined;
	async function server(): Promise<ServerHandle> {
		if (handle) return handle;
		if (!configured()) throw setupError();
		if (!starting) starting = (async () => {
			const dir = globalDir();
			const databasePath = path.join(dir, "web.duckdb");
			await primeDatabase(databasePath);
			const configPath = materializeConfig(dir, { settings: loadSettings().settings, dbDir: databasePath });
			const next = await spawnServer({ command: chhoundBinary(), args: ["mcp", "--no-daemon", "--read-only", "--config", configPath], cwd: dir, env: process.env as Record<string, string> });
			handle = next;
			return next;
		})();
		try { return await starting; } finally { if (!handle) starting = undefined; }
	}
	return {
		async execute(name, input, signal, onUpdate) {
			const result = await (await server()).client.callTool({ name, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, onprogress: onUpdate });
			if (!result || typeof result !== "object") return { content: [{ type: "text", text: String(result) }], details: { mcp: result } };
			const mcp = result as { isError?: boolean; content?: ToolResult["content"] };
			if (mcp.isError) throw new Error(mcp.content?.map((part) => part.text ?? "").join("\n") || "shared web MCP tool failed");
			return { content: Array.isArray(mcp.content) ? mcp.content : [{ type: "text", text: JSON.stringify(result) }], details: { mcp: result } };
		},
		async close() {
			const current = handle;
			handle = undefined;
			starting = undefined;
			if (!current) return;
			await current.client.close().catch(() => undefined);
			try { current.child.kill("SIGTERM"); } catch { /* already gone */ }
		},
	};
}

const registered = new WeakSet<object>();
export function registerGlobalWebTools(pi: ExtensionAPI, manager: GlobalWebManager): void {
	if (registered.has(pi as object)) return;
	registered.add(pi as object);
	const register = (name: WebToolName, description: string, parameters: unknown) => pi.registerTool({
		name, label: name, description, parameters: parameters as any, executionMode: "parallel",
		execute: (_id, input, signal, onUpdate) => manager.execute(name, input as Record<string, unknown>, signal, onUpdate as ((result: ToolResult) => void) | undefined),
	});
	register("websearch", "Search the web, fetch top results, and synthesize a cited answer.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), previous_query: Type.Optional(Type.String()) }));
	register("fetchurl", "Fetch one URL and return a Markdown answer, optionally focused by query.", Type.Object({ url: Type.String(), query: Type.Optional(Type.String()) }));
	pi.on("session_shutdown", () => manager.close());
}
