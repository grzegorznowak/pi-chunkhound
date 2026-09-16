import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { saveSettings } from "../../chhound/settings.js";
import { check } from "../lib/checks.js";
import { fireSessionShutdown, withPiHarness } from "../lib/pi-harness.js";

const EMPTY_DUCKDB_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/empty.duckdb");
type WebToolName = "websearch" | "fetchurl";
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown };
type SpawnSpec = { command: string; args: readonly string[]; cwd: string; env?: Record<string, string> };
type McpRequest = { name: string; arguments: Record<string, unknown> };
type ServerHandle = {
	client: {
		callTool(request: McpRequest, options?: { signal?: AbortSignal; onProgress?: (progress: unknown) => void }): Promise<unknown>;
		close(): Promise<void>;
	};
	child: { kill(signal?: NodeJS.Signals | number): boolean | void };
};
type GlobalWebManagerOptions = {
	spawnServer: (spec: SpawnSpec) => Promise<ServerHandle>;
	primeDatabase: (databasePath: string) => Promise<void>;
};
type GlobalWebManager = {
	execute(name: WebToolName, input: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void): Promise<ToolResult>;
	close(): Promise<void>;
};
type GlobalWebModule = {
	createGlobalWebManager(options?: Partial<GlobalWebManagerOptions>): GlobalWebManager;
	registerGlobalWebTools(pi: ExtensionAPI, manager: GlobalWebManager): void;
};

async function loadGlobalWeb(t: TestContext): Promise<GlobalWebModule | undefined> {
	let loaded: GlobalWebModule | undefined;
	let error = "";
	try {
		loaded = await import("../../mcp/global-web.js") as unknown as GlobalWebModule;
	} catch (cause) {
		error = String(cause);
	}
	await check(t, "mcp/global-web.ts exports the shared-backend seam", loaded !== undefined, error);
	return loaded;
}

async function executeTool(tool: { execute: (...args: any[]) => Promise<ToolResult> }, input: Record<string, unknown>, ctx: any): Promise<{ result?: ToolResult; error: string }> {
	try {
		return { result: await tool.execute("fixture-call", input, new AbortController().signal, undefined, ctx), error: "" };
	} catch (error) {
		return { error: String(error) };
	}
}

function configPathFrom(spec: SpawnSpec): string | undefined {
	const index = spec.args.indexOf("--config");
	return index >= 0 ? spec.args[index + 1] : undefined;
}

