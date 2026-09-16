import { describe, test } from "node:test";
import { loadSettings, saveSettings } from "../../chhound/settings.js";
import { SETTINGS_VERSION } from "../../chhound/types.js";
import { registerSetupCommand } from "../../setup/command.js";
import { check } from "../lib/checks.js";
import { withPiHarness } from "../lib/pi-harness.js";

describe("model tool settings (initially RED)", () => {
	test("v1 default and round trips", async (t) => withPiHarness(async (h) => {
		await check(t, "SETTINGS_VERSION remains 1", SETTINGS_VERSION === 1);
		await check(t, "absent settings default on", loadSettings(h.ctx.cwd).settings.modelTools === "on");
		saveSettings({ version: 1 }, "global");
		await check(t, "existing v1 without modelTools defaults on", loadSettings(h.ctx.cwd).settings.modelTools === "on");
		for (const modelTools of ["off", "read-only", "on"] as const) {
			saveSettings({ version: 1, modelTools }, "global");
			await check(t, `${modelTools} global round trip`, loadSettings().settings.modelTools === modelTools);
			saveSettings({ version: 1, modelTools }, "project", h.ctx.cwd);
			await check(t, `${modelTools} project round trip`, loadSettings(h.ctx.cwd).settings.modelTools === modelTools);
		}
	}));

	test("/ch-setup --model-tools parses all modes and rejects invalid input", async (t) => withPiHarness(async (h) => {
		registerSetupCommand(h.pi, {});
		const command = h.commands.get("ch-setup")!;
		for (const mode of ["off", "read-only", "on"] as const) {
			await command.handler(`--project --model-tools ${mode}`, h.ctx);
			await check(t, `flag persists ${mode}`, loadSettings(h.ctx.cwd).settings.modelTools === mode);
		}
		for (const args of ["--project --model-tools banana", "--project --model-tools"]) {
			h.notices.length = 0;
			await command.handler(args, h.ctx);
			await check(t, `rejects ${args}`, h.notices.some((n) => /model-tools/i.test(n.message) && /invalid|requires|expected|missing/i.test(n.message)), h.notices.map((n) => n.message).join(" | "));
			await check(t, "invalid flag leaves prior mode unchanged", loadSettings(h.ctx.cwd).settings.modelTools === "on");
		}
		await check(t, "flag path never enters wizard", h.confirms.length === 0 && h.selections.length === 0);
	}, { hasUI: false }));
});
