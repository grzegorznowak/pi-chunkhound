import * as fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chhoundBinary } from "../chhound/cli.js";
import { materializeConfig } from "../chhound/config.js";
import { xdgStateHome, PKG_DIR_NAME } from "../chhound/paths.js";
import { loadSettings } from "../chhound/settings.js";
import type { ChhoundSettings } from "../chhound/types.js";

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

/**
 * Cache-artifact patterns for the shared global dir: the priming scan must
 * never index the config (it carries provider API keys), the DuckDB files, or
 * engine logs.
 */
const WEB_CACHE_EXCLUDES = ["**/.chunkhound.json", ".chunkhound.json", "**/*.duckdb", "**/*.duckdb.*", "**/*.log"];

/** Create the shared DB once, under the same indexed root the runtime uses. */
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

/** The engine's own root normalization for the sidecar (`Path.absolute()` + posix). */
function engineRoot(p: string): string {
	return path.resolve(p).split(path.sep).join("/");
}

/**
 * Root recorded in the DuckDB root-claim sidecar: a string when valid,
 * undefined when the sidecar is absent (the engine treats that as a legacy DB
 * and allows the open), null when present but malformed (the engine fails
 * closed; our disposable web cache may rebuild instead).
 */
async function readClaimedRoot(databasePath: string): Promise<string | null | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(`${databasePath}.root.json`, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { indexed_root_path?: unknown };
		return typeof parsed.indexed_root_path === "string" ? parsed.indexed_root_path : null;
	} catch {
		return null;
	}
}

async function defaultPrimeDatabase(databasePath: string): Promise<void> {
	const dir = path.dirname(databasePath);
	if (await hasDuckDbHeader(databasePath)) {
		const claimed = await readClaimedRoot(databasePath);
		if (claimed === undefined || claimed === engineRoot(dir)) return;
		// Pre-fix caches were primed from a disposable temp cwd, so the engine
		// stamped that (now deleted) root and every open under the global dir is
		// refused. A web cache is disposable — rebuild it under the right root.
		await fs.rm(databasePath, { force: true });
		await fs.rm(`${databasePath}.root.json`, { force: true });
		await fs.rm(`${databasePath}.wal`, { force: true });
	}
	await fs.mkdir(dir, { recursive: true });
	const settings = loadSettings().settings;
	// Prime under the SAME indexed root the runtime server opens from: the
	// engine stamps the DB's root-claim from the server's project dir, so
	// priming anywhere else (the old temp cwd) makes the DB unopenable later.
	// Polling avoids acquiring a watchman runtime for a throwaway primer, and
	// the cache excludes keep this dir's own artifacts out of the index.
	const priming: ChhoundSettings = { ...settings, indexing: { ...settings.indexing, realtimeBackend: "polling" } };
	const config = materializeConfig(dir, { settings: priming, dbDir: databasePath, extraExcludes: WEB_CACHE_EXCLUDES });
	// The engine connects (and auto-creates) the DB from a deferred background
	// task kicked off by the MCP initialize handshake — so prime through a real
	// client that keeps the session open until the DuckDB file exists.
	const handle = await defaultSpawnServer({ command: chhoundBinary(), args: ["mcp", "--no-daemon", "--config", config], cwd: dir, env: process.env as Record<string, string> });
	try {
		const deadline = Date.now() + 30_000;
		while (!(await hasDuckDbHeader(databasePath)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	} finally {
		await handle.client.close().catch(() => undefined);
		try { handle.child.kill("SIGTERM"); } catch { /* already gone */ }
	}
	if (!(await hasDuckDbHeader(databasePath))) throw new Error("could not prime the shared web database: invalid DuckDB header");
}

export function createGlobalWebManager(options: Options = {}): GlobalWebManager {
	const spawnServer = options.spawnServer ?? defaultSpawnServer;
	const primeDatabase = options.primeDatabase ?? defaultPrimeDatabase;
	let handle: ServerHandle | undefined;
	let starting: Promise<ServerHandle> | undefined;
	let closed = false;
	async function server(): Promise<ServerHandle> {
		if (closed) throw new Error("shared websearch/fetchurl server is closed");
		if (handle) return handle;
		if (!configured()) throw setupError();
		if (!starting) starting = (async () => {
			const dir = globalDir();
			const databasePath = path.join(dir, "web.duckdb");
			await primeDatabase(databasePath);
			const configPath = materializeConfig(dir, { settings: loadSettings().settings, dbDir: databasePath, extraExcludes: WEB_CACHE_EXCLUDES });
			const next = await spawnServer({ command: chhoundBinary(), args: ["mcp", "--no-daemon", "--read-only", "--config", configPath], cwd: dir, env: process.env as Record<string, string> });
			// Shutdown can land while the first spawn is in flight; never leave an
			// orphan holding the stdio pipes.
			if (closed) {
				await next.client.close().catch(() => undefined);
				try { next.child.kill("SIGTERM"); } catch { /* already gone */ }
				throw new Error("shared websearch/fetchurl server closed during startup");
			}
			handle = next;
			return next;
		})();
		try { return await starting; } finally { if (!handle) starting = undefined; }
	}
	return {
		async execute(name, input, signal, onUpdate) {
			const result = await (await server()).client.callTool({ name, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, onprogress: (progress: unknown) => onUpdate?.({ content: [{ type: "text", text: `websearch/fetchurl progress: ${JSON.stringify(progress)}` }], details: { progress } }) });
			if (!result || typeof result !== "object") return { content: [{ type: "text", text: String(result) }], details: { mcp: result } };
			const mcp = result as { isError?: boolean; content?: ToolResult["content"] };
			if (mcp.isError) throw new Error(mcp.content?.map((part) => part.text ?? "").join("\n") || "shared web MCP tool failed");
			return { content: Array.isArray(mcp.content) ? mcp.content : [{ type: "text", text: JSON.stringify(result) }], details: { mcp: result } };
		},
		async close() {
			closed = true;
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
