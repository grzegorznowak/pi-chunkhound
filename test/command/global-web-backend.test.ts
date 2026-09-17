import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
		onclose?: () => void;
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

const GLOBAL_WEB_SETTINGS = {
	version: 1 as const,
	embedding: { provider: "global-embedding-provider", model: "global-embedding-model", rerankModel: "global-reranker" },
	llm: { provider: "global-llm-provider", model: "global-llm-model" },
};

/** The shared dir the manager resolves from XDG_STATE_HOME. */
function globalStateDir(): string {
	return path.join(process.env.XDG_STATE_HOME!, "pi-chhound", "global");
}

async function fileExists(p: string): Promise<boolean> {
	try { await fs.stat(p); return true; } catch { return false; }
}

/** The canonical root the engine itself stamps into the claim sidecar. */
async function canonicalRoot(dir: string): Promise<string> {
	return (await fs.realpath(dir)).split(path.sep).join("/");
}

/** Seed a web-cache state: valid fixture DB or corrupt bytes, claim, wal. */
async function seedCache(databasePath: string, claim: string | null | undefined, options: { validDb: boolean; wal?: boolean }): Promise<void> {
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	await fs.writeFile(databasePath, options.validDb ? await fs.readFile(EMPTY_DUCKDB_FIXTURE) : Buffer.from("not a duckdb file"));
	if (claim !== undefined) await fs.writeFile(`${databasePath}.root.json`, claim === null ? "{ not a duckdb claim" : JSON.stringify({ version: 1, indexed_root_path: claim }));
	if (options.wal) await fs.writeFile(`${databasePath}.wal`, "wal-fixture");
}

type FakeBackend = {
	spawns: SpawnSpec[];
	handles: ServerHandle[];
	requests: McpRequest[];
	primeCalls: number;
	/** Per-call hook; unset returns a successful fixture result. */
	callTool?: (request: McpRequest) => unknown;
	spawnServer(spec: SpawnSpec): Promise<ServerHandle>;
	primeDatabase(databasePath: string): Promise<void>;
};

/** Injected runtime transport: records spawns/handles/requests, never starts a process. */
function fakeBackend(): FakeBackend {
	const backend: FakeBackend = {
		spawns: [],
		handles: [],
		requests: [],
		primeCalls: 0,
		async primeDatabase(databasePath) {
			backend.primeCalls++;
			await fs.mkdir(path.dirname(databasePath), { recursive: true });
			await fs.copyFile(EMPTY_DUCKDB_FIXTURE, databasePath);
		},
		async spawnServer(spec) {
			backend.spawns.push(spec);
			const handle: ServerHandle = {
				client: {
					async callTool(request) {
						backend.requests.push(request);
						const hook = backend.callTool;
						if (hook) return await hook(request);
						return { content: [{ type: "text", text: `fixture ${request.name}` }] };
					},
					async close() { /* closed by the manager */ },
				},
				child: { kill() { return true; } },
			};
			backend.handles.push(handle);
			return handle;
		},
	};
	return backend;
}

