import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONNECTION_ENTRY_TYPE, rehydrateConnections } from "../../../mcp/persist.js";
import { check } from "../lib/checks.js";

// Inventory: 7 legacy checks moved from smoke.ts section 5c (mcp persistence +
// auto-restore) — the pure rehydrate portion over supplied session entries.
// recordConnection-via-fake-API moved to command/setup-settings.test.ts
// (adapter callback boundary); the real engine restore to
// engine/mcp-restore.test.ts.

const fakeEntry = (customType: string, data: unknown): SessionEntry =>
	({ type: "custom", customType, data, id: "e", parentId: "p", timestamp: "t" }) as unknown as SessionEntry;

describe("connection records", () => {
	test("legacy rehydrate obligations", async (t) => {
		await check(t, "persist: empty branch → no records", rehydrateConnections([]).size === 0);
		const branch = [
			fakeEntry("some-other-type", { version: 1 }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: "sb-a", state: "connected" }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: "sb-b", state: "connected", prefix: "pfx" }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: "sb-a", state: "disconnected" }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { version: 2, sandboxId: "sb-c", state: "connected" }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { sandboxId: "sb-d", state: "connected" }),
			fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: 42, state: "connected" }),
		];
		const hydrated = rehydrateConnections(branch);
		await check(t, "persist: rehydrate parses records", hydrated.size === 3, [...hydrated.keys()].join(",") || "(none)");
		await check(t, "persist: later record wins (tombstone)", hydrated.get("sb-a")?.state === "disconnected");
		await check(t, "persist: prefix survives rehydrate", hydrated.get("sb-b")?.prefix === "pfx");
		await check(t, "persist: future version ignored", !hydrated.has("sb-c"));
		await check(t, "persist: legacy version accepted", hydrated.get("sb-d")?.state === "connected");
		await check(t, "persist: malformed sandboxId ignored", !hydrated.has("42"));
	});
});
