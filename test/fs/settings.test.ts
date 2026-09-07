import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, saveSettings } from "../../chhound/settings.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 7 legacy checks moved from smoke.ts section 16 (settings
// round-trip, project scope). Security labels: settings file 0600, api key
// round-trip. HOME is isolated so the real user global settings file
// (~/.pi/agent/pi-chhound/settings.json via homedir()) can never be read.

describe("settings round-trip", () => {
	test("legacy project-scope settings obligations", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-settings-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
			};
			const proj = path.join(root, "proj");
			fs.mkdirSync(path.join(proj, ".pi", "pi-chhound"), { recursive: true });
			const saved = saveSettings(
				{ ...settings, embedding: { provider: "voyageai", model: "voyage-3.5", apiKey: "sk-ROUNDTRIP" } },
				"project",
				proj,
			);
			const loaded = loadSettings(proj);
			await check(t, "project settings round-trip", loaded.settings.embedding?.model === "voyage-3.5", saved);
			await check(t, "api key round-trips through settings", loaded.settings.embedding?.apiKey === "sk-ROUNDTRIP");
			await check(t, "settings file 0600", (fs.statSync(saved).mode & 0o777) === 0o600, `mode=${(fs.statSync(saved).mode & 0o777).toString(8)}`);
			await check(t, "project path used", loaded.projectPath === saved);
			const savedLlm = saveSettings({ ...settings, llm: { provider: "gemini", model: "gemini-2.5-pro" } }, "project", proj);
			await check(t, "llm settings round-trip", loadSettings(proj).settings.llm?.provider === "gemini" && loadSettings(proj).settings.llm?.model === "gemini-2.5-pro", savedLlm);
			const savedBase = saveSettings({ ...settings, worktreeBase: "/home/x/wt-base" }, "project", proj);
			await check(t, "worktreeBase settings round-trip", loadSettings(proj).settings.worktreeBase === "/home/x/wt-base", savedBase);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
