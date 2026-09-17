import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as worktree from "../../worktree/command.js";
import * as mcp from "../../mcp/command.js";
import { ensureBaseline } from "../../chhound/baseline.js";
import type { SandboxEntry } from "../../chhound/sandbox.js";
import type { PluginState } from "../../chhound/types.js";
import { check } from "../lib/checks.js";
import { withPiHarness } from "../lib/pi-harness.js";

// Minimal returning-core contract: ok distinguishes failure/success, kind is a
// nonempty operation/outcome tag. Exact kind vocabulary and extra fields stay
// open. This deliberately rejects today's Promise<void>, without mandating a
// new production module or a large discriminated result union.
type CoreResult = { ok: boolean; kind: string };
type Reporter = {
	cwd: string;
	hasUI: false;
	pi: ExtensionAPI;
	state: PluginState;
	onProgress: (...updates: unknown[]) => void;
	signal: AbortSignal;
};

// Compile-only call sites, deliberately NOT invoked: no real engine, PR host,
// or connection. Missing exports, missing signal and void results are RED.
// No `as never`, @ts-expect-error, or production stubs hide seam failures.
function reporterCallSites(reporter: Reporter, entry: SandboxEntry) {
	const settings = { version: 1 as const };
	const opts = { repoRoot: reporter.cwd, sandboxDir: path.join(reporter.cwd, "sandbox"), wtPath: path.join(reporter.cwd, "sandbox", "tree"), settings, flags: {} };
	void worktree.createIndexedWorktree(reporter, reporter.state, opts);
	const prContext: Parameters<typeof worktree.runPrOneGo>[0] = reporter;
	void prContext;
	const location: typeof worktree.oneGoLocation = worktree.oneGoLocation;
	void location;
	const connection: Promise<CoreResult> = mcp.connectEntry(reporter.pi, reporter, reporter.state, entry, {});
	void connection;
	void ensureBaseline({ repoRoot: reporter.cwd, settings, signal: reporter.signal });
}
void reporterCallSites;

