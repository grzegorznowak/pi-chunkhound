import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chhoundBinary } from "../../chhound/cli.js";
import { listSandboxes, readClaimedRoot } from "../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { connectMcp, disconnectMcp, listMcpConnections, reRegisterBridgeTools } from "../../mcp/manager.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { buildIndexedSandbox } from "../lib/fixtures.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 16 legacy checks moved from smoke.ts section 5b (mcp bridge
// integration) — the live stdio protocol (--no-daemon single-process server,
// default daemonized proxy+daemon with lock/daemon.log/root-claim lifecycle)
// and connectMcp + per-session bridge-tool replay (registration, replay into a
// fresh api, live call, disconnect guard, no-op replay). SELF-OWNED fixture
// (lib/fixtures buildIndexedSandbox). The SIGKILL death cluster moved to
// robustness/engine/mcp-death.test.ts; pure prefix/status/footer text to
// unit/mcp-view.test.ts; target/picker view to fs/sandbox-catalog.test.ts;
// config refresh to fs/config.test.ts.

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitFor = async (fn: () => boolean, ms: number) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return fn();
};

describe("mcp bridge", () => {
	test("legacy mcp bridge protocol + replay obligations", async (tc) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-mcp-bridge-");
		// Lifecycle handles hoisted so the finally below can tear down whatever
		// this scenario had opened when an infrastructure failure interrupts it.
		const openClients: Array<{ close: () => Promise<void> }> = [];
		let cleanupLock: string | undefined;
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: engine.binary } }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
				// Materialized engine configs force watchman by default; the
				// config file wins over the env var, so polling is set in the
				// settings the configs are materialized from.
				indexing: { realtimeBackend: "polling" },
			};
			const daemonRuntime = path.join(root, "daemon-runtime");
			fs.mkdirSync(daemonRuntime, { recursive: true });
			const mcpEnv = { ...process.env, CHUNKHOUND_DAEMON_RUNTIME_DIR: daemonRuntime } as Record<string, string>;
			const { sandboxDir, wt, dbDir, configPath } = await buildIndexedSandbox({ root, settings, extraArgs: ["--no-embeddings"] });

			// --no-daemon: single-process server; must exit when stdin closes.
			const t1 = new StdioClientTransport({
				command: chhoundBinary(),
				args: ["mcp", sandboxDir, "--config", configPath, "--no-daemon", "--no-embeddings"],
				cwd: sandboxDir,
				env: mcpEnv,
				stderr: "pipe",
			});
			const c1 = new Client({ name: "pi-chhound-smoke", version: "0.0.0" }, { capabilities: {} });
			openClients.push({ close: () => c1.close() });
			t1.stderr?.on("data", (d: Buffer) => console.log(`    [mcp-stderr] ${d.toString("utf8").trimEnd()}`));
			await c1.connect(t1, { timeout: 30_000 });
			const listed = await c1.listTools();
			await check(
				tc,
				"mcp: tools listed (no-daemon)",
				listed.tools.some((t) => t.name === "daemon_status") && listed.tools.some((t) => t.name === "search"),
				listed.tools.map((t) => t.name).join(","),
			);
			const st1 = await c1.callTool({ name: "daemon_status", arguments: {} });
			await check(tc, "mcp: daemon_status callable", JSON.stringify(st1).includes("query_ready"), JSON.stringify(st1).slice(0, 160));
			const pid1 = t1.pid;
			await c1.close();
			await check(tc, "mcp: child exits on close (no-daemon)", await waitFor(() => pid1 !== null && !isAlive(pid1), 10_000), `pid=${pid1}`);

			// Default daemonized mode: stdio proxy + background daemon. The daemon
			// must shut itself down (delay 0) once the client disconnects.
			const projectHash = createHash("sha256").update(path.resolve(sandboxDir)).digest("hex").slice(0, 16);
			const lockFile = path.join(daemonRuntime, "daemon-locks", `${projectHash}.json`);
			cleanupLock = lockFile;
			const t2 = new StdioClientTransport({
				command: chhoundBinary(),
				args: ["mcp", sandboxDir, "--config", configPath, "--no-embeddings"],
				cwd: sandboxDir,
				env: mcpEnv,
				stderr: "pipe",
			});
			const c2 = new Client({ name: "pi-chhound-smoke", version: "0.0.0" }, { capabilities: {} });
			openClients.push({ close: () => c2.close() });
			t2.stderr?.on("data", (d: Buffer) => console.log(`    [mcp-stderr] ${d.toString("utf8").trimEnd()}`));
			await c2.connect(t2, { timeout: 30_000 });
			const st2 = await c2.callTool({ name: "daemon_status", arguments: {} });
			await check(tc, "mcp: daemonized mode callable", JSON.stringify(st2).includes("query_ready"));
			await check(tc, "mcp: daemon lock registered", await waitFor(() => fs.existsSync(lockFile), 10_000), lockFile);
			// Design 1 core claim: daemon state lands in the SANDBOX dir, never in the
			// checkout — daemon.log, and the root-claim sidecar (indexed root = sandbox).
			await check(
				tc,
				"mcp: daemon.log lands in the sandbox dir",
				await waitFor(() => fs.existsSync(path.join(sandboxDir, ".chunkhound", "daemon.log")), 15_000),
				sandboxDir,
			);
			await check(tc, "mcp: no .chunkhound in the worktree", !fs.existsSync(path.join(wt, ".chunkhound")), "found .chunkhound in checkout");
			await check(
				tc,
				"mcp: daemon claims the sandbox dir as indexed root",
				await waitFor(() => readClaimedRoot(dbDir) === sandboxDir, 15_000),
				readClaimedRoot(dbDir) ?? "unclaimed",
			);
			const pid2 = t2.pid;
			await c2.close();
			await check(tc, "mcp: proxy exits on close (daemonized)", await waitFor(() => pid2 !== null && !isAlive(pid2), 10_000), `pid=${pid2}`);
			await check(tc, "mcp: daemon self-shutdown removes lock", await waitFor(() => !fs.existsSync(lockFile), 15_000), lockFile);

			// connectMcp + per-session replay: a child session re-runs the extension
			// factory, so bridge tools registered at runtime in the parent's api must
			// be re-registerable into a fresh api from the stored connection state.
			const capturePi = (into: Map<string, unknown>) =>
				({ registerTool(t: { name: string }) { into.set(t.name, t); } }) as unknown as ExtensionAPI;
			const firstApi = new Map<string, unknown>();
			process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = daemonRuntime;
			const entry = listSandboxes(settings)[0]!;
			const conn = await connectMcp(capturePi(firstApi), entry, { extraArgs: ["--no-embeddings"] });
			const expected = conn.toolNames;
			await check(
				tc,
				"mcp: connectMcp registers bridge tools into session api",
				expected.length > 0 && expected.every((n) => firstApi.has(n)),
				expected.join(","),
			);
			await check(tc, "mcp: connection stores replayable tool metadata", conn.tools.length === expected.length && conn.tools.every((t) => typeof t.name === "string"));
			const childApi = new Map<string, unknown>();
			reRegisterBridgeTools(capturePi(childApi), [conn]);
			await check(
				tc,
				"mcp: bridge tools replay into a fresh (child) session api",
				expected.length > 0 && expected.every((n) => childApi.has(n)),
				[...childApi.keys()].join(",") || "(none)",
			);
			// A replayed definition must be a live bridge: same closures, same registry.
			const daemonTool = [...childApi.entries()].find(([n]) => n.endsWith("_daemon_status"))?.[1] as
				| {
						execute: (...args: unknown[]) => Promise<unknown>;
				  }
				| undefined;
			const stBridge = daemonTool ? await daemonTool.execute("call-1", {}, undefined, undefined) : undefined;
			await check(
				tc,
				"bridge: replayed tool calls the live server",
				typeof stBridge === "object" && JSON.stringify(stBridge).includes("query_ready"),
				JSON.stringify(stBridge)?.slice(0, 160) ?? "(no daemon_status tool)",
			);
			await disconnectMcp(conn.id);
			delete process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR;
			// After disconnect the same replayed definition must fail with the clear
			// reconnect error (registry entry gone) — the child-facing behavior.
			const guardMessage = daemonTool
				? await (async () => {
						try {
							await daemonTool.execute("call-2", {}, undefined, undefined);
							return "no-throw";
						} catch (e) {
							return (e as Error).message;
						}
					})()
				: "(no daemon_status tool)";
			await check(tc, "bridge: replayed execute guards disconnected registry", guardMessage.includes("not connected"), guardMessage);
			const afterDisconnect = new Map<string, unknown>();
			reRegisterBridgeTools(capturePi(afterDisconnect));
			await check(tc, "bridge: no live connections → replay is a no-op", afterDisconnect.size === 0, `registered ${afterDisconnect.size}`);
		} finally {
			// Tear down whatever is still open (normal path already closed/disconnected
			// everything; this covers infrastructure failures): close raw SDK clients,
			// disconnect registry entries (proxy close → daemon self-shutdown), then
			// wait for the daemon lock to disappear before env restore + root removal.
			for (const client of openClients) {
				await client.close().catch(() => undefined);
			}
			for (const c of listMcpConnections()) {
				await disconnectMcp(c.id).catch(() => undefined);
			}
			if (cleanupLock) {
				const lf = cleanupLock;
				await waitFor(() => !fs.existsSync(lf), 15_000);
			}
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
