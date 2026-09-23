import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { xdgStateHome } from "../../chhound/paths.js";
import { registerSetupCommand } from "../../setup/command.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// The /ch-setup wizard's worktree-library-root prompt. When the cwd sits inside
// an index root there is no suggestion to prefill; the copy must name the
// effective default location (what Enter falls back to) instead of implying
// that no default exists.
describe("setup wizard library root prompt", () => {
	test("indexed cwd names the effective default; clean cwd still prefills it", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-command-setup-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));

			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			registerSetupCommand(
				{
					registerCommand(_name: string, def: { handler: typeof handler }) {
						handler = def.handler;
					},
				} as unknown as ExtensionAPI,
				{},
			);

			const expectedDefault = path.join(xdgStateHome(), "pi-chhound", "sandboxes");
			const runWizard = async (cwd: string, answer: string) => {
				const titles: string[] = [];
				await handler!("", {
					cwd,
					mode: "tui",
					hasUI: true,
					ui: {
						notify: () => {},
						input: async (title: string, start: string) => {
							titles.push(title);
							return title.startsWith("Worktree library root") ? answer : start;
						},
					},
				} as never);
				return titles.find((title) => title.startsWith("Worktree library root"));
			};

			// No configured root and an indexed cwd → no suggestion; Enter keeps
			// the built-in default, and the prompt must say which path that is.
			const indexed = path.join(root, "indexed-proj");
			fs.mkdirSync(indexed, { recursive: true });
			fs.writeFileSync(path.join(indexed, ".chunkhound.json"), "{}");
			const indexedTitle = await runWizard(indexed, "");
			await check(t, "indexed cwd: library-root prompt reached", indexedTitle !== undefined);
			await check(
				t,
				"indexed cwd: prompt names the effective default",
				!!indexedTitle && indexedTitle.includes(`Enter keeps the effective default ${expectedDefault}`),
				String(indexedTitle),
			);
			await check(
				t,
				"indexed cwd: prompt keeps the outside-index constraint",
				!!indexedTitle && indexedTitle.includes("must be outside any chunkhound index"),
				String(indexedTitle),
			);
			await check(
				t,
				"indexed cwd: no 'default: none' wording",
				!!indexedTitle && !indexedTitle.includes("default: none"),
				String(indexedTitle),
			);
			const saved = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "pi-chhound", "settings.json"), "utf8")) as {
				sandboxRoot?: string;
			};
			await check(t, "indexed cwd: Enter leaves sandboxRoot unset", saved.sandboxRoot === undefined, JSON.stringify(saved.sandboxRoot));

			// Clean cwd → the cwd is suggested and rendered as the field default.
			const clean = path.join(root, "clean-proj");
			fs.mkdirSync(clean, { recursive: true });
			const cleanTitle = await runWizard(clean, "");
			await check(t, "clean cwd: suggestion still rendered as default", !!cleanTitle && cleanTitle.includes(`default: ${clean}`), String(cleanTitle));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
