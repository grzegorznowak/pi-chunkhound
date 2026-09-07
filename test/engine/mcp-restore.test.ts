import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChhoundSettings } from "../../chhound/types.js";
import { disconnectMcp, listMcpConnections } from "../../mcp/manager.js";
import { CONNECTION_ENTRY_TYPE, recordConnection, rehydrateConnections, restoreConnections } from "../../mcp/persist.js";
import type { ConnectionRecord } from "../../mcp/persist.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { buildIndexedSandbox } from "../lib/fixtures.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 5 legacy checks moved from smoke.ts section 5c (mcp persistence +
// auto-restore) — the real auto-restore against an engine-indexed fixture
// sandbox: connect, unknown-sandbox tombstone, already-live skip,
// disconnected-only no-op and autoReconnect-off no-op. SELF-OWNED fixture
// (lib/fixtures buildIndexedSandbox) — the legacy section reused the shared
// sandbox primed by sections 1+3. Recording checks:
// command/setup-settings.test.ts; pure rehydrate:
// unit/connection-records.test.ts.

const fakeEntry = (customType: string, data: unknown): SessionEntry =>
	({ type: "custom", customType, data, id: "e", parentId: "p", timestamp: "t" }) as unknown as SessionEntry;

describe("mcp restore", () => {
	test("legacy auto-restore obligations", async (tc) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-mcp-restore-");
		let lockFile: string | undefined;
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
			const runtime = path.join(root, "mcp-runtime");
			fs.mkdirSync(runtime, { recursive: true });
			process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = runtime;
			const { sandboxDir } = await buildIndexedSandbox({ root, settings, extraArgs: ["--no-embeddings"] });
			const projectHash = createHash("sha256").update(path.resolve(sandboxDir)).digest("hex").slice(0, 16);
			lockFile = path.join(runtime, "daemon-locks", `${projectHash}.json`);

			// Auto-restore against the REAL fixture sandbox (daemonized).
			const entryLog: Array<{ type: string; data: unknown }> = [];
			const persistPi = {
				registerTool(_t: { name: string }) {
					/* connectMcp needs a registerTool surface */
				},
				appendEntry(type: string, data: unknown) {
					entryLog.push({ type, data });
				},
			} as unknown as ExtensionAPI;
			const realId = path.basename(sandboxDir);
			const realRecord = new Map<string, ConnectionRecord>();
			realRecord.set(realId, { sandboxId: realId, state: "connected" });
			realRecord.set("ghost-sandbox", { sandboxId: "ghost-sandbox", state: "connected" });
			await restoreConnections(persistPi, settings, realRecord, { extraArgs: ["--no-embeddings"] });
			await check(
				tc,
				"persist: restore connects recorded sandbox",
				listMcpConnections().some((c) => c.id === realId),
				listMcpConnections().map((c) => c.id).join(",") || "(none)",
			);
			await check(
				tc,
				"persist: unknown sandbox forgotten (tombstone)",
				entryLog.some((e) => {
					const d = e.data as Record<string, unknown>;
					return d.sandboxId === "ghost-sandbox" && d.state === "disconnected";
				}),
				JSON.stringify(entryLog),
			);
			const liveCount = listMcpConnections().length;
			await restoreConnections(persistPi, settings, realRecord, { extraArgs: ["--no-embeddings"] });
			await check(tc, "persist: restore skips already-live connections", listMcpConnections().length === liveCount);
			await disconnectMcp(realId);

			const tombstoneOnly = rehydrateConnections([
				fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: realId, state: "disconnected" }),
			]);
			await restoreConnections(persistPi, settings, tombstoneOnly, { extraArgs: ["--no-embeddings"] });
			await check(tc, "persist: disconnected-only records → no connect", listMcpConnections().length === 0);

			const logLen = entryLog.length;
			await restoreConnections(persistPi, { ...settings, autoReconnect: false }, realRecord, {
				extraArgs: ["--no-embeddings"],
			});
			await check(
				tc,
				"persist: autoReconnect off → no restore, no records",
				listMcpConnections().length === 0 && entryLog.length === logLen,
				`conns=${listMcpConnections().length} newEntries=${entryLog.length - logLen}`,
			);
		} finally {
			// Tear down whatever is still open (normal path already disconnected
			// the restored sandbox): disconnect any registry leftovers, then wait
			// for the daemon lock to disappear before env restore + root removal.
			for (const c of listMcpConnections()) {
				await disconnectMcp(c.id).catch(() => undefined);
			}
			if (lockFile) {
				const lf = lockFile;
				await waitFor(() => !fs.existsSync(lf), 10_000);
			}
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

const waitFor = async (fn: () => boolean, ms: number) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return fn();
};