/** The default prime path spawns a real engine; the harness points CHHOUND_BINARY at a missing file. */
const ENGINE_UNAVAILABLE = "could not start shared chunkhound web MCP server";

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
				Boolean(outcome.error.includes("/ch-setup") && /global/i.test(outcome.error) && /llm|embedding|provider|model|configure/i.test(outcome.error)),
				outcome.error || JSON.stringify(outcome.result),
			);
		}
		await check(t, "configuration error never primes or spawns", spawns === 0 && primes === 0, `spawns=${spawns} primes=${primes}`);
	}));

	test("cache identity: a missing or corrupt DB with a stale claim is cleaned and regenerated", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const globalDir = globalStateDir();
		const databasePath = path.join(globalDir, "web.duckdb");
		const claimPath = `${databasePath}.root.json`;
		const walPath = `${databasePath}.wal`;

		// Corrupt DB + a claim for a different root + a leftover wal: the claim is
		// disposable on its own, so priming must not wedge on it.
		await seedCache(databasePath, "/some/other/root", { validDb: false, wal: true });
		const corrupt = fakeBackend();
		const corruptManager = mod.createGlobalWebManager({ spawnServer: corrupt.spawnServer });
		let corruptError = "";
		try { await corruptManager.execute("websearch", { query: "fixture" }); } catch (error) { corruptError = String(error); }
		await corruptManager.close();
		await check(t, "corrupt DB: regeneration is attempted through the engine prime", corruptError.includes(ENGINE_UNAVAILABLE), corruptError);
		await check(t, "corrupt DB: db, claim and wal are all removed before regeneration", !(await fileExists(databasePath)) && !(await fileExists(claimPath)) && !(await fileExists(walPath)));
		await check(t, "corrupt DB: the runtime spawn is never reached", corrupt.spawns.length === 0, `spawns=${corrupt.spawns.length}`);

		// Missing DB + a malformed (non-JSON) claim: the engine fails closed on the
		// sidecar alone, so the stale sidecar must be removed even without a DB.
		await fs.rm(globalDir, { recursive: true, force: true });
		await fs.mkdir(globalDir, { recursive: true });
		await fs.writeFile(claimPath, "{ not json");
		const malformed = fakeBackend();
		const malformedManager = mod.createGlobalWebManager({ spawnServer: malformed.spawnServer });
		let malformedError = "";
		try { await malformedManager.execute("websearch", { query: "fixture" }); } catch (error) { malformedError = String(error); }
		await malformedManager.close();
		await check(t, "missing DB: malformed claim forces regeneration", malformedError.includes(ENGINE_UNAVAILABLE), malformedError);
		await check(t, "missing DB: the malformed claim is removed", !(await fileExists(claimPath)));
		await check(t, "missing DB: the runtime spawn is never reached", malformed.spawns.length === 0, `spawns=${malformed.spawns.length}`);
	}));

	test("cache identity: a valid matching cache is reused and an absent-claim legacy cache is preserved", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const globalDir = globalStateDir();
		const databasePath = path.join(globalDir, "web.duckdb");
		const claimPath = `${databasePath}.root.json`;

		// Matching claim: the engine stamped the canonical root, so the cache is
		// valid and must be reused without deleting/re-priming it.
		await seedCache(databasePath, "placeholder", { validDb: true, wal: true });
		await fs.writeFile(claimPath, JSON.stringify({ version: 1, indexed_root_path: await canonicalRoot(globalDir) }));
		const matching = fakeBackend();
		const matchingManager = mod.createGlobalWebManager({ spawnServer: matching.spawnServer });
		const matchingResult = await matchingManager.execute("fetchurl", { url: "https://example.invalid/fixture" });
		await check(t, "matching cache: call reaches the runtime on the existing DB", matchingResult.content[0]?.text === "fixture fetchurl" && matching.spawns.length === 1, matchingResult.content[0]?.text ?? "no result");
		await check(t, "matching cache: claim and wal are left untouched", await fileExists(claimPath) && await fileExists(`${databasePath}.wal`));
		await matchingManager.close();

		// Legacy cache: a valid DB with no sidecar at all must also be preserved
		// (the engine treats a missing sidecar as a legacy DB and allows the open).
		await fs.rm(globalDir, { recursive: true, force: true });
		await seedCache(databasePath, undefined, { validDb: true });
		const legacy = fakeBackend();
		const legacyManager = mod.createGlobalWebManager({ spawnServer: legacy.spawnServer });
		const legacyResult = await legacyManager.execute("fetchurl", { url: "https://example.invalid/fixture" });
		await check(t, "absent-claim legacy cache: preserved and reused", legacyResult.content[0]?.text === "fixture fetchurl" && legacy.spawns.length === 1 && !(await fileExists(claimPath)), legacyResult.content[0]?.text ?? "no result");
		await legacyManager.close();
	}));

	test("cache identity: a symlinked XDG_STATE_HOME compares the claim against the realpath root", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const realState = path.join(h.ctx.cwd, "real-state");
		const linkState = path.join(h.ctx.cwd, "state-link");
		await fs.mkdir(realState, { recursive: true });
		await fs.symlink(realState, linkState, "dir");
		process.env.XDG_STATE_HOME = linkState;
		const globalDir = globalStateDir();
		const databasePath = path.join(globalDir, "web.duckdb");
		const claimPath = `${databasePath}.root.json`;

		// The engine resolves target_dir (symlinks included) before claiming, so a
		// canonical claim must match even though the manager's dir path is lexical.
		await seedCache(databasePath, "placeholder", { validDb: true, wal: true });
		const canonical = await canonicalRoot(globalDir);
		await fs.writeFile(claimPath, JSON.stringify({ version: 1, indexed_root_path: canonical }));
		const matching = fakeBackend();
		const matchingManager = mod.createGlobalWebManager({ spawnServer: matching.spawnServer });
		let matchingError = "";
		let matchingText = "";
		try { matchingText = (await matchingManager.execute("fetchurl", { url: "https://example.invalid/fixture" })).content[0]?.text ?? ""; } catch (error) { matchingError = String(error); }
		await check(t, "canonical claim under a symlinked state home: reused, no re-prime", matchingError === "" && matchingText === "fixture fetchurl" && matching.spawns.length === 1, matchingError || `text=${matchingText} spawns=${matching.spawns.length}`);
		await check(t, "canonical claim: cache artifacts untouched", await fileExists(claimPath) && await fileExists(`${databasePath}.wal`));
		await matchingManager.close();

		// A lexical (symlink-form) claim is what the engine would refuse — it
		// canonicalizes the root — so the disposable cache must be rebuilt.
		await seedCache(databasePath, path.resolve(globalDir), { validDb: true, wal: true });
		const lexical = fakeBackend();
		const lexicalManager = mod.createGlobalWebManager({ spawnServer: lexical.spawnServer });
		let lexicalError = "";
		try { await lexicalManager.execute("fetchurl", { url: "https://example.invalid/fixture" }); } catch (error) { lexicalError = String(error); }
		await lexicalManager.close();
		await check(t, "lexical claim: regeneration is attempted (engine unavailable)", lexicalError.includes(ENGINE_UNAVAILABLE), lexicalError);
		await check(t, "lexical claim: db, claim and wal are cleaned", !(await fileExists(databasePath)) && !(await fileExists(claimPath)) && !(await fileExists(`${databasePath}.wal`)));
		await check(t, "lexical claim: no runtime spawn before a successful prime", lexical.spawns.length === 0, `spawns=${lexical.spawns.length}`);
	}));

	test("dead shared server: client close clears the stale handle so the next call respawns once", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const backend = fakeBackend();
		const manager = mod.createGlobalWebManager({ spawnServer: backend.spawnServer, primeDatabase: backend.primeDatabase });

		await manager.execute("websearch", { query: "first" });
		await check(t, "first call spawns one server and makes one request", backend.spawns.length === 1 && backend.requests.length === 1, `spawns=${backend.spawns.length} requests=${backend.requests.length}`);
		const deadClose = backend.handles[0]!.client.onclose;
		await check(t, "the manager installs an SDK close hook on the live client", typeof deadClose === "function");

		// Unexpected death: the SDK Client fires its own close callback.
		deadClose?.();
		const second = await manager.execute("websearch", { query: "after death" });
		await check(t, "the next call respawns exactly once and serves the request", backend.spawns.length === 2 && backend.requests.length === 2 && second.content[0]?.text === "fixture websearch", second.content[0]?.text ?? `spawns=${backend.spawns.length}`);

		// A late close from the dead server must not clear the replacement.
		deadClose?.();
		const third = await manager.execute("websearch", { query: "third" });
		await check(t, "a late close from the dead server cannot invalidate the replacement", backend.spawns.length === 2 && backend.requests.length === 3 && third.content[0]?.text === "fixture websearch", `spawns=${backend.spawns.length} requests=${backend.requests.length}`);
		await manager.close();
	}));

	test("cache identity: an unreadable claim sidecar is not treated as absent", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const globalDir = globalStateDir();
		const databasePath = path.join(globalDir, "web.duckdb");
		const claimPath = `${databasePath}.root.json`;
		await seedCache(databasePath, undefined, { validDb: true });
		// Self-referential symlink: readFile fails with ELOOP — the sidecar is
		// present but unreadable, which is not the legacy "no claim" case.
		await fs.rm(claimPath, { force: true });
		await fs.symlink(claimPath, claimPath);
		const backend = fakeBackend();
		const manager = mod.createGlobalWebManager({ spawnServer: backend.spawnServer });
		let error = "";
		try { await manager.execute("websearch", { query: "fixture" }); } catch (cause) { error = String(cause); }
		await manager.close();
		await check(t, "unreadable claim forces regeneration through the prime", error.includes(ENGINE_UNAVAILABLE), error);
		await check(t, "unreadable claim is cleared for regeneration", !(await fileExists(claimPath)));
		await check(t, "the runtime spawn is never reached", backend.spawns.length === 0, `spawns=${backend.spawns.length}`);
	}));

	test("dead shared server: a close during startup is never published and the next call retries", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const backend = fakeBackend();
		let connects = 0;
		const connect = t.mock.method(Client.prototype, "connect", async function (this: Client) {
			connects += 1;
			if (connects === 1) this.onclose?.(); // child dies during the handshake
		});
		const callTool = t.mock.method(Client.prototype, "callTool", (async () => ({ content: [{ type: "text", text: "fixture websearch" }] })) as unknown as typeof Client.prototype.callTool);
		try {
			const manager = mod.createGlobalWebManager({ primeDatabase: backend.primeDatabase });
			let error = "";
			try { await manager.execute("websearch", { query: "first" }); } catch (cause) { error = String(cause); }
			await check(t, "a startup death fails the call instead of publishing a corpse", error.includes("died during startup"), error);
			const result = await manager.execute("websearch", { query: "retry" });
			await check(t, "the next call retries through a fresh spawn and succeeds", result.content[0]?.text === "fixture websearch" && connects === 2, `connects=${connects} text=${result.content[0]?.text}`);
			await manager.close();
		} finally {
			connect.mock.restore();
			callTool.mock.restore();
		}
	}));

	test("shared server: tool-level failures never invalidate or respawn the live server", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const backend = fakeBackend();
		const manager = mod.createGlobalWebManager({ spawnServer: backend.spawnServer, primeDatabase: backend.primeDatabase });

		// MCP error RESULT: a tool failure, not a dead server.
		backend.callTool = () => ({ isError: true, content: [{ type: "text", text: "Search failed: rate limited" }] });
		let resultError = "";
		try { await manager.execute("websearch", { query: "boom" }); } catch (error) { resultError = String(error); }
		await check(t, "an MCP error result surfaces to the caller", resultError.includes("rate limited"), resultError);
		await check(t, "an MCP error result keeps the same live server", backend.spawns.length === 1 && backend.handles.length === 1, `spawns=${backend.spawns.length}`);

		// Thrown request error: still a live client (e.g. timeout), no respawn.
		backend.callTool = () => { throw new Error("request timed out"); };
		let thrownError = "";
		try { await manager.execute("websearch", { query: "boom again" }); } catch (error) { thrownError = String(error); }
		await check(t, "a thrown request error surfaces to the caller", thrownError.includes("request timed out"), thrownError);
		await check(t, "a thrown request error does not respawn", backend.spawns.length === 1, `spawns=${backend.spawns.length}`);

		backend.callTool = undefined;
		const recovered = await manager.execute("websearch", { query: "ok" });
		await check(t, "the same warm server serves the next call", recovered.content[0]?.text === "fixture websearch" && backend.spawns.length === 1 && backend.requests.length === 3, `spawns=${backend.spawns.length} requests=${backend.requests.length}`);
		await manager.close();
	}));

	test("shared server: shutdown wins over a late client close", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const backend = fakeBackend();
		const manager = mod.createGlobalWebManager({ spawnServer: backend.spawnServer, primeDatabase: backend.primeDatabase });

		await manager.execute("websearch", { query: "first" });
		const lateClose = backend.handles[0]!.client.onclose;
		await manager.close();
		lateClose?.();
		let shutdownError = "";
		try { await manager.execute("websearch", { query: "after shutdown" }); } catch (error) { shutdownError = String(error); }
		await check(t, "execute after shutdown reports the closed server", shutdownError.includes("closed"), shutdownError);
		await check(t, "a late close neither respawns nor touches the backend again", backend.spawns.length === 1 && backend.requests.length === 1, `spawns=${backend.spawns.length} requests=${backend.requests.length}`);
	}));

	test("startup single-flight: concurrent first calls share one prime and one spawn", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		const backend = fakeBackend();
		let spawns = 0;
		let releaseSpawn: (() => void) | undefined;
		const manager = mod.createGlobalWebManager({
			async primeDatabase(databasePath) {
				await backend.primeDatabase(databasePath);
			},
			spawnServer(spec) {
				spawns++;
				backend.spawns.push(spec);
				// Deferred resolution: both first calls must join this ONE startup.
				return new Promise<ServerHandle>((resolve) => {
					releaseSpawn = () => resolve({
						client: {
							async callTool(request) {
								backend.requests.push(request);
								return { content: [{ type: "text", text: `fixture ${request.name}` }] };
							},
							async close() { /* closed by the manager */ },
						},
						child: { kill() { return true; } },
					});
				});
			},
		});

		const first = manager.execute("websearch", { query: "first" });
		const second = manager.execute("fetchurl", { url: "https://example.invalid/fixture" });
		const spawnDeadline = Date.now() + 5_000;
		while (spawns === 0 && Date.now() < spawnDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
		await check(t, "both first calls joined one pending startup", spawns === 1 && backend.primeCalls === 1 && releaseSpawn !== undefined, `spawns=${spawns} primes=${backend.primeCalls}`);
		releaseSpawn?.();
		const [a, b] = await Promise.all([first, second]);
		await check(t, "both calls succeed on the single warm server", a.content[0]?.text === "fixture websearch" && b.content[0]?.text === "fixture fetchurl", JSON.stringify([a.content[0]?.text, b.content[0]?.text]));
		await check(t, "exactly one spawn served both requests", spawns === 1 && backend.requests.map((r) => r.name).join(",") === "websearch,fetchurl", backend.requests.map((r) => r.name).join(","));
		await manager.close();
	}));

	test("startup failure is retryable: a rejecting prime or spawn never wedges the manager", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");

		// Prime rejects once: the call fails, the next one primes again.
		const backend = fakeBackend();
		let primes = 0;
		let spawns = 0;
		const manager = mod.createGlobalWebManager({
			async primeDatabase(databasePath) {
				if (++primes === 1) throw new Error("prime boom");
				await backend.primeDatabase(databasePath);
			},
			async spawnServer(spec) { spawns++; return backend.spawnServer(spec); },
		});
		let primeError = "";
		try { await manager.execute("websearch", { query: "one" }); } catch (error) { primeError = String(error); }
		await check(t, "a failed prime fails the call without spawning", primeError.includes("prime boom") && spawns === 0, primeError || `spawns=${spawns}`);
		const afterPrime = await manager.execute("websearch", { query: "two" });
		await check(t, "the next call primes again and spawns", afterPrime.content[0]?.text === "fixture websearch" && primes === 2 && spawns === 1, `primes=${primes} spawns=${spawns}`);
		await manager.close();

		// Spawn rejects once: the call fails, the next one spawns a fresh server.
		const backend2 = fakeBackend();
		let spawns2 = 0;
		const manager2 = mod.createGlobalWebManager({
			primeDatabase: backend2.primeDatabase,
			async spawnServer(spec) {
				spawns2++;
				if (spawns2 === 1) throw new Error("spawn boom");
				return backend2.spawnServer(spec);
			},
		});
		let spawnError = "";
		try { await manager2.execute("fetchurl", { url: "https://example.invalid/fixture" }); } catch (error) { spawnError = String(error); }
		await check(t, "a failed spawn fails the call", spawnError.includes("spawn boom") && spawns2 === 1, spawnError);
		const afterSpawn = await manager2.execute("fetchurl", { url: "https://example.invalid/fixture" });
		await check(t, "the next call spawns again and succeeds", afterSpawn.content[0]?.text === "fixture fetchurl" && spawns2 === 2 && backend2.requests.length === 1, `spawns=${spawns2} requests=${backend2.requests.length}`);
		await manager2.close();
	}));

	test("shutdown during startup closes the resolving runtime and publishes nothing", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		let clientCloses = 0;
		let childKills = 0;
		let spawns = 0;
		let requests = 0;
		let releaseSpawn: (() => void) | undefined;
		const manager = mod.createGlobalWebManager({
			async primeDatabase() { /* ready immediately */ },
			spawnServer() {
				spawns++;
				// Pending startup: the handle only exists once the test resolves it.
				return new Promise<ServerHandle>((resolve) => {
					releaseSpawn = () => resolve({
						client: {
							async callTool() { requests++; return {}; },
							async close() { clientCloses++; },
						},
						child: { kill() { childKills++; return true; } },
					});
				});
			},
		});

		const pending = manager.execute("websearch", { query: "during startup" }).then(() => "resolved", (error) => String(error));
		await new Promise((resolve) => setImmediate(resolve));
		await manager.close();
		await check(t, "close while the spawn is pending reaches no runtime and opens no new startup", spawns === 1 && requests === 0, `spawns=${spawns} requests=${requests}`);
		releaseSpawn?.();
		const outcome = await pending;
		await check(t, "the in-flight call fails as closed during startup", outcome.includes("closed during startup"), outcome);
		await check(t, "the resolved handle is closed and killed, never published", clientCloses === 1 && childKills === 1, `closes=${clientCloses} kills=${childKills}`);
		const later = await manager.execute("fetchurl", { url: "https://example.invalid/fixture" }).then(() => "resolved", (error) => String(error));
		await check(t, "later calls report the manager closed and spawn nothing new", later.includes("is closed") && spawns === 1, later);
	}));

	test("execute forwards the call signal and a pi-shaped progress bridge to the SDK client", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		saveSettings(GLOBAL_WEB_SETTINGS, "global");
		type CallOptions = { signal?: AbortSignal; onprogress?: (progress: unknown) => void };
		let seen: CallOptions | undefined;
		let requestName = "";
		const manager = mod.createGlobalWebManager({
			async primeDatabase() { /* ready immediately */ },
			async spawnServer() {
				return {
					client: {
						async callTool(request, _schema?: unknown, options?: CallOptions) {
							requestName = request.name;
							seen = options;
							return { content: [{ type: "text", text: `fixture ${request.name}` }] };
						},
						async close() { /* closed by the manager */ },
					},
					child: { kill() { return true; } },
				};
			},
		});

		const signal = new AbortController().signal;
		const updates: ToolResult[] = [];
		const result = await manager.execute("websearch", { query: "forwarded" }, signal, (update) => updates.push(update));
		await check(t, "the SDK request keeps the tool name", requestName === "websearch", requestName);
		await check(t, "the caller's abort signal is forwarded to client.callTool", seen?.signal === signal);
		await check(t, "an onprogress handler is installed on the request", typeof seen?.onprogress === "function");
		await check(t, "no progress update is fabricated before the server reports", updates.length === 0);
		const progress = { progress: 2, total: 5, message: "searching" };
		seen!.onprogress!(progress);
		await check(
			t,
			"progress reaches onUpdate as a pi-shaped partial",
			updates.length === 1
				&& updates[0]!.content[0]?.text === `websearch/fetchurl progress: ${JSON.stringify(progress)}`
				&& (updates[0]!.details as { progress?: unknown }).progress === progress,
			JSON.stringify(updates[0]),
		);
		await check(t, "the call result itself is untouched by the progress bridge", result.content[0]?.text === "fixture websearch");

		// A call without an onUpdate consumer: progress must be a silent no-op.
		seen = undefined;
		await manager.execute("fetchurl", { url: "https://example.invalid/fixture" }, undefined, undefined);
		seen!.onprogress?.({ progress: 1 });
		await check(t, "progress without a consumer is a no-op", updates.length === 1, `updates=${updates.length}`);
		await manager.close();
	}));

	test("project-only provider settings never satisfy the shared backend (global-only, no fallback)", async (t) => withPiHarness(async (h) => {
		const mod = await loadGlobalWeb(t);
		if (!mod) return;
		// Global has no providers; the project overlay is fully configured. The
		// shared backend reads GLOBAL settings only, so the overlay must not
		// satisfy it and there is no fallback to the project-scoped config.
		saveSettings({ version: 1 }, "global");
		saveSettings(
			{
				version: 1,
				embedding: { provider: "project-embedding-provider", model: "project-embedding-model", rerankModel: "project-reranker" },
				llm: { provider: "project-llm-provider", model: "project-llm-model" },
			},
			"project",
			h.ctx.cwd,
		);
		const backend = fakeBackend();
		const manager = mod.createGlobalWebManager({ spawnServer: backend.spawnServer, primeDatabase: backend.primeDatabase });
		for (const name of ["websearch", "fetchurl"] as const) {
			const outcome = await manager
				.execute(name, name === "websearch" ? { query: "fixture" } : { url: "https://example.invalid/fixture" })
				.then(() => "", (error) => String(error));
			await check(
				t,
				`${name} fails with the global setup error instead of using the project overlay`,
				outcome.includes("Global websearch/fetchurl") && outcome.includes("/ch-setup"),
				outcome,
			);
		}
		await check(t, "a project-only config never primes or spawns the shared server", backend.primeCalls === 0 && backend.spawns.length === 0, `primes=${backend.primeCalls} spawns=${backend.spawns.length}`);
		await manager.close();
	}));
});