describe("shared global web MCP backend seam (initially RED)", () => {
	test("lazy spawn uses one warm read-only global server and shutdown closes it", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;

		// A project/sandbox-scoped setting is a canary: the global backend must
		// ignore it even though tool execution receives this cwd in its context.
		saveSettings({
			version: 1,
			embedding: { provider: "global-embedding-provider", model: "global-embedding-model", rerankModel: "global-reranker" },
			llm: { provider: "global-llm-provider", model: "global-llm-model" },
		}, "global");
		saveSettings({
			version: 1,
			embedding: { provider: "PROJECT-MUST-NOT-APPEAR", model: "project-embedding" },
			llm: { provider: "PROJECT-MUST-NOT-APPEAR", model: "project-llm" },
		}, "project", h.ctx.cwd);

		let primerCalls = 0;
		let primerFinished = false;
		let clientCloses = 0;
		let childKills = 0;
		const requests: McpRequest[] = [];
		const spawns: SpawnSpec[] = [];
		let spawnSawReadyFiles = false;
		let spawnedConfig: Record<string, any> | undefined;
		let spawnedDatabasePath: string | undefined;
		let spawnedDatabaseHasDuckDbHeader = false;
		const handle: ServerHandle = {
			client: {
				async callTool(request) {
					requests.push(request);
					return { content: [{ type: "text", text: `fixture ${request.name}` }] };
				},
				async close() { clientCloses++; },
			},
			child: { kill() { childKills++; return true; } },
		};
		const manager = mod.createGlobalWebManager({
			async primeDatabase(databasePath) {
				primerCalls++;
				await fs.mkdir(path.dirname(databasePath), { recursive: true });
				await fs.copyFile(EMPTY_DUCKDB_FIXTURE, databasePath);
				primerFinished = true;
			},
			async spawnServer(spec) {
				spawns.push(spec);
				try {
					const configPath = configPathFrom(spec);
					if (!configPath) return handle;
					spawnedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
					spawnedDatabasePath = spawnedConfig?.database?.path;
					const db = spawnedDatabasePath ? await fs.readFile(spawnedDatabasePath) : Buffer.alloc(0);
					spawnedDatabaseHasDuckDbHeader = db.length === 12_288 && db.subarray(8, 12).toString("ascii") === "DUCK";
					spawnSawReadyFiles = primerFinished && Boolean(spawnedConfig) && spawnedDatabaseHasDuckDbHeader;
				} catch {
					spawnSawReadyFiles = false;
				}
				return handle;
			},
		});
		mod.registerGlobalWebTools(h.pi, manager);

		await check(t, "registration is lazy: no spawn or database prime", spawns.length === 0 && primerCalls === 0);
		const websearch = h.tools.get("websearch");
		const fetchurl = h.tools.get("fetchurl");
		await check(t, "registration exposes both standalone names", Boolean(websearch && fetchurl));
		if (!websearch || !fetchurl) return;

		const first = await executeTool(websearch, { query: "fixture query" }, h.ctx);
		await check(t, "first call reaches the fake backend", first.error === "" && requests[0]?.name === "websearch", first.error);
		const second = await executeTool(fetchurl, { url: "https://example.invalid/fixture" }, h.ctx);
		await check(t, "second tool reuses the same warm server", second.error === "" && requests[1]?.name === "fetchurl" && spawns.length === 1, second.error || `spawns=${spawns.length}`);
		await check(t, "empty DuckDB is primed exactly once before spawn", primerCalls === 1 && spawnSawReadyFiles, `primerCalls=${primerCalls} ready=${spawnSawReadyFiles}`);

		const spec = spawns[0];
		const expectedGlobalDir = path.join(process.env.XDG_STATE_HOME!, "pi-chhound", "global");
		await check(
			t,
			"spawn is an MCP server in no-daemon read-only mode with an explicit config",
			Boolean(spec?.args.includes("mcp") && spec.args.includes("--no-daemon") && spec.args.includes("--read-only") && configPathFrom(spec)),
			spec?.args.join(" ") ?? "no spawn",
		);
		await check(t, "spawn cwd is the global pi-chhound state directory", spec?.cwd === expectedGlobalDir, spec?.cwd ?? "no spawn");
		await check(
			t,
			"config database.path is the existing primed DuckDB under global state",
			spawnedDatabaseHasDuckDbHeader && Boolean(spawnedDatabasePath?.startsWith(`${expectedGlobalDir}${path.sep}`)),
			spawnedDatabasePath ?? "missing database.path",
		);
		const serializedConfig = JSON.stringify(spawnedConfig);
		await check(
			t,
			"materialized config uses distinctive GLOBAL provider/model only",
			serializedConfig.includes("global-llm-provider")
				&& serializedConfig.includes("global-llm-model")
				&& serializedConfig.includes("global-embedding-provider")
				&& !serializedConfig.includes("PROJECT-MUST-NOT-APPEAR"),
			serializedConfig,
		);

		await fireSessionShutdown(h);
		await check(t, "session_shutdown closes the client and kills the child once", clientCloses === 1 && childKills === 1, `close=${clientCloses} kill=${childKills}`);
	}));

	test("missing LLM/embedding config remains registered but fails before spawn with setup remedy", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		let spawns = 0;
		let primes = 0;
		const manager = mod.createGlobalWebManager({
			async primeDatabase() { primes++; },
			async spawnServer() {
				spawns++;
				return {
					client: { async callTool() { return {}; }, async close() {} },
					child: { kill() { return true; } },
				};
			},
		});
		mod.registerGlobalWebTools(h.pi, manager);
		await check(t, "both tools register without provider settings", ["websearch", "fetchurl"].every((name) => h.tools.has(name)));
		for (const name of ["websearch", "fetchurl"] as const) {
			const tool = h.tools.get(name);
			if (!tool) continue;
			const outcome = await executeTool(tool, name === "websearch" ? { query: "fixture" } : { url: "https://example.invalid" }, h.ctx);
			await check(
				t,
				`${name} returns an actionable setup error`,
				Boolean(outcome.error.includes("/ch-setup") && /llm|embedding|provider|model|configure/i.test(outcome.error)),
				outcome.error || JSON.stringify(outcome.result),
			);
		}
		await check(t, "configuration error never primes or spawns", spawns === 0 && primes === 0, `spawns=${spawns} primes=${primes}`);
	}));
});
