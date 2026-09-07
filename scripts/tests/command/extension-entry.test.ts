import { describe, test } from "node:test";
import fs from "node:fs/promises";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 1 legacy check moved from smoke.ts section 18 (extension entry
// loads). Command tier: the public extension entry (index.ts) is dynamically
// imported ONLY (never statically — the module graph must stay inert until
// the factory runs) and the exact legacy assertion is preserved: the default
// export is a function. This does NOT claim any factory/registration contract
// (commands registered on invocation are a separate concern). HOME is
// isolated so the import graph can never touch real user state.

describe("extension entry", () => {
	test("legacy extension entry obligation", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-command-extension-entry-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const mod = (await import("../../../index.js")) as { default: unknown };
			await check(t, "index.ts default export is a function", typeof mod.default === "function");
		} finally {
			applyEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