describe("returning cores and reporter seam (initially RED)", () => {
	test("worktree and disconnect cores exported", async (t) => {
		for (const name of ["createIndexedWorktree", "oneGoLocation", "runPrOneGo"] as const) {
			await check(t, `${name} is exported`, typeof worktree[name] === "function", `Missing export worktree/command.ts:${name}`);
		}
		await check(t, "disconnectEntry is exported", typeof mcp.disconnectEntry === "function", "Missing export mcp/command.ts:disconnectEntry");
	});

	test("connectEntry returns failure data and reports without UI (SDK stub, no spawn)", async (t) => withPiHarness(async (h) => {
		// connectMcp cannot start its transport: stub the SDK boundary BEFORE
		// calling the core, rather than spawning a fake/real chunkhound process.
		const connection = t.mock.method(Client.prototype, "connect", async () => { throw new Error("fixture connection failure"); });
		try {
			const updates: unknown[][] = [];
			const reporter: Reporter = { cwd: h.ctx.cwd, hasUI: false, pi: h.pi, state: {}, onProgress: (...args) => { updates.push(args); }, signal: new AbortController().signal };
			const entry: SandboxEntry = {
				dir: path.join(h.ctx.cwd, "sandbox"), stateDir: path.join(h.ctx.cwd, ".state", "sandbox"), dbSizeBytes: 0,
				meta: { version: 1, worktree: path.join(h.ctx.cwd, "sandbox", "tree"), branch: "test", baseRef: "main", baseCommit: "0".repeat(40), chhoundVersion: "fixture", createdAt: new Date(0).toISOString(), copiedFrom: "", dbPath: path.join(h.ctx.cwd, "db") },
			};
			let result: unknown;
			let error = "";
			try { result = await mcp.connectEntry(h.pi, reporter, {}, entry, {}); } catch (e) { error = String(e); }
			await check(t, "connection error is returned, not thrown", error === "", error);
			const core = result as CoreResult | undefined;
			await check(t, "returning core has ok:false and nonempty kind", core?.ok === false && typeof core.kind === "string" && core.kind.length > 0, JSON.stringify(result));
			await check(t, "failure progress reaches reporter", updates.length > 0);
			await check(t, "SDK boundary stubbed exactly once", connection.mock.callCount() === 1);
			await check(t, "no interactive flow", h.confirms.length === 0 && h.selections.length === 0);
		} finally { connection.mock.restore(); }
	}, { hasUI: false }));

	test("connectEntry success data and disconnectEntry teardown (SDK stub, no spawn)", async (t) => withPiHarness(async (h) => {
		const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
		const listTools = t.mock.method(Client.prototype, "listTools", (async () => ({
			tools: [{ name: "search", description: "fixture", inputSchema: { type: "object" } }],
		})) as unknown as typeof Client.prototype.listTools);
		const close = t.mock.method(Client.prototype, "close", async () => undefined);
		try {
			const dir = path.join(h.ctx.cwd, "sandbox");
			const stateDir = path.join(h.ctx.cwd, ".state", "sandbox");
			fs.mkdirSync(dir, { recursive: true });
			fs.mkdirSync(stateDir, { recursive: true });
			const entry: SandboxEntry = {
				dir, stateDir, dbSizeBytes: 0,
				meta: { version: 1, worktree: path.join(dir, "tree"), branch: "test", baseRef: "main", baseCommit: "0".repeat(40), chhoundVersion: "fixture", createdAt: new Date(0).toISOString(), copiedFrom: "", dbPath: path.join(h.ctx.cwd, "db") },
			};
			const reporter: Reporter = { cwd: h.ctx.cwd, hasUI: false, pi: h.pi, state: {}, onProgress: () => {}, signal: new AbortController().signal };
			const connected = await mcp.connectEntry(h.pi, reporter, {}, entry, {});
			await check(t, "success core has ok:true, kind, id and message", connected.ok === true && connected.kind.length > 0 && connected.id === "sandbox" && typeof connected.message === "string" && connected.message.includes("Connected chhound MCP"), JSON.stringify(connected));
			await check(t, "SDK boundary stubbed exactly once", connect.mock.callCount() === 1 && listTools.mock.callCount() === 1, `connect=${connect.mock.callCount()} listTools=${listTools.mock.callCount()}`);
			const disconnected = await mcp.disconnectEntry(h.pi, reporter, "sandbox");
			await check(t, "disconnect success core has ok:true, kind, id and message", disconnected.ok === true && disconnected.kind === "disconnected" && disconnected.id === "sandbox" && typeof disconnected.message === "string", JSON.stringify(disconnected));
			await check(t, "client closed exactly once", close.mock.callCount() === 1, `close=${close.mock.callCount()}`);
			await check(t, "no interactive flow", h.confirms.length === 0 && h.selections.length === 0);
		} finally {
			connect.mock.restore();
			listTools.mock.restore();
			close.mock.restore();
		}
	}, { hasUI: false }));

	test("tool reporter gets progress without UI or wizard on early worktree failure", async (t) => withPiHarness(async (h) => {
		await check(t, "createIndexedWorktree available", typeof worktree.createIndexedWorktree === "function");
		if (typeof worktree.createIndexedWorktree !== "function") return;
		const updates: unknown[][] = [];
		const reporter: Reporter = { cwd: h.ctx.cwd, hasUI: false, pi: h.pi, state: {}, onProgress: (...args) => { updates.push(args); }, signal: new AbortController().signal };
		// Missing cwd guarantees git worktree add fails before indexing. The
		// fixture also overrides CHHOUND_BINARY with a nonexistent executable.
		// No ui property: any picker/confirmation/notification dependency fails.
		let error = "";
		try {
			await worktree.createIndexedWorktree(reporter, {}, {
				repoRoot: path.join(h.ctx.cwd, "missing-repo"),
				sandboxDir: path.join(h.ctx.cwd, "sandbox"),
				wtPath: path.join(h.ctx.cwd, "sandbox", "tree"),
				settings: { version: 1 }, flags: {},
			});
		} catch (e) { error = String(e); }
		await check(t, "no UI access failure", !/TypeError|ui|confirm|select|notify|wizard/i.test(error), error);
		await check(t, "onProgress receives tool-mode progress", updates.length > 0, JSON.stringify(updates));
		await check(t, "no wizard or consent attempted", h.confirms.length === 0 && h.selections.length === 0);
	}, { hasUI: false }));
});
