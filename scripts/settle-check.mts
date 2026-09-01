/**
 * Design-1 acceptance check: sandbox-anchored daemon settles.
 * Exercises the REAL plugin path: connectMcp → `chunkhound mcp <sandboxDir>
 * --config <cfg>` (cwd = sandboxDir) → poll daemon_status through the bridge
 * tool until status=ready, live_indexing_state=idle and the queue drains,
 * then verifies daemon.log lands in the sandbox and the checkout stays clean.
 * Run: npx tsx scripts/settle-check.mts (no API key needed — --no-embeddings)
 */
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureBaseline } from "../chhound/baseline.js";
import { chhoundVersion } from "../chhound/cli.js";
import { materializeConfig } from "../chhound/config.js";
import { currentBranch, gitWorktreeAdd, runGit } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { sandboxDbDir, sandboxDirFor, writeSandboxMeta } from "../chhound/sandbox.js";
import { connectMcp, disconnectMcp } from "../mcp/manager.js";
import type { ChhoundSettings } from "../chhound/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-settle-"));
// Temp roots — acceptance runs must never touch the real sandbox/baseline cache.
const settings: ChhoundSettings = { version: 1, sandboxRoot: path.join(tmp, "sandboxes"), baseRoot: path.join(tmp, "bases") };

function log(msg: string): void {
	console.log(`[settle] ${msg}`);
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return await fn();
};

try {
	// Scratch repo (mirrors smoke setup)
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo);
	await runGit(["init", "-b", "main"], { cwd: repo });
	await runGit(["config", "user.email", "settle@test"], { cwd: repo });
	await runGit(["config", "user.name", "Settle"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
	await runGit(["add", "-A"], { cwd: repo });
	await runGit(["commit", "-m", "init"], { cwd: repo });
	const baseCommit = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;

	const onLine = () => undefined;
	const extraArgs = ["--no-embeddings"];
	const baseline = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	log(`baseline @ ${baseline.ref}`);

	// Sandbox-anchored worktree (Design 1)
	const sandboxDir = sandboxDirFor(repo, "settle-check", settings);
	const wt = path.join(sandboxDir, "settle-check");
	fs.mkdirSync(sandboxDir, { recursive: true });
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "settle-check", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	await runGit(["add", "-A"], { cwd: wt });
	await runGit(["commit", "-m", "add c"], { cwd: wt });
	const branch = await currentBranch(wt);

	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	const r = await hotStartIndex({ sourceDbDir: baseline.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, extraArgs });
	if (r.code !== 0) throw new Error(`hotstart failed: ${r.stderrTail}`);
	writeSandboxMeta(sandboxDir, {
		version: 1,
		worktree: wt,
		repoRoot: repo,
		branch,
		baseRef: baseline.ref,
		baseCommit: baseline.meta.baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: baseline.dbDir,
		dbPath: dbDir,
	});
	log(`sandbox ${path.basename(sandboxDir)} · worktree ${wt}`);

	// Real manager path: connectMcp spawns `chunkhound mcp <sandboxDir> --config …`, cwd = sandboxDir
	const tools = new Map<string, unknown>();
	const fakePi = { registerTool(t: { name: string }) { tools.set(t.name, t); } } as unknown as ExtensionAPI;
	const daemonRuntime = path.join(tmp, "daemon-runtime");
	fs.mkdirSync(daemonRuntime, { recursive: true });
	process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = daemonRuntime;
	const { listSandboxes } = await import("../chhound/sandbox.js");
	const entry = listSandboxes(settings)[0]!;
	const conn = await connectMcp(fakePi, entry, { extraArgs });
	log(`connected ${conn.id} → ${conn.worktree}`);

	const daemonTool = [...tools.entries()].find(([n]) => n.endsWith("_daemon_status"))?.[1] as {
		execute: (...args: unknown[]) => Promise<unknown>;
	};
	if (!daemonTool) throw new Error("no daemon_status bridge tool");
	// Bridge execute returns { content: [{ type: "text", text: "<json payload>" }] } — parse it.
	const status = async (): Promise<Record<string, unknown>> => {
		const raw = (await daemonTool.execute("call", {}, undefined, undefined)) as {
			content?: { type?: string; text?: string }[];
		};
		const text = raw.content?.find((c) => c.type === "text")?.text ?? "";
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			return { raw: text.slice(0, 200) };
		}
	};

	const settled = await waitFor(async () => {
		const st = await status();
		const realtime = (st.scan_progress as Record<string, unknown> | undefined)?.realtime as Record<string, unknown> | undefined;
		const live = String(realtime?.live_indexing_state ?? "?");
		const q = String(st.query_ready ?? "?");
		const queue = String(realtime?.queue_size ?? "?");
		const ok = q === "true" && live === "idle" && queue === "0";
		log(`  status=${String(st.status)} query_ready=${q} live_indexing_state=${live} queue_size=${queue}`);
		return ok;
	}, 90_000);
	if (!settled) {
		const st = await status();
		const realtime = (st.scan_progress as Record<string, unknown> | undefined)?.realtime as Record<string, unknown> | undefined;
		console.log("last payload:", JSON.stringify({ status: st.status, query_ready: st.query_ready, realtime }, null, 1).slice(0, 1500));
	}
	console.log(settled ? "\n✅ DAEMON SETTLED (query_ready + live_indexing_state=idle)" : "\n❌ DAEMON DID NOT SETTLE");

	// Core Design-1 claims, live:
	console.log(`daemon.log in sandbox:   ${fs.existsSync(path.join(sandboxDir, ".chunkhound", "daemon.log")) ? "YES" : "NO"} (${path.join(sandboxDir, ".chunkhound")})`);
	console.log(`.chunkhound in checkout:  ${fs.existsSync(path.join(wt, ".chunkhound")) ? "YES ✗" : "no ✓"}`);
	const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
	console.log(`worktree git status:      ${wtStatus === "" ? "clean ✓" : JSON.stringify(wtStatus)}`);
	const tail = fs.readFileSync(path.join(sandboxDir, ".chunkhound", "daemon.log"), "utf8").split("\n").slice(-5).join("\n");
	console.log(`--- daemon.log tail ---\n${tail}\n-----------------------`);

	await disconnectMcp(conn.id);
	console.log("disconnected; daemon should self-shutdown (lock check skipped — runtime dir per-invocation)");
	process.exit(settled ? 0 : 1);
} catch (err) {
	console.error("[settle] crashed:", err);
	process.exit(1);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
