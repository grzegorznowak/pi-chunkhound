import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { runChhound } from "../chhound/cli.js";
import { adoptConfigFile, foldAdoptedInto, materializeTempConfig } from "../chhound/config.js";
import { gitRootOrNull } from "../chhound/git.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../chhound/settings.js";
import { globalSettingsPath, projectSettingsPath } from "../chhound/paths.js";
import type { PluginState } from "../chhound/types.js";

const USAGE =
	"/ch-setup [--config <chunkhound.json>] [--provider P] [--model M] [--rerank-model R] " +
	"[--baseline-ref <ref>] [--baseline-max-age <days>] [--api-key <key>] [--verify] [--project] [--reset]";

export function registerSetupCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("ch-setup", {
		description:
			"Configure pi-chhound: adopt an existing chunkhound.json or build settings interactively. " +
			"Secrets passed here never reach the LLM or disk.",
		handler: async (args, ctx) => {
			const { flags } = parseArgs(args);
			const repoRoot = await gitRootOrNull(ctx.cwd);
			const projectRoot = repoRoot ?? ctx.cwd;
			const loaded = loadSettings(projectRoot);
			let settings = loaded.settings;
			if (loaded.issue) ctx.ui.notify(loaded.issue, "warning");

			const scope = flags["project"] ? ("project" as const) : ("global" as const);
			const summary: string[] = [];
			const warnings: string[] = [];

			if (flags["reset"]) {
				saveSettings(DEFAULT_SETTINGS, scope, projectRoot);
				state.apiKey = undefined;
				ctx.ui.notify(`Reset pi-chhound settings (${scope}).`, "info");
				return;
			}

			// Mode A: adopt an existing chunkhound.json
			if (typeof flags["config"] === "string") {
				try {
					const { adopted, warnings: w } = adoptConfigFile(flags["config"], ctx.cwd);
					settings = foldAdoptedInto(settings, adopted);
					warnings.push(...w);
					const emb = settings.embedding;
					summary.push(
						`adopted ${flags["config"]}: ${emb?.provider ?? "?"}/${emb?.model ?? "?"}`,
						`database block ignored (pi-chhound pins duckdb per sandbox)`,
					);
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
					return;
				}
			}

			// Mode B (flags): non-interactive updates
			const updates: string[] = [];
			if (typeof flags["provider"] === "string") {
				settings.embedding = { ...(settings.embedding ?? {}), provider: flags["provider"] };
				updates.push(`provider=${flags["provider"]}`);
			}
			if (typeof flags["model"] === "string") {
				settings.embedding = { ...(settings.embedding ?? {}), model: flags["model"] };
				updates.push(`model=${flags["model"]}`);
			}
			if (typeof flags["rerank-model"] === "string") {
				settings.embedding = { ...(settings.embedding ?? {}), rerankModel: flags["rerank-model"] };
				updates.push(`rerank_model=${flags["rerank-model"]}`);
			}
			if (typeof flags["baseline-ref"] === "string") {
				settings.baseline = { ...(settings.baseline ?? {}), ref: flags["baseline-ref"] };
				updates.push(`baseline.ref=${flags["baseline-ref"]}`);
			}
			if (typeof flags["baseline-max-age"] === "string") {
				const days = Number(flags["baseline-max-age"]);
				if (Number.isFinite(days) && days > 0) {
					settings.baseline = { ...(settings.baseline ?? {}), maxAgeDays: days };
					updates.push(`baseline.maxAgeDays=${days}`);
				} else {
					ctx.ui.notify(`Invalid --baseline-max-age: ${flags["baseline-max-age"]}`, "error");
					return;
				}
			}

			// Secret: persisted (v1 decision) — settings.json + materialized configs, 0600.
			if (typeof flags["api-key"] === "string") {
				settings.embedding = { ...(settings.embedding ?? {}), apiKey: flags["api-key"] };
				state.apiKey = flags["api-key"];
				summary.push("api key saved to settings (0600)");
				updates.push("api-key");
			}

			// Mode C: interactive wizard (TUI only)
			if (!flags["config"] && updates.length === 0 && !flags["api-key"] && ctx.mode === "tui" && ctx.hasUI) {
				// Esc cancels; Enter with no typing accepts the current/default value.
				const ask = async (title: string, current: string): Promise<string | undefined> => {
					const v = await ctx.ui.input(title, current);
					if (v === undefined) return undefined;
					const t = v.trim();
					return t.length > 0 ? t : current;
				};
				const provider = await ask("Embedding provider", settings.embedding?.provider ?? "voyageai");
				if (provider === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				const model = await ask("Embedding model", settings.embedding?.model ?? "voyage-3.5");
				if (model === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				const rerank = await ask("Rerank model (Enter to skip)", settings.embedding?.rerankModel ?? "rerank-2.5");
				if (rerank === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				const key = await ask("API key (saved to settings — or leave empty and use CHUNKHOUND_EMBEDDING__API_KEY)", settings.embedding?.apiKey ?? "");
				if (key === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				const baseRef = await ask("Baseline ref (Enter for repo default)", settings.baseline?.ref ?? "");
				if (baseRef === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				settings.embedding = {
					...(settings.embedding ?? {}),
					provider,
					model,
					...(rerank ? { rerankModel: rerank } : {}),
				};
				if (key) {
					state.apiKey = key;
					settings.embedding = { ...(settings.embedding ?? {}), apiKey: key };
				}
				if (baseRef) settings.baseline = { ...(settings.baseline ?? {}), ref: baseRef };
				summary.push(`wizard: ${provider}/${model}${rerank ? ` + ${rerank}` : ""}`, key ? "api key saved to settings (0600)" : "api key: use CHUNKHOUND_EMBEDDING__API_KEY env");
				updates.push("interactive");
			}

			const changed = flags["config"] !== undefined || updates.length > 0;
			if (changed) {
				const p = saveSettings(settings, scope, projectRoot);
				summary.unshift(`saved settings → ${p}`);
			} else if (!flags["verify"]) {
				// Nothing to do: report current state + usage.
				const lines = [
					USAGE,
					"",
					`settings: ${globalSettingsPath()}${loaded.projectPath ? ` + ${loaded.projectPath}` : ""}`,
					`embedding: ${settings.embedding?.provider ?? "—"}/${settings.embedding?.model ?? "—"}`,
					`baseline: ref=${settings.baseline?.ref ?? "default"} maxAge=${settings.baseline?.maxAgeDays ?? "1d"}`,
					`api key: ${settings.embedding?.apiKey ? "stored in settings ✓" : process.env.CHUNKHOUND_EMBEDDING__API_KEY ? "env ✓" : "not set (env or --api-key)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			for (const w of warnings) ctx.ui.notify(w, "warning");
			if (summary.length) ctx.ui.notify(summary.join("\n"), "info");

			// Preflight: validate the materialized config against the real CLI.
			if (flags["verify"]) {
				ctx.ui.notify("Verifying configuration…", "info");
				const tmp = materializeTempConfig(settings);
				try {
					const env = state.apiKey ? { CHUNKHOUND_EMBEDDING__API_KEY: state.apiKey } : undefined;
					const r = await runChhound(["index", ctx.cwd, "--show-setup", "--config", tmp.configPath], { cwd: ctx.cwd, env });
					if (r.code === 0) {
						ctx.ui.notify("✓ Configuration verified.", "info");
					} else {
						const tail = (r.stderr || r.stdout).split("\n").slice(-4).join("\n");
						const hint = settings.embedding?.provider && settings.embedding?.model
							? ""
							: "No embedding provider configured — run /ch-setup (wizard) or /ch-setup --provider <p> --model <m> first.\n";
						ctx.ui.notify(`${hint}Configuration check failed:\n${tail}`, "error");
					}
				} finally {
					fs.rmSync(tmp.dir, { recursive: true, force: true });
				}
			}
		},
	});
}
