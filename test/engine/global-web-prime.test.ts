import { describe, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chhoundBinary } from "../../chhound/cli.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Engine tier: exercises the REAL default prime path (a real chunkhound RW
// handshake that lets the engine create the shared DuckDB) plus a REAL
// read-only runtime open. Obligations: the prime must claim the SAME indexed
// root the runtime opens from (the engine refuses the DB otherwise — the old
// disposable temp cwd stamped a deleted root), the priming scan must never
// index the API-key-bearing config, priming must not acquire a watchman
// runtime, and a pre-fix stale claim must be rebuilt under the global root.
// The command-tier backend suite injects primeDatabase, so only this file can
// catch a broken priming implementation. No network/LLM calls: provider config
// is dummy keys, the runtime open is read-only.

const SETTINGS = {
	version: 1,
	// VoyageAI is the engine-supported rerank path without a base_url.
	embedding: { provider: "voyageai", model: "voyage-3", rerankModel: "rerank-2", apiKey: "dummy-emb-secret" },
	llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "dummy-llm-secret" },
};

/** Fake home with global web settings + the engine binary resolved pre-isolation. */
async function withGlobalWebFixture(body: (home: string) => Promise<void>): Promise<void> {
	const env = snapshotEnv();
	const root = await makeFixtureRoot("pi-chhound-global-web-prime-");
	try {
		const home = await makeFakeHome(root);
		await fs.mkdir(path.join(home, ".pi", "agent", "pi-chhound"), { recursive: true });
		await fs.writeFile(path.join(home, ".pi", "agent", "pi-chhound", "settings.json"), JSON.stringify(SETTINGS));
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: engine.binary } }));
		await body(home);
	} finally {
		applyEnv(env);
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function loadManager() {
	return (await import("../../mcp/global-web.js")) as {
		createGlobalWebManager: (options?: unknown) => { execute: (name: string, input: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> };
	};
}

/** Fake runtime spawn: records specs, never starts a second real server. */
function fakeRuntime(spawns: Array<{ args: readonly string[]; cwd: string }>) {
	return {
		async spawnServer(spec: { args: readonly string[]; cwd: string }) {
			spawns.push(spec);
			return {
				client: { async callTool() { throw new Error("PRIME-TEST fake transport reached"); }, async close() { /* closed by manager */ } },
				child: { kill() { return true; } },
			};
		},
	};
}

/** Open the primed DB with the REAL read-only server under the global root. */
async function openRuntime(globalDir: string): Promise<{ ok: boolean; error: string }> {
	const transport = new StdioClientTransport({
		command: chhoundBinary(),
		args: ["mcp", "--no-daemon", "--read-only", "--config", path.join(globalDir, ".chunkhound.json")],
		cwd: globalDir,
		env: process.env as Record<string, string>,
		stderr: "pipe",
	});
	const client = new Client({ name: "pi-chhound-prime-test", version: "0.0.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { timeout: 30_000 });
		return { ok: true, error: "" };
	} catch (error) {
		return { ok: false, error: String(error) };
	} finally {
		await client.close().catch(() => undefined);
	}
}

describe("shared global web backend prime", () => {
	test("default prime opens under the runtime root (claim, no leaks, no watchman)", async (t) => {
		await withGlobalWebFixture(async (home) => {
			const { createGlobalWebManager } = await loadManager();
			const spawns: Array<{ args: readonly string[]; cwd: string }> = [];
			const manager = createGlobalWebManager(fakeRuntime(spawns));
			let callError = "";
			try { await manager.execute("fetchurl", { url: "http://127.0.0.1:1/never" }); } catch (e) { callError = String(e); }
			await manager.close();

			const globalDir = path.join(home, ".local", "state", "pi-chhound", "global");
			const dbPath = path.join(globalDir, "web.duckdb");
			const header = await fs.open(dbPath, "r").then(async (fh) => {
				try {
					const b = Buffer.alloc(12);
					await fh.read(b, 0, 12, 0);
					return b.subarray(8, 12).toString("ascii");
				} finally { await fh.close(); }
			});
			await check(t, "prime created a valid DuckDB at the shared path", header === "DUCK", header);
			// Regression: priming used a disposable temp cwd, so the engine stamped
			// the sidecar with that deleted root and every runtime open under the
			// global dir was refused (DuckDBIndexedRootMismatchError).
			const sidecar = JSON.parse(await fs.readFile(`${dbPath}.root.json`, "utf8")) as { indexed_root_path?: string };
			await check(t, "prime claims the same root the runtime opens from", sidecar.indexed_root_path === globalDir, String(sidecar.indexed_root_path));
			const bytes = await fs.readFile(dbPath);
			await check(
				t,
				"priming scan never indexed the API-key-bearing config",
				!bytes.includes("dummy-emb-secret") && !bytes.includes("dummy-llm-secret"),
				"API key found in the primed DB",
			);
			const artifacts = await fs.readdir(globalDir);
			await check(t, "priming acquired no watchman runtime", !artifacts.includes(".chunkhound"), artifacts.join(", "));
			const config = JSON.parse(await fs.readFile(path.join(globalDir, ".chunkhound.json"), "utf8")) as { llm?: { model?: string }; embedding?: { model?: string } };
			await check(t, "config materialized from global settings only", config.llm?.model === "gpt-4o-mini" && config.embedding?.model === "voyage-3");
			await check(t, "exactly one read-only no-daemon spawn after priming", spawns.length === 1 && spawns[0]!.args.includes("--no-daemon") && spawns[0]!.args.includes("--read-only"), JSON.stringify(spawns));
			await check(t, "spawn cwd is the global state dir", spawns[0]!.cwd === globalDir, spawns[0]!.cwd);
			await check(t, "fake transport reached after successful prime", callError.includes("PRIME-TEST fake transport reached"), callError);
			const opened = await openRuntime(globalDir);
			await check(t, "the REAL runtime read-only server opens the primed DB", opened.ok, opened.error);
			const afterOpen = await fs.readdir(globalDir);
			await check(t, "read-only runtime acquires no watchman runtime", !afterOpen.includes(".chunkhound"), afterOpen.join(", "));
		});
	});

	test("stale temp-root claim (pre-fix cache) is rebuilt under the global root", async (t) => {
		await withGlobalWebFixture(async (home) => {
			const { createGlobalWebManager } = await loadManager();
			const spawns: Array<{ args: readonly string[]; cwd: string }> = [];
			const manager = createGlobalWebManager(fakeRuntime(spawns));
			await manager.execute("fetchurl", { url: "http://127.0.0.1:1/never" }).catch(() => undefined);
			await manager.close();
			const globalDir = path.join(home, ".local", "state", "pi-chhound", "global");
			const dbPath = path.join(globalDir, "web.duckdb");
			// Simulate a cache primed by the pre-fix code: the sidecar points at a
			// disposable temp root that no longer exists, so opens are refused.
			await fs.writeFile(`${dbPath}.root.json`, JSON.stringify({ version: 1, indexed_root_path: "/tmp/pi-chhound-global-prime-defunct" }));

			const rebuilt = createGlobalWebManager(fakeRuntime(spawns));
			await rebuilt.execute("fetchurl", { url: "http://127.0.0.1:1/never" }).catch(() => undefined);
			await rebuilt.close();

			const sidecar = JSON.parse(await fs.readFile(`${dbPath}.root.json`, "utf8")) as { indexed_root_path?: string };
			await check(t, "stale claim was rebuilt under the global root", sidecar.indexed_root_path === globalDir, String(sidecar.indexed_root_path));
			const opened = await openRuntime(globalDir);
			await check(t, "the rebuilt cache opens with the real runtime server", opened.ok, opened.error);
		});
	});

	test("symlinked XDG_STATE_HOME: the canonical claim is reused without re-priming", async (t) => {
		await withGlobalWebFixture(async (home) => {
			const { createGlobalWebManager } = await loadManager();
			// A symlinked state home is the regression: the engine resolves
			// target_dir (symlinks included) before claiming, so the manager must
			// compare the claim against the canonical root — a lexical comparison
			// rebuilds a valid cache on every session.
			const realState = path.join(home, "real-state");
			await fs.mkdir(realState, { recursive: true });
			const linkState = path.join(home, "state-link");
			await fs.symlink(realState, linkState, "dir");
			process.env.XDG_STATE_HOME = linkState;
			const globalDir = path.join(linkState, "pi-chhound", "global");
			const dbPath = path.join(globalDir, "web.duckdb");

			// First call: the REAL prime creates the DB; the engine stamps the claim.
			const spawns: Array<{ args: readonly string[]; cwd: string }> = [];
			const first = createGlobalWebManager(fakeRuntime(spawns));
			await first.execute("fetchurl", { url: "http://127.0.0.1:1/never" }).catch(() => undefined);
			await first.close();
			const sidecar = JSON.parse(await fs.readFile(`${dbPath}.root.json`, "utf8")) as { indexed_root_path?: string };
			const canonical = (await fs.realpath(globalDir)).split(path.sep).join("/");
			await check(t, "the engine stamps the canonical (realpath) root, not the symlink form", sidecar.indexed_root_path === canonical, String(sidecar.indexed_root_path));

			// Second call: reuse must not rebuild the DB. A rebuild deletes and
			// recreates the file (new inode); reuse leaves it untouched.
			const before = await fs.stat(dbPath);
			const second = createGlobalWebManager(fakeRuntime(spawns));
			await second.execute("fetchurl", { url: "http://127.0.0.1:1/never" }).catch(() => undefined);
			await second.close();
			const after = await fs.stat(dbPath);
			await check(t, "valid symlinked-XDG cache is reused (no re-prime)", before.ino === after.ino && before.mtimeMs === after.mtimeMs, `ino ${before.ino}->${after.ino}, mtime ${before.mtimeMs}->${after.mtimeMs}`);
			await check(t, "the engine claim is unchanged after reuse", (JSON.parse(await fs.readFile(`${dbPath}.root.json`, "utf8")) as { indexed_root_path?: string }).indexed_root_path === canonical);
		});
	});
});
