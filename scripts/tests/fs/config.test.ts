import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { adoptConfigFile, foldAdoptedInto, insideChunkhoundRoot, materializeConfig, suggestWorktreeBase } from "../../../chhound/config.js";
import { sandboxDbDir, sandboxStateDir, writeSandboxMeta } from "../../../chhound/sandbox.js";
import type { ChhoundSettings, SandboxMeta } from "../../../chhound/types.js";
import { refreshMaterializedConfigs } from "../../../setup/command.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 26 legacy checks moved from smoke.ts sections 6+7
// (adoptConfigFile + materializeConfig). Security labels: api_key adoption,
// config file 0600 at creation, secrets never materialized without settings.
// Also holds the 3 config-refresh checks from smoke.ts section 5b (mcp bridge
// integration) — refreshMaterializedConfigs over a handcrafted catalog.

async function settingsFor(root: string): Promise<ChhoundSettings> {
	return { version: 1, sandboxRoot: path.join(root, "sandboxes"), baseRoot: path.join(root, "bases") };
}

describe("adoptConfigFile", () => {
	test("legacy adoptConfigFile obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-config-");
		try {
			const settings = await settingsFor(root);
			const cfgPath = path.join(root, "existing-chhound.json");
			fs.writeFileSync(
				cfgPath,
				JSON.stringify({
					embedding: { provider: "voyageai", model: "voyage-3.5", rerank_model: "rerank-2.5", api_key: "sk-SECRET" },
					indexing: { include: ["**/*.rs"], per_file_timeout_seconds: 8 },
					database: { provider: "duckdb", path: "/ignored" },
				}),
			);
			const { adopted, warnings } = adoptConfigFile(cfgPath, root);
			await check(t, "embedding folded", adopted.embedding?.provider === "voyageai" && adopted.embedding?.model === "voyage-3.5");
			await check(t, "rerank_model mapped", adopted.embedding?.rerankModel === "rerank-2.5");
			await check(t, "api_key adopted into settings", adopted.embedding?.apiKey === "sk-SECRET");
			await check(t, "api_key adoption noted", warnings.some((w) => w.includes("api_key")), warnings.join("; "));
			await check(t, "database warning", warnings.some((w) => w.includes("database")));

			// --config adoption: llm section folds in, secrets warned.
			const adoptSrc = path.join(root, "adopt.json");
			fs.writeFileSync(adoptSrc, JSON.stringify({ embedding: { provider: "voyageai" }, llm: { provider: "anthropic", api_key: "sk-ADOPT" }, database: { provider: "duckdb" } }));
			const adopted2 = adoptConfigFile(adoptSrc, root);
			await check(t, "adopt folds llm section", adopted2.adopted.llm?.provider === "anthropic" && adopted2.adopted.llm?.apiKey === "sk-ADOPT");
			await check(t, "adopt warns on llm api_key", adopted2.warnings.some((w) => w.includes("llm.api_key")));
			const folded = foldAdoptedInto({ version: 1 }, adopted2.adopted);
			await check(t, "foldAdoptedInto carries llm", folded.llm?.provider === "anthropic");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

describe("materializeConfig", () => {
	test("legacy materializeConfig obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-config-");
		try {
			const settings = await settingsFor(root);
			const dir = path.join(root, "cfg-out");
			const dbDir = path.join(dir, ".chhound.db");
			const p = materializeConfig(dir, { settings, dbDir });
			await check(t, "config materialized with canonical name", path.basename(p) === ".chunkhound.json", path.basename(p));
			const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
			const db = cfg.database as Record<string, unknown>;
			await check(t, "duckdb pinned", db.provider === "duckdb" && db.path === dbDir);
			await check(t, "no api_key without key in settings", JSON.stringify(cfg).includes("api_key") === false);
			const excludes = (cfg.indexing as Record<string, unknown>).exclude as string[];
			await check(t, "chhound exclusion guaranteed", excludes.includes("**/.chhound/**"));

			// With a key in settings, the materialized config carries it (v1) — 0600.
			const dir2 = path.join(root, "cfg-keyed");
			const p2 = materializeConfig(dir2, { settings: { ...settings, embedding: { apiKey: "sk-KEY" } }, dbDir: path.join(dir2, ".chhound.db") });
			const cfg2 = JSON.parse(fs.readFileSync(p2, "utf8")) as Record<string, unknown>;
			await check(t, "api_key materialized when set", (cfg2.embedding as Record<string, unknown>).api_key === "sk-KEY");
			await check(t, "config file 0600", (fs.statSync(p2).mode & 0o777) === 0o600, `mode=${(fs.statSync(p2).mode & 0o777).toString(8)}`);

			// LLM section (research tools) + preserve of non-owned sections.
			const dir3 = path.join(root, "cfg-llm");
			const p3 = materializeConfig(dir3, {
				settings: { ...settings, llm: { provider: "openai", model: "gpt-5", apiKey: "sk-LLM" } },
				dbDir: path.join(dir3, ".chhound.db"),
			});
			const cfg3 = JSON.parse(fs.readFileSync(p3, "utf8")) as Record<string, unknown>;
			const llm3 = cfg3.llm as Record<string, unknown>;
			await check(
				t,
				"llm block materialized",
				llm3?.provider === "openai" &&
					llm3?.model === "gpt-5" &&
					llm3?.api_key === "sk-LLM" &&
					llm3?.codex_reasoning_effort_utility === "minimal" &&
					llm3?.codex_reasoning_effort_synthesis === "high" &&
					llm3?.timeout === 300,
				JSON.stringify(cfg3),
			);
			await check(t, "llm defaults present without llm settings", (() => {
				const p3d = materializeConfig(dir3, { settings: { ...settings, llm: { provider: "openai" } }, dbDir: path.join(dir3, ".chhound.db") });
				const llm = (JSON.parse(fs.readFileSync(p3d, "utf8")) as Record<string, unknown>).llm as Record<string, unknown>;
				return llm?.codex_reasoning_effort_synthesis === "high" && llm?.timeout === 300;
			})());
			const p3b = materializeConfig(dir3, {
				settings,
				dbDir: path.join(dir3, ".chhound.db"),
				preserve: { research: { enabled: true } },
			});
			const cfg3b = JSON.parse(fs.readFileSync(p3b, "utf8")) as Record<string, unknown>;
			await check(t, "preserve merges extra sections", (cfg3b.research as Record<string, unknown>)?.enabled === true);
			await check(t, "preserve does not carry llm (owned keys rewritten)", (cfg3b.llm as Record<string, unknown> | undefined) === undefined);

			// Worktree-base suggestion rules: cwd is suggested unless it (or a
			// parent) already contains a .chunkhound.json.
			const wtProj = path.join(root, "wtbase");
			const wtSub = path.join(wtProj, "sub");
			fs.mkdirSync(wtSub, { recursive: true });
			await check(t, "suggestWorktreeBase: clean cwd suggested", suggestWorktreeBase(wtProj) === wtProj, String(suggestWorktreeBase(wtProj)));
			await check(t, "insideChunkhoundRoot: clean → false", insideChunkhoundRoot(wtProj) === false);
			fs.writeFileSync(path.join(wtProj, ".chunkhound.json"), "{}");
			await check(t, "insideChunkhoundRoot: own dir → true", insideChunkhoundRoot(wtProj) === true);
			await check(t, "insideChunkhoundRoot: parent walk → true", insideChunkhoundRoot(wtSub) === true);
			await check(t, "suggestWorktreeBase: inside root → undefined", suggestWorktreeBase(wtProj) === undefined);
			await check(t, "suggestWorktreeBase: subdir of root also undefined", suggestWorktreeBase(wtSub) === undefined);

			// output_dims: materialized when set, absent when unset.
			const dir4 = path.join(root, "cfg-dims");
			const p4 = materializeConfig(dir4, { settings: { ...settings, embedding: { provider: "voyageai", outputDims: 256 } }, dbDir: path.join(dir4, ".chhound.db") });
			const cfg4 = JSON.parse(fs.readFileSync(p4, "utf8")) as Record<string, unknown>;
			await check(t, "output_dims materialized", (cfg4.embedding as Record<string, unknown>).output_dims === 256, JSON.stringify(cfg4));
			const p4b = materializeConfig(dir4, { settings, dbDir: path.join(dir4, ".chhound.db") });
			const cfg4b = JSON.parse(fs.readFileSync(p4b, "utf8")) as Record<string, unknown>;
			const emb4b = cfg4b.embedding as Record<string, unknown> | undefined;
			await check(t, "no output_dims without setting", emb4b === undefined || emb4b.output_dims === undefined, JSON.stringify(cfg4b));
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});

describe("refreshMaterializedConfigs", () => {
	test("legacy mcp config refresh obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-config-");
		try {
			// Polling backend, exactly like the legacy shared settings the refresh
			// ran under — the re-materialized config must never default to watchman.
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
				indexing: { realtimeBackend: "polling" },
			};
			// Handcrafted catalog: one sandbox (meta + config path in the .state
			// sibling shape listSandboxes expects).
			const sandboxDir = path.join(settings.sandboxRoot!, "repo-fix-smoke-abc123");
			const dbDir = sandboxDbDir(sandboxDir);
			const meta: SandboxMeta = {
				version: 1,
				worktree: path.join(sandboxDir, "fix-smoke"),
				repoRoot: path.join(root, "repo"),
				branch: "fix/smoke",
				baseRef: "main",
				baseCommit: "0123456789abcdef0123456789abcdef01234567",
				chhoundVersion: "test-fixture",
				createdAt: "2026-09-07T00:00:00.000Z",
				copiedFrom: "",
				dbPath: dbDir,
			};
			writeSandboxMeta(sandboxStateDir(sandboxDir), meta);
			const configPath = materializeConfig(sandboxDir, { settings, dbDir });
			// Pre-existing config carries a section the plugin does not own.
			const withCustom = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
			withCustom.research = { enabled: true };
			fs.writeFileSync(configPath, JSON.stringify(withCustom, null, 2));
			const refreshed = refreshMaterializedConfigs({ ...settings, llm: { provider: "openai", model: "gpt-5" } });
			await check(t, "refresh: sandbox config re-materialized", refreshed.includes(configPath), refreshed.join(","));
			const cfgAfter = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
			await check(t, "refresh: llm section added", (cfgAfter.llm as Record<string, unknown>)?.provider === "openai");
			await check(t, "refresh: custom sections preserved", (cfgAfter.research as Record<string, unknown>)?.enabled === true);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
