import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../../chhound/settings.js";
import { CONNECTION_ENTRY_TYPE, recordConnection } from "../../mcp/persist.js";
import { registerSetupCommand } from "../../setup/command.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 6 legacy checks moved from smoke.ts section 5c (mcp persistence +
// auto-restore) — the recordConnection-via-fake-appendEntry obligations
// (command boundary: observable adapter callbacks, no fs/registry) and the
// /ch-setup --auto-reconnect flag handler under an isolated HOME. Pure
// rehydrate checks moved to unit/connection-records.test.ts; the real engine
// restore to engine/mcp-restore.test.ts.

describe("setup settings", () => {
	test("legacy persistence recording + auto-reconnect obligations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-command-setup-settings-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			// Recording via the fake ExtensionAPI appendEntry surface — the
			// in-memory session log is the observable state.
			const entryLog: Array<{ type: string; data: unknown }> = [];
			const persistPi = {
				registerTool(_t: { name: string }) {
					/* connectMcp needs a registerTool surface */
				},
				appendEntry(type: string, data: unknown) {
					entryLog.push({ type, data });
				},
			} as unknown as ExtensionAPI;
			recordConnection(persistPi, { sandboxId: "sb-1", state: "connected" });
			recordConnection(persistPi, { sandboxId: "sb-1", state: "disconnected", prefix: "mine" });
			await check(
				t,
				"persist: records appended to session log",
				entryLog.length === 2 && entryLog.every((e) => e.type === CONNECTION_ENTRY_TYPE),
				JSON.stringify(entryLog),
			);
			const first = entryLog[0]!.data as Record<string, unknown>;
			await check(
				t,
				"persist: record shape (version/sandboxId/state)",
				first.version === 1 && first.sandboxId === "sb-1" && first.state === "connected",
				JSON.stringify(entryLog[0]),
			);
			const second = entryLog[1]!.data as Record<string, unknown>;
			await check(t, "persist: prefix recorded when set", second.prefix === "mine", JSON.stringify(entryLog[1]));

			// /ch-setup --auto-reconnect flag (isolated HOME — never touches real
			// settings/sandboxes/baselines).
			const setupProj = path.join(root, "setup-proj");
			fs.mkdirSync(path.join(setupProj, ".pi", "pi-chhound"), { recursive: true });
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			const setupPi = {
				registerCommand(_name: string, def: { handler: typeof handler }) {
					handler = def.handler;
				},
			} as unknown as ExtensionAPI;
			registerSetupCommand(setupPi, {});
			const notices: string[] = [];
			const setupCtx = {
				cwd: setupProj,
				mode: "print",
				hasUI: false,
				ui: { notify: (m: string) => notices.push(m) },
			};
			await handler!("--project --auto-reconnect off", setupCtx as never);
			await check(
				t,
				"setup: --auto-reconnect off persisted (project scope)",
				loadSettings(setupProj).settings.autoReconnect === false,
			);
			await handler!("--project --auto-reconnect banana", setupCtx as never);
			await check(
				t,
				"setup: invalid --auto-reconnect rejected",
				notices.some((n) => n.includes("Invalid --auto-reconnect")),
				notices.join(" | "),
			);
			await handler!("--project --auto-reconnect on", setupCtx as never);
			await check(t, "setup: --auto-reconnect on persisted", loadSettings(setupProj).settings.autoReconnect === true);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
