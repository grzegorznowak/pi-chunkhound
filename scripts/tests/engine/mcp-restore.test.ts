import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { ensureBaseline } from "../../../chhound/baseline.js";
import { chhoundVersion } from "../../../chhound/cli.js";
import { materializeConfig } from "../../../chhound/config.js";
import { gitWorktreeAdd, runGit } from "../../../chhound/git.js";
import { hotStartIndex } from "../../../chhound/hotstart.js";
import { sandboxDbDir, sandboxDirFor, sandboxStateDir, writeSandboxMeta } from "../../../chhound/sandbox.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { disconnectMcp, listMcpConnections } from "../../../mcp/manager.js";
import { CONNECTION_ENTRY_TYPE, recordConnection, rehydrateConnections, restoreConnections } from "../../../mcp/persist.js";
import type { ConnectionRecord } from "../../../mcp/persist.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 5 legacy checks moved from smoke.ts section 5c (mcp persistence +
// auto-restore) — the real auto-restore against an engine-indexed fixture
// sandbox: connect, unknown-sandbox tombstone, already-live skip,
// disconnected-only no-op and autoReconnect-off no-op. SELF-OWNED fixture —
// the legacy section reused the shared sandbox primed by sections 1+3; here a
// committed repo → baseline prime → worktree → hotStartIndex reproduces the
// indexed sandbox (claim sidecar + meta in the .state sibling). Recording
// checks: command/setup-settings.test.ts; pure rehydrate:
// unit/connection-records.test.ts.

const fakeEntry = (customType: string, data: unknown): SessionEntry =>
	({ type: "custom", customType, data, id: "e", parentId: "p", timestamp: "t" }) as unknown as SessionEntry;

describe("mcp restore", () => {
	test("legacy auto-restore obligations", async (t) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-mcp-restore-");
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
			const runtime = path.join(root, "mcp-runtime");
			fs.mkdirSync(runtime, { recursive: true });
			process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = runtime;
			const git = async (args: string[], opts: { cwd?: string } = {}): Promise<void> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
			};
			const gitOk = async (args: string[], opts: { cwd?: string } = {}) => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
				return r.stdout;
			};

			// Indexed-sandbox fixture (the sandbox-hotstart recipe): committed
			// repo → baseline prime → fix/smoke worktree with its own file →
			// hotStartIndex (db copy + top-up) → meta in the .state sibling.
			const repo = path.join(root, "repo");
			fs.mkdirSync(repo);
			await git(["init", "-b", "main"], { cwd: repo });
			await git(["config", "user.email", "smoke@test"], { cwd: repo });
			await git(["config", "user.name", "Smoke"], { cwd: repo });
			fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
			fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
			await git(["add", "-A"], { cwd: repo });
			await git(["commit", "-qm", "init"], { cwd: repo });
			const baseCommit = await gitOk(["rev-parse", "HEAD"], { cwd: repo });
			const extraArgs = ["--no-embeddings"];
			const b = await ensureBaseline({ repoRoot: repo, settings, extraArgs });

			const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
			const wt = path.join(sandboxDir, "fix-smoke");
			fs.mkdirSync(sandboxDir, { recursive: true });
			await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
			fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
			await git(["add", "-A"], { cwd: wt });
			await git(["commit", "-qm", "add c"], { cwd: wt });
			const dbDir = sandboxDbDir(sandboxDir);
			const configPath = materializeConfig(sandboxDir, { settings, dbDir });
			const r = await hotStartIndex({ sourceDbDir: b.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, extraArgs, pathPrefix: "fix-smoke" });
			if (r.code !== 0) throw new Error(`hotStartIndex failed (code ${r.code}): ${r.stderrTail}`);
			writeSandboxMeta(sandboxStateDir(sandboxDir), {
				version: 1,
				worktree: wt,
				repoRoot: repo,
				branch: "fix/smoke",
				baseRef: "main",
				baseCommit,
				chhoundVersion: await chhoundVersion(),
				createdAt: new Date().toISOString(),
				copiedFrom: b.dbDir,
				dbPath: dbDir,
			});

			// Auto-restore against the REAL fixture sandbox (daemonized).
			const entryLog: Array<{ type: string; data: unknown }> = [];
			const persistPi = {
				registerTool(_t: { name: string }) {
					/* connectMcp needs a registerTool surface */
				},
				appendEntry(type: string, data: unknown) {
					entryLog.push({ type, data });
				},
			} as unknown as ExtensionAPI;
			const realId = path.basename(sandboxDir);
			const realRecord = new Map<string, ConnectionRecord>();
			realRecord.set(realId, { sandboxId: realId, state: "connected" });
			realRecord.set("ghost-sandbox", { sandboxId: "ghost-sandbox", state: "connected" });
			await restoreConnections(persistPi, settings, realRecord, { extraArgs });
			await check(
				t,
				"persist: restore connects recorded sandbox",
				listMcpConnections().some((c) => c.id === realId),
				listMcpConnections().map((c) => c.id).join(",") || "(none)",
			);
			await check(
				t,
				"persist: unknown sandbox forgotten (tombstone)",
				entryLog.some((e) => {
					const d = e.data as Record<string, unknown>;
					return d.sandboxId === "ghost-sandbox" && d.state === "disconnected";
				}),
				JSON.stringify(entryLog),
			);
			const liveCount = listMcpConnections().length;
			await restoreConnections(persistPi, settings, realRecord, { extraArgs });
			await check(t, "persist: restore skips already-live connections", listMcpConnections().length === liveCount);
			await disconnectMcp(realId);

			const tombstoneOnly = rehydrateConnections([
				fakeEntry(CONNECTION_ENTRY_TYPE, { version: 1, sandboxId: realId, state: "disconnected" }),
			]);
			await restoreConnections(persistPi, settings, tombstoneOnly, { extraArgs });
			await check(t, "persist: disconnected-only records → no connect", listMcpConnections().length === 0);

			const logLen = entryLog.length;
			await restoreConnections(persistPi, { ...settings, autoReconnect: false }, realRecord, {
				extraArgs,
			});
			await check(
				t,
				"persist: autoReconnect off → no restore, no records",
				listMcpConnections().length === 0 && entryLog.length === logLen,
				`conns=${listMcpConnections().length} newEntries=${entryLog.length - logLen}`,
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
