import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listSandboxes } from "../../../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../../../chhound/types.js";
import { connectMcp, disconnectMcp, listMcpConnections } from "../../../../mcp/manager.js";
import { check } from "../../lib/checks.js";
import { resolveEngineBinary } from "../../lib/engine.js";
import { buildIndexedSandbox } from "../../lib/fixtures.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../../lib/isolation.js";

// Inventory: 2 legacy checks moved from smoke.ts section 5b (mcp bridge
// integration) — unexpected daemon death (SIGKILL of the transport/proxy):
// the registry entry must drop on its own via client.onclose cleanup, so
// tools, /ch-status and the footer never report a corpse and the next
// session's auto-restore does not skip it as "already live". SELF-OWNED
// fixture (lib/fixtures buildIndexedSandbox); the live protocol/replay
// checks moved to engine/mcp-bridge.test.ts.

const waitFor = async (fn: () => boolean, ms: number) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (fn()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return fn();
};

describe("mcp death", () => {
	test("legacy SIGKILL registry-drop obligation", async (tc) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-robustness-mcp-death-");
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
			const daemonRuntime = path.join(root, "daemon-runtime");
			fs.mkdirSync(daemonRuntime, { recursive: true });
			process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = daemonRuntime;
			const { sandboxDir } = await buildIndexedSandbox({ root, settings, extraArgs: ["--no-embeddings"] });
			const projectHash = createHash("sha256").update(path.resolve(sandboxDir)).digest("hex").slice(0, 16);
			lockFile = path.join(daemonRuntime, "daemon-locks", `${projectHash}.json`);

			const capturePi = (into: Map<string, unknown>) =>
				({ registerTool(t: { name: string }) { into.set(t.name, t); } }) as unknown as ExtensionAPI;
			const api = new Map<string, unknown>();
			const entry = listSandboxes(settings)[0]!;
			const connKilled = await connectMcp(capturePi(api), entry, { extraArgs: ["--no-embeddings"] });
			await check(tc, "death: reconnect registers a fresh entry", listMcpConnections().some((c) => c.id === connKilled.id));
			const pid3 = connKilled.transport.pid;
			if (pid3 !== null) process.kill(pid3, "SIGKILL");
			await check(
				tc,
				"death: SIGKILLed daemon drops from the registry",
				await waitFor(() => !listMcpConnections().some((c) => c.id === connKilled.id), 10_000),
				listMcpConnections().map((c) => c.id).join(",") || "(registry empty)",
			);
		} finally {
			// Tear down whatever is still open (normal path already dropped the
			// entry via client.onclose after the SIGKILL): disconnect any registry
			// leftovers, then wait for the daemon lock to disappear before env
			// restore + root removal.
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
