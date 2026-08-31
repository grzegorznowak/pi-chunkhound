import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { runChhound } from "../chhound/cli.js";
import { adoptConfigFile, CONFIG_FILE_NAME, foldAdoptedInto, materializeConfig, materializeTempConfig } from "../chhound/config.js";
import { listBaselines } from "../chhound/baseline.js";
import { gitRootOrNull } from "../chhound/git.js";
import { listSandboxes, sandboxConfigPath } from "../chhound/sandbox.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../chhound/settings.js";
import { globalSettingsPath, projectSettingsPath } from "../chhound/paths.js";
import type { ChhoundSettings, PluginState } from "../chhound/types.js";

const USAGE =
	"/ch-setup [--config <chunkhound.json>] [--provider P] [--model M] [--rerank-model R] [--output-dims N] " +
	"[--llm-provider P] [--llm-model M] [--llm-api-key <key>] " +
	"[--baseline-ref <ref>] [--baseline-max-age <days>] [--api-key <key>] [--verify] [--project] [--reset]";

/**
 * Re-materialize every sandbox + baseline config from current settings,
 * preserving sections the plugin does not own (research, custom keys).
 * Called by /ch-setup after saving — existing indexes pick up e.g. an llm
 * section without a recreate.
 */
export function refreshMaterializedConfigs(settings: ChhoundSettings): string[] {
	const updated: string[] = [];
	for (const s of listSandboxes(settings)) {
		const p = sandboxConfigPath(s.dir);
		materializeConfig(s.dir, { settings, dbDir: s.meta.dbPath, preserve: preservedSections(p) });
		updated.push(p);
	}
	for (const b of listBaselines(settings)) {
		const p = path.join(b.dir, CONFIG_FILE_NAME);
		materializeConfig(b.dir, { settings, dbDir: path.join(b.dir, "db", ".chhound.db"), preserve: preservedSections(p) });
		updated.push(p);
	}
	return updated;
}

function preservedSections(p: string): Record<string, unknown> {
	try {
		const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const owned = new Set(["embedding", "llm", "indexing", "database"]);
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(raw)) if (!owned.has(k)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

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
			if (typeof flags["output-dims"] === "string") {
				const dims = Number(flags["output-dims"]);
				if (Number.isInteger(dims) && dims > 0) {
					settings.embedding = { ...(settings.embedding ?? {}), outputDims: dims };
					updates.push(`output_dims=${dims}`);
				} else {
					ctx.ui.notify(`Invalid --output-dims: ${flags["output-dims"]} (positive integer)`, "error");
					return;
				}
			}
			if (typeof flags["llm-provider"] === "string") {
				settings.llm = { ...(settings.llm ?? {}), provider: flags["llm-provider"] };
				updates.push(`llm.provider=${flags["llm-provider"]}`);
			}
			if (typeof flags["llm-model"] === "string") {
				settings.llm = { ...(settings.llm ?? {}), model: flags["llm-model"] };
				updates.push(`llm.model=${flags["llm-model"]}`);
			}
			if (typeof flags["llm-api-key"] === "string") {
				settings.llm = { ...(settings.llm ?? {}), apiKey: flags["llm-api-key"] };
				summary.push("llm api key saved to settings (0600)");
				updates.push("llm-api-key");
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
				// Embedding output dims (positive integer; 256 default).
				let outputDims = settings.embedding?.outputDims ?? 256;
				let dimsOk = false;
				for (let attempt = 0; attempt < 3 && !dimsOk; attempt++) {
					const dimsRaw = await ask("Embedding output dims", String(outputDims));
					if (dimsRaw === undefined) {
						ctx.ui.notify("/ch-setup cancelled.", "info");
						return;
					}
					const dims = Number(dimsRaw);
					if (Number.isInteger(dims) && dims > 0) {
						outputDims = dims;
						dimsOk = true;
					} else if (attempt < 2) {
						ctx.ui.notify(`Invalid output dims: ${dimsRaw} (positive integer) — try again.`, "warning");
					}
				}
				if (!dimsOk) {
					ctx.ui.notify("Invalid output dims — cancelling.", "error");
					return;
				}
				const key = await ask("API key (saved to settings — or leave empty and use CHUNKHOUND_EMBEDDING__API_KEY)", settings.embedding?.apiKey ?? "");
				if (key === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				// LLM section (optional) — research tools (code_research/websearch/
				// fetchurl) only appear when an llm provider is configured.
				const llmProvider = await ask("LLM provider for research tools (Enter to skip)", settings.llm?.provider ?? "");
				if (llmProvider === undefined) {
					ctx.ui.notify("/ch-setup cancelled.", "info");
					return;
				}
				let llmModel: string | undefined;
				let llmKey: string | undefined;
				if (llmProvider) {
					llmModel = await ask("LLM model (Enter for default — used for utility + synthesis)", settings.llm?.model ?? "");
					if (llmModel === undefined) {
						ctx.ui.notify("/ch-setup cancelled.", "info");
						return;
					}
					llmKey = await ask("LLM API key (saved to settings — or leave empty and use env)", settings.llm?.apiKey ?? "");
					if (llmKey === undefined) {
						ctx.ui.notify("/ch-setup cancelled.", "info");
						return;
					}
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
					outputDims,
				};
				if (key) {
					state.apiKey = key;
					settings.embedding = { ...(settings.embedding ?? {}), apiKey: key };
				}
				if (llmProvider) {
					settings.llm = {
						...(settings.llm ?? {}),
						provider: llmProvider,
						...(llmModel ? { model: llmModel } : {}),
						...(llmKey ? { apiKey: llmKey } : {}),
					};
					summary.push(`llm: ${llmProvider}/${llmModel || "default"}${llmKey ? " + key saved to settings (0600)" : " (key via env)"}`);
				}
				if (baseRef) settings.baseline = { ...(settings.baseline ?? {}), ref: baseRef };
				summary.push(`wizard: ${provider}/${model}${rerank ? ` + ${rerank}` : ""} · dims ${outputDims}`, key ? "api key saved to settings (0600)" : "api key: use CHUNKHOUND_EMBEDDING__API_KEY env");
				updates.push("interactive");
			}

			const changed = flags["config"] !== undefined || updates.length > 0;
			if (changed) {
				const p = saveSettings(settings, scope, projectRoot);
				summary.unshift(`saved settings → ${p}`);
				const refreshed = refreshMaterializedConfigs(settings);
				if (refreshed.length > 0) summary.push(`refreshed ${refreshed.length} sandbox/baseline config(s)`);
			} else if (!flags["verify"]) {
				// Nothing to do: report current state + usage.
				const lines = [
					USAGE,
					"",
					`settings: ${globalSettingsPath()}${loaded.projectPath ? ` + ${loaded.projectPath}` : ""}`,
					`embedding: ${settings.embedding?.provider ?? "—"}/${settings.embedding?.model ?? "—"}${settings.embedding?.outputDims ? ` · dims ${settings.embedding.outputDims}` : ""}`,
					`llm: ${settings.llm?.provider ? `${settings.llm.provider}/${settings.llm.model ?? "default"}` : "— (research tools disabled)"}`,
					`baseline: ref=${settings.baseline?.ref ?? "default"} maxAge=${settings.baseline?.maxAgeDays ?? "1d"}`,
					`api key: ${settings.embedding?.apiKey ? "stored in settings ✓" : process.env.CHUNKHOUND_EMBEDDING__API_KEY ? "env ✓" : "not set (env or --api-key)"}`,
					`llm api key: ${settings.llm?.apiKey ? "stored in settings ✓" : "not set (env or --llm-api-key)"}`,
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
