import { describe, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Engine tier: exercises the REAL default prime path (a real chunkhound RW
// handshake that lets the engine create the shared DuckDB). The command-tier
// backend suite injects primeDatabase, so only this file can catch a broken
// priming implementation. Transport is faked after priming — no network/LLM
// calls and no orphaned read-only server.
describe("shared global web backend prime", () => {
	test("default prime creates a valid DuckDB via a real MCP handshake and cleans up", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-global-web-prime-");
		try {
			const home = await makeFakeHome(root);
			await fs.mkdir(path.join(home, ".pi", "agent", "pi-chhound"), { recursive: true });
			await fs.mkdir(path.join(home, "tmp"), { recursive: true });
			await fs.writeFile(
				path.join(home, ".pi", "agent", "pi-chhound", "settings.json"),
				JSON.stringify({
					version: 1,
					// VoyageAI is the engine-supported rerank path without a base_url.
					embedding: { provider: "voyageai", model: "voyage-3", rerankModel: "rerank-2", apiKey: "dummy-emb" },
					llm: { provider: "openai", model: "gpt-4o-mini", apiKey: "dummy-llm" },
				}),
			);
			applyEnv(isolatedEnv({ home }));

			const { createGlobalWebManager } = (await import("../../mcp/global-web.js")) as {
				createGlobalWebManager: (options?: unknown) => { execute: (name: string, input: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> };
			};
			const specs: Array<{ args: readonly string[]; cwd: string }> = [];
			const manager = createGlobalWebManager({
				async spawnServer(spec: { args: readonly string[]; cwd: string }) {
					specs.push(spec);
					return {
						client: { async callTool() { throw new Error("PRIME-TEST fake transport reached"); }, async close() { /* closed by manager */ } },
						child: { kill() { return true; } },
					};
				},
			});
			let callError = "";
			try { await manager.execute("fetchurl", { url: "http://127.0.0.1:1/never" }); } catch (e) { callError = String(e); }
			await manager.close();

			const globalDir = path.join(home, ".local", "state", "pi-chhound", "global");
			const header = await fs.open(path.join(globalDir, "web.duckdb"), "r").then(async (fh) => {
				try {
					const b = Buffer.alloc(12);
					await fh.read(b, 0, 12, 0);
					return b.subarray(8, 12).toString("ascii");
				} finally { await fh.close(); }
			});
			await check(t, "prime created a valid DuckDB at the shared path", header === "DUCK", header);
			const config = JSON.parse(await fs.readFile(path.join(globalDir, ".chunkhound.json"), "utf8")) as { llm?: { model?: string }; embedding?: { model?: string } };
			await check(t, "config materialized from global settings only", config.llm?.model === "gpt-4o-mini" && config.embedding?.model === "voyage-3");
			await check(t, "exactly one read-only no-daemon spawn after priming", specs.length === 1 && specs[0]!.args.includes("--no-daemon") && specs[0]!.args.includes("--read-only"), JSON.stringify(specs));
			await check(t, "spawn cwd is the global state dir", specs[0]!.cwd === globalDir, specs[0]!.cwd);
			await check(t, "fake transport reached after successful prime", callError.includes("PRIME-TEST fake transport reached"), callError);
			const leftovers = (await fs.readdir(path.join(home, "tmp"))).filter((name) => name.startsWith("pi-chhound-global-prime-"));
			await check(t, "prime scratch dirs are cleaned up", leftovers.length === 0, leftovers.join(", "));
		} finally {
			applyEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
