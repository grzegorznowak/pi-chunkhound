import { describe, test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadSettings, saveSettings } from "../../chhound/settings.js";
import { globalSettingsPath, projectSettingsPath } from "../../chhound/paths.js";
import { sandboxConfigPath, sandboxDbDir, sandboxStateDir, readSandboxMeta, writeSandboxMeta } from "../../chhound/sandbox.js";
import type { SandboxMeta } from "../../chhound/types.js";
import { listMcpConnections, disconnectMcp } from "../../mcp/manager.js";
import { MODEL_WORKTREE_WIDGET_KEY, progressRelay, worktreeOutcomeText } from "../../model-tools.js";
import { resolveSandboxLocation } from "../../worktree/command.js";
import { check } from "../lib/checks.js";
import { fireToolCall, MODEL_ACTIONS, MODEL_TOOL_NAME, MUTATING_ACTIONS, READ_ACTIONS, runExtension, withPiHarness, type PiHarness } from "../lib/pi-harness.js";

async function execute(h: PiHarness, input: Record<string, unknown>) {
	return executeWith(h, input, h.ctx);
}
async function executeWith(h: PiHarness, input: Record<string, unknown>, ctx: PiHarness["ctx"]) {
	const tool = h.tools.get(MODEL_TOOL_NAME);
	if (!tool) throw new Error(`Missing factory registration: ${MODEL_TOOL_NAME}`);
	return tool.execute("test-call", input, new AbortController().signal, undefined, ctx);
}
async function errorText(body: () => Promise<unknown>): Promise<string> {
	try { await body(); return ""; } catch (error) { return String(error); }
}
function forbiddenSchema(node: unknown): boolean {
	if (!node || typeof node !== "object") return false;
	return Object.entries(node).some(([key, value]) => ["anyOf", "oneOf", "$ref", "const"].includes(key) || forbiddenSchema(value));
}
/** Real git repo + commit in the harness fixture (worktree.create needs one). */
function makeGitRepo(h: PiHarness, name = "repo"): string {
	const repo = path.join(h.ctx.cwd, name);
	fs.mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
	git("add", "-A");
	git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init");
	return repo;
}

/** Sandbox library fixture: storage dir + meta in the hidden state dir. */
function makeSandbox(h: PiHarness, name: string, worktree: string): string {
	const dir = path.join(h.ctx.cwd, "sandboxes", name);
	const stateDir = sandboxStateDir(dir);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(sandboxDbDir(dir), "fake db bytes\n");
	const meta: SandboxMeta = {
		version: 1,
		worktree,
		repoRoot: h.ctx.cwd,
		branch: "main",
		baseRef: "main",
		baseCommit: "0".repeat(40),
		chhoundVersion: "test",
		createdAt: "2026-01-01T00:00:00.000Z",
		copiedFrom: "",
		dbPath: sandboxDbDir(dir),
	};
	writeSandboxMeta(stateDir, meta);
	return dir;
}

/** Point the global settings at the fixture sandbox library. */
function seedSandboxRoot(h: PiHarness): string {
	const root = path.join(h.ctx.cwd, "sandboxes");
	saveSettings({ ...loadSettings().settings, sandboxRoot: root }, "global");
	return root;
}

function sdkStubs(t: TestContext) {
	const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
	const listTools = t.mock.method(Client.prototype, "listTools", (async () => ({
		tools: [{ name: "search", description: "fixture", inputSchema: { type: "object" } }],
	})) as unknown as typeof Client.prototype.listTools);
	const close = t.mock.method(Client.prototype, "close", async () => undefined);
	return {
		connect, listTools, close,
		restore: () => { connect.mock.restore(); listTools.mock.restore(); close.mock.restore(); },
	};
}

/**
 * Minimal chunkhound stand-in for the create path: `--version` plus
 * `index … --config <cfg>` (writes the db FILE at `database.path` and appends
 * one JSON line per index run — the same shape the anchor suite uses). `mcp`
 * is unsupported, so a post-create connect attempt fails AFTER a successful
 * create, exercising the late-failure path without a real engine.
 */
function writeFakeEngine(root: string, opts: { failIndex?: boolean } = {}): string {
	const script = [
		`#!${process.execPath}`,
		`const fs = require("node:fs");`,
		`const path = require("node:path");`,
		`const args = process.argv.slice(2);`,
		`if (args.includes("--version")) { process.stdout.write("chunkhound 0.0.0-fake\\n"); process.exit(0); }`,
		...(opts.failIndex
			? [`process.stderr.write("fake engine: index failed\\n"); process.exit(6);`]
			: [
				`if (args[0] !== "index") { process.stderr.write("fake engine: unsupported command: " + args.join(" ") + "\\n"); process.exit(2); }`,
				`const ci = args.indexOf("--config");`,
				`if (ci < 0 || typeof args[ci + 1] !== "string") { process.stderr.write("fake engine: missing --config\\n"); process.exit(3); }`,
				`const cfg = JSON.parse(fs.readFileSync(args[ci + 1], "utf8"));`,
				`const dbPath = cfg && cfg.database && cfg.database.path;`,
				`if (typeof dbPath !== "string" || !dbPath) { process.stderr.write("fake engine: missing database.path\\n"); process.exit(5); }`,
				`fs.mkdirSync(path.dirname(dbPath), { recursive: true });`,
				`fs.writeFileSync(dbPath, "fake-db-bytes");`,
				`fs.appendFileSync(path.join(path.dirname(__filename), "fake-chhound.log"), JSON.stringify({ dbPath }) + "\\n");`,
				`process.exit(0);`,
			]),
	].join("\n") + "\n";
	const p = path.join(root, "fake-chhound");
	fs.writeFileSync(p, script);
	fs.chmodSync(p, 0o755);
	return p;
}

/** db paths recorded for each engine `index` invocation (baseline + top-up). */
function engineInvocations(root: string): string[] {
	const p = path.join(root, "fake-chhound.log");
	if (!fs.existsSync(p)) return [];
	return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { dbPath: string }).dbPath);
}

/** Global settings pinned to fixture library roots for a REAL create run. */
function seedCreateRoots(h: PiHarness): void {
	saveSettings({ ...loadSettings().settings, sandboxRoot: path.join(h.ctx.cwd, "sandboxes"), baseRoot: path.join(h.ctx.cwd, "bases") }, "global");
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

describe("model dispatcher contract (initially RED)", () => {
	test("factory registration and portable flat schema", async (t) => withPiHarness(async (h) => {
		await check(t, "zero connections before factory", listMcpConnections().length === 0);
		await runExtension(h.pi);
		const defs = h.registrations.filter((tool) => tool.name === MODEL_TOOL_NAME);
		await check(t, "exactly one factory dispatcher registration", defs.length === 1, `Missing ${MODEL_TOOL_NAME}; registered: ${[...h.tools.keys()]}`);
		// Standalone websearch/fetchurl are separate tools, not extra dispatchers.
		await check(t, "no connection needed for registration", listMcpConnections().length === 0);
		const tool = defs[0];
		if (!tool) return;
		// Inspect the serialized provider-facing schema, independent of TypeBox internals.
		const schema = JSON.parse(JSON.stringify(tool.parameters));
		await check(t, "flat object and only action required", schema.type === "object" && JSON.stringify(schema.required) === '["action"]');
		await check(t, "StringEnum exact action catalog", schema.properties.action.type === "string" && JSON.stringify([...schema.properties.action.enum].sort()) === JSON.stringify([...MODEL_ACTIONS].sort()));
		await check(t, "no union/reference/literal nodes", !forbiddenSchema(schema));
		await check(t, "no prefix parameter", !("prefix" in schema.properties));
		await check(t, "target is an optional string", schema.properties.target?.type === "string" && !schema.required.includes("target"));
		await check(t, "description lists every action", MODEL_ACTIONS.every((action) => tool.description.includes(action)));
		await check(t, "promptSnippet present", Boolean(tool.promptSnippet?.trim()));
		await check(t, "sequential execution", tool.executionMode === "sequential");
	}));

	test("runtime validation is actionable (not just schema validation)", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const unknown = await errorText(() => execute(h, { action: "not.an.action" }));
		await check(t, "unknown action names bad action and available action/help", unknown.includes("not.an.action") && /status|supported|valid|help/i.test(unknown), unknown);
		for (const action of ["mcp.connect", "mcp.disconnect"]) {
			const missing = await errorText(() => execute(h, { action }));
			await check(t, `${action} requires target at execute boundary`, missing.includes(action) && missing.includes("target"), missing);
		}
	}));

	for (const action of READ_ACTIONS) test(`${action}: headless output and action details`, async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		let result: Awaited<ReturnType<typeof execute>> | undefined;
		const error = await errorText(async () => { result = await execute(h, { action }); });
		await check(t, "read action succeeds with default/absent modelTools", error === "", error);
		await check(t, "details identifies action", (result?.details as { action?: string } | undefined)?.action === action);
		await check(t, "model receives text, not just noOp notify", Boolean(result?.content.some((part) => part.type === "text" && part.text.trim())));
		await check(t, "no consent or wizard for read action", h.confirms.length === 0 && h.selections.length === 0);
	}, { hasUI: false }));

	test("read-action details survive both serializers pi applies", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		// pi JSON-serializes tool results into the session log and
		// structuredClone()s the message history before every request; any
		// non-cloneable/non-JSON value in `details` wedges the whole session.
		const survives = (value: unknown): boolean => {
			try {
				structuredClone(value);
				JSON.stringify(value);
				return true;
			} catch {
				return false;
			}
		};
		for (const action of READ_ACTIONS) {
			const result = await execute(h, { action });
			await check(t, `${action}: details are JSON + structuredClone safe`, survives(result.details));
		}
	}, { hasUI: false }));

	test("progress relay forwards only pi-shaped partial results", async (t) => {
		const updates: Array<Record<string, unknown>> = [];
		const relay = progressRelay("mcp.connect", (update) => updates.push(update as Record<string, unknown>));
		relay({ message: "Connected to sb", type: "info" });
		// {kind:"line"} is raw engine output → curated (only WARNING/ERROR pass).
		relay({ kind: "line", line: "2026-09-17 12:00:02 | WARNING | index:run:9 - slow batch" });
		relay({ kind: "phase", phase: "index" });
		relay({ kind: "note", note: "warm start" });
		relay("plain line");
		relay({ kind: "watch", dir: "/tmp/x" });
		relay({ kind: "done" });
		relay(undefined);
		await check(t, "UI frames with model-facing text are translated", updates.length === 5, JSON.stringify(updates));
		await check(
			t,
			"every emitted update is a pi partial result",
			updates.every((u) => Array.isArray(u.content) && (u.details as { action?: string } | undefined)?.action === "mcp.connect"),
			JSON.stringify(updates),
		);
		await check(
			t,
			"frames keep their text",
			updates.map((u) => (u.content as Array<{ text?: string }>)[0]?.text).join(" | ") === "Connected to sb | ⚠ slow batch | [index] | warm start | plain line",
			JSON.stringify(updates),
		);
		const passthrough = { content: [{ type: "text", text: "already pi shaped" }], details: { action: "mcp.connect" } };
		relay(passthrough);
		await check(t, "pi-shaped updates pass through untouched", updates[updates.length - 1] === passthrough);
	});

	test("worktree create outcome follows the command's notify terminus", async (t) => {
		// The ✓ block is the only terminal success frame (it carries elapsed +
		// baseline-copy vs full-index); failures end on the last error frame.
		const success = [
			{ message: "Creating worktree /lib/x/wt…", type: "info" },
			{ message: "⏳ Indexing started — the session is busy until it completes…", type: "warning" },
			{ message: "✓ new branch x @ /lib/x/wt indexed (baseline copy + top-up) in 0:12.", type: "info" },
		];
		await check(t, "success keeps the ✓ baseline copy + top-up block", worktreeOutcomeText(true, success) === success[2]!.message, String(worktreeOutcomeText(true, success)));
		const full = [...success.slice(0, 2), { message: "✓ branch x @ /lib/x/wt indexed (full index) in 1:02.", type: "info" }];
		await check(t, "force-reindex reports a full index", worktreeOutcomeText(true, full)?.includes("full index") === true, String(worktreeOutcomeText(true, full)));
		const afterConnect = [...success, { message: "Connect failed: boom", type: "error" }];
		await check(t, "a late connect error never flips a successful create", worktreeOutcomeText(true, afterConnect) === success[2]!.message);
		const failure = [
			{ message: "Creating worktree /lib/x/wt…", type: "info" },
			{ message: "Index failed after 0:30 (code 1):\nboom", type: "error" },
		];
		await check(t, "failure returns the terminal error", worktreeOutcomeText(false, failure) === failure[1]!.message);
		await check(t, "no terminal frame falls through to the caller fallback", worktreeOutcomeText(true, []) === undefined && worktreeOutcomeText(false, [{ message: "Creating…", type: "info" }]) === undefined);
	});

	test("worktree.create failure is reported, never as a created request", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = path.join(h.ctx.cwd, "repo");
		fs.mkdirSync(repo, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q", "-b", "main");
		fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
		git("add", "-A");
		git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init");
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		// CHHOUND_BINARY points at a missing file: git worktree add succeeds, the
		// baseline/index step fails for real through the same reporter seam.
		const updates: unknown[] = [];
		const result = await tool.execute("create-test", { action: "worktree.create", repo, newBranch: "feature-x" }, new AbortController().signal, (update) => { updates.push(update); }, h.ctx);
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		await check(t, "never claims a created worktree", !body.includes("Created worktree request"), body);
		await check(t, "never claims a ✓ index outcome", !body.startsWith("✓ "), body.slice(0, 120));
		await check(t, "the terminal error reaches the model", /failed/i.test(body), body);
		await check(t, "details carry ok:false", (result.details as { ok?: boolean }).ok === false, JSON.stringify(result.details));
		await check(
			t,
			"partial updates stay pi-shaped through the notify capture",
			updates.length > 0 && updates.every((u) => Array.isArray((u as { content?: unknown }).content) && (u as { details?: { action?: string } }).details?.action === "worktree.create"),
			JSON.stringify(updates).slice(0, 300),
		);
	}, { hasUI: false }));

	test("worktree.create refusal keeps the command's reason", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		// A non-empty target is refused by oneGoLocation before create runs; the
		// refusal reason must reach the model instead of a generic message.
		const location = resolveSandboxLocation(repo, "feature-x", loadSettings(repo).settings);
		fs.mkdirSync(location.wtPath, { recursive: true });
		fs.writeFileSync(path.join(location.wtPath, "leftover.txt"), "x");
		const error = await errorText(() => execute(h, { action: "worktree.create", repo, newBranch: "feature-x" }));
		await check(t, "refusal reason is the error", error.includes("exists and is not empty"), error);
		await check(t, "generic location failure is not the message", !error.includes("could not select a safe worktree location"), error);
	}, { hasUI: false }));

	test("TUI worktree.create drives the namespaced widget with quiet toasts", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		const updates: unknown[] = [];
		const result = await tool.execute("create-tui", { action: "worktree.create", repo, newBranch: "feature-tui" }, new AbortController().signal, (update) => { updates.push(update); }, h.ctx);
		const own = h.widgets.filter((w) => w.key === MODEL_WORKTREE_WIDGET_KEY);
		const rendered = own.filter((w) => Array.isArray(w.content));
		await check(t, "widget renders under the namespaced key only", own.length >= 2 && h.widgets.every((w) => w.key === MODEL_WORKTREE_WIDGET_KEY), JSON.stringify(h.widgets.map((w) => w.key)));
		await check(t, "widget shows the baseline phase before the engine runs", rendered.some((w) => (w.content as string[]).some((line) => line.includes("baseline index"))), JSON.stringify(rendered));
		await check(t, "widget placement is aboveEditor", rendered.every((w) => (w.options as { placement?: string } | undefined)?.placement === "aboveEditor"));
		await check(t, "widget is cleared in finally", own[own.length - 1]?.content === undefined, JSON.stringify(own.slice(-1)));
		const notifies = h.notices;
		await check(t, "warning toast passes", notifies.some((n) => n.type === "warning" && n.message.includes("Indexing started")), JSON.stringify(notifies));
		await check(t, "terminal error toast passes", notifies.some((n) => n.type === "error"), JSON.stringify(notifies));
		await check(
			t,
			"transient info toasts are suppressed",
			!notifies.some((n) => n.type === "info" && (n.message.includes("Creating worktree") || n.message.includes("Indexing "))),
			JSON.stringify(notifies),
		);
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		await check(t, "outcome reporting is unchanged", (result.details as { ok?: boolean }).ok === false && /failed/i.test(body), body);
		await check(t, "partial updates still flow pi-shaped", updates.length > 0 && updates.every((u) => Array.isArray((u as { content?: unknown }).content)), JSON.stringify(updates).slice(0, 200));
	}, { hasUI: true }));

	test("RPC worktree.create keeps text partials and emits no widget", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		const updates: unknown[] = [];
		const result = await tool.execute("create-rpc", { action: "worktree.create", repo, newBranch: "feature-rpc" }, new AbortController().signal, (update) => { updates.push(update); }, h.ctx);
		await check(t, "no widget writes in RPC mode", h.widgets.length === 0, JSON.stringify(h.widgets));
		await check(t, "text partials keep flowing", updates.length > 0, `updates=${updates.length}`);
		await check(
			t,
			"RPC partials are pi-shaped",
			updates.every((u) => Array.isArray((u as { content?: unknown }).content) && (u as { details?: { action?: string } }).details?.action === "worktree.create"),
			JSON.stringify(updates).slice(0, 200),
		);
		await check(t, "no toasts outside the widget path", h.notices.length === 0, JSON.stringify(h.notices));
		await check(t, "non-TUI progress never claims an editor", !JSON.stringify(updates).includes("editor"), JSON.stringify(updates).slice(0, 300));
		await check(t, "outcome reporting still works", (result.details as { ok?: boolean }).ok === false, JSON.stringify(result.details));
	}, { hasUI: true, mode: "rpc" }));

	test("fallback relay curates raw engine lines like the widget does", async (t) => {
		const updates: Array<Record<string, unknown>> = [];
		const relay = progressRelay("worktree.create", (update) => updates.push(update as Record<string, unknown>));
		relay({ kind: "line", line: "2026-09-17 12:00:00 | DEBUG | chunker:index:1 - Parsing 3 files with 2 workers" });
		relay({ kind: "line", line: "2026-09-17 12:00:01 | INFO | index:run:9 - done" });
		relay({ kind: "line", line: "2026-09-17 12:00:02 | WARNING | index:run:9 - watchman unavailable" });
		relay({ kind: "line", line: "2026-09-17 12:00:03 | ERROR | index:run:11 - embedding batch failed" });
		relay({ kind: "line", line: "plain non-loguru engine output" });
		relay({ line: "untyped line producer stays raw" });
		relay({ kind: "phase", phase: "baseline index" });
		relay({ message: "Indexing …", type: "info" });
		const texts = updates.map((u) => (u.content as Array<{ text?: string }>)[0]?.text ?? "").join(" | ");
		await check(t, "DEBUG/INFO noise and non-loguru output are dropped", !/Parsing 3 files|index:run:9 - done|plain non-loguru/.test(texts), texts);
		await check(t, "warnings and errors surface as ⚠ lines", texts.includes("⚠ watchman unavailable") && texts.includes("⚠ embedding batch failed"), texts);
		await check(t, "untyped line producers keep their raw text", texts.includes("untyped line producer stays raw"), texts);
		await check(t, "phase and notify frames are untouched", texts.includes("[baseline index]") && texts.includes("Indexing …"), texts);
		await check(t, "every emitted update stays pi-shaped", updates.every((u) => Array.isArray(u.content) && (u.details as { action?: string }).action === "worktree.create"), JSON.stringify(updates));
	});

	test("mcp.connect progress is pi-shaped end to end", async (t) => withPiHarness(async (h) => {
		const settings = loadSettings().settings;
		settings.sandboxRoot = path.join(h.ctx.cwd, "sandboxes");
		saveSettings(settings, "global");
		const sandboxDir = path.join(settings.sandboxRoot, "sb-test");
		const stateDir = sandboxStateDir(sandboxDir);
		const dbDir = sandboxDbDir(sandboxDir);
		fs.mkdirSync(sandboxDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(dbDir, "fake db bytes\n");
		const meta: SandboxMeta = {
			version: 1,
			worktree: path.join(h.ctx.cwd, "wt"),
			repoRoot: h.ctx.cwd,
			branch: "main",
			baseRef: "main",
			baseCommit: "0".repeat(40),
			chhoundVersion: "test",
			createdAt: "2026-01-01T00:00:00.000Z",
			copiedFrom: "",
			dbPath: dbDir,
		};
		writeSandboxMeta(stateDir, meta);
		await runExtension(h.pi);
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		// The isolated env points CHHOUND_BINARY at a missing file, so connect
		// fails — through the same report() path that crashed the TUI before.
		const updates: unknown[] = [];
		await tool
			.execute("connect-test", { action: "mcp.connect", target: "sb-test" }, new AbortController().signal, (update) => { updates.push(update); }, h.ctx)
			.catch(() => undefined);
		await check(t, "connect reported progress", updates.length > 0, `updates=${updates.length}`);
		await check(
			t,
			"every connect update is a pi partial result",
			updates.every(
				(u) =>
					Array.isArray((u as { content?: unknown }).content) &&
					(u as { details?: { action?: string } }).details?.action === "mcp.connect",
			),
			JSON.stringify(updates).slice(0, 300),
		);
		await check(t, "the failure message reaches the partial", JSON.stringify(updates).includes("Connect failed"), JSON.stringify(updates).slice(0, 300));
	}));

	test("setup.show never emits persisted API keys", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const seeded = loadSettings().settings;
		seeded.embedding = { ...seeded.embedding, apiKey: "emb-secret" };
		seeded.llm = { ...seeded.llm, apiKey: "llm-secret" };
		saveSettings(seeded, "global");
		const result = await execute(h, { action: "setup.show" });
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const details = JSON.stringify(result.details);
		await check(t, "embedding key never emitted", !body.includes("emb-secret") && !details.includes("emb-secret"));
		await check(t, "llm key never emitted", !body.includes("llm-secret") && !details.includes("llm-secret"));
		await check(t, "redaction is visible", body.includes("[redacted]") || body.includes("setup.show"));
	}, { hasUI: false }));

	test("project settings at the git root govern access for a nested cwd", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		const nested = path.join(repo, "nested");
		fs.mkdirSync(nested, { recursive: true });
		// The policy lives in the repo-root project overlay, not in the nested cwd.
		saveSettings({ version: 1, modelTools: "off" }, "project", repo);
		const error = await errorText(() => executeWith(h, { action: "status" }, { ...h.ctx, cwd: nested }));
		await check(t, "nested cwd still sees the repo-root policy", error.includes("/ch-setup --model-tools on"), error);
		// read-only overlay: reads pass, mutations stay blocked with the remedy.
		saveSettings({ version: 1, modelTools: "read-only" }, "project", repo);
		const allowed = await errorText(() => executeWith(h, { action: "status" }, { ...h.ctx, cwd: nested }));
		await check(t, "read-only overlay permits reads from the nested cwd", allowed === "", allowed);
		const blocked = await errorText(() => executeWith(h, { action: "mcp.connect", target: "unused" }, { ...h.ctx, cwd: nested }));
		await check(t, "read-only overlay still blocks mutations", blocked.includes("/ch-setup --model-tools on"), blocked);
	}, { hasUI: false }));

	test("dispatcher settings are loaded from the git root for a nested cwd", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		const nested = path.join(repo, "nested");
		fs.mkdirSync(nested, { recursive: true });
		saveSettings({ version: 1, llm: { provider: "proj-llm", model: "proj-model" } }, "project", repo);
		const result = await executeWith(h, { action: "setup.show" }, { ...h.ctx, cwd: nested });
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		await check(t, "project overlay is visible from the nested cwd", body.includes("proj-llm"), body.slice(0, 200));
	}, { hasUI: false }));

	test("setup.update sandboxRoot is expanded, cwd-relative, and outside index roots", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		saveSettings({ version: 1 }, "global");
		await execute(h, { action: "setup.update", sandboxRoot: path.join("lib", "wt") });
		await check(t, "relative sandboxRoot resolves against ctx.cwd", loadSettings().settings.sandboxRoot === path.join(h.ctx.cwd, "lib", "wt"), String(loadSettings().settings.sandboxRoot));
		await execute(h, { action: "setup.update", sandboxRoot: "~/wt" });
		await check(t, "home-relative sandboxRoot is expanded", loadSettings().settings.sandboxRoot === path.join(os.homedir(), "wt"), String(loadSettings().settings.sandboxRoot));
		// A .chunkhound.json at the repo root makes the whole tree an index root.
		const repo = makeGitRepo(h);
		fs.writeFileSync(path.join(repo, ".chunkhound.json"), JSON.stringify({ version: 1 }));
		const nested = path.join(repo, "nested");
		fs.mkdirSync(nested, { recursive: true });
		const before = fs.readFileSync(globalSettingsPath(), "utf8");
		const inside = await errorText(() => executeWith(h, { action: "setup.update", sandboxRoot: "." }, { ...h.ctx, cwd: nested }));
		await check(t, "sandboxRoot inside an index root is rejected", inside.includes("outside any chunkhound index root"), inside);
		await check(t, "rejected update never reaches the global file", fs.readFileSync(globalSettingsPath(), "utf8") === before);
		const rootItself = await errorText(() => execute(h, { action: "setup.update", sandboxRoot: repo }));
		await check(t, "the index root itself is rejected", rootItself.includes("outside any chunkhound index root"), rootItself);
	}, { hasUI: false }));

	test("consent dialog shows a bounded allowlisted argument summary", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		await fireToolCall(h, {
			toolName: MODEL_TOOL_NAME,
			input: { action: "mcp.connect", target: "sb-1", repo: "/tmp/x", apiKey: "sk-super-secret", junk: "zzz", branch: "b".repeat(200) },
		});
		await check(t, "one confirmation", h.confirms.length === 1);
		const message = h.confirms[0]?.message ?? "";
		await check(t, "action and allowlisted fields are shown", message.includes("mcp.connect") && message.includes("target=sb-1") && message.includes("repo=/tmp/x"), message);
		await check(t, "unknown and secret-shaped inputs never reach the dialog", !message.includes("sk-super-secret") && !message.includes("junk"), message);
		await check(t, "long values are clipped and the summary is bounded", !message.includes("b".repeat(50)) && message.length < 300, `${message.length}: ${message}`);
		await fireToolCall(h, { toolName: MODEL_TOOL_NAME, input: { action: "baseline.refresh" } });
		await check(t, "no-argument actions keep the plain prompt", h.confirms[1]?.message === "Allow ch-chhound to run baseline.refresh?", h.confirms[1]?.message);
	}));

	test("setup.update writes global scope only and refreshes merged configs", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		fs.writeFileSync(path.join(repo, ".chunkhound.json"), JSON.stringify({ version: 1 }));
		// Global holds the sandbox library root; the project overlay holds a
		// provider + model that must never be copied into the global file.
		saveSettings({ version: 1, sandboxRoot: path.join(h.ctx.cwd, "sandboxes") }, "global");
		saveSettings({ version: 1, embedding: { provider: "proj-provider", model: "proj-model" } }, "project", repo);
		const sandboxDir = path.join(h.ctx.cwd, "sandboxes", "sb-test");
		const stateDir = sandboxStateDir(sandboxDir);
		fs.mkdirSync(sandboxDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(sandboxDbDir(sandboxDir), "fake db bytes\n");
		const meta: SandboxMeta = {
			version: 1,
			worktree: path.join(h.ctx.cwd, "wt"),
			repoRoot: repo,
			branch: "main",
			baseRef: "main",
			baseCommit: "0".repeat(40),
			chhoundVersion: "test",
			createdAt: "2026-01-01T00:00:00.000Z",
			copiedFrom: "",
			dbPath: sandboxDbDir(sandboxDir),
		};
		writeSandboxMeta(stateDir, meta);
		const result = await executeWith(h, { action: "setup.update", llmModel: "global-llm" }, { ...h.ctx, cwd: repo });
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		await check(t, "result names the global scope", /global/i.test(body), body);
		const globalRaw = JSON.parse(fs.readFileSync(globalSettingsPath(), "utf8")) as Record<string, any>;
		await check(t, "global file carries the update", globalRaw.llm?.model === "global-llm", JSON.stringify(globalRaw));
		await check(t, "project overlay never leaks into the global file", !JSON.stringify(globalRaw).includes("proj-provider"), JSON.stringify(globalRaw));
		const projectRaw = JSON.parse(fs.readFileSync(projectSettingsPath(repo), "utf8")) as Record<string, any>;
		await check(t, "project overlay stays intact", projectRaw.embedding?.provider === "proj-provider", JSON.stringify(projectRaw));
		const materialized = JSON.parse(fs.readFileSync(sandboxConfigPath(sandboxDir), "utf8")) as Record<string, any>;
		await check(t, "refreshed config keeps the project overlay", materialized.embedding?.provider === "proj-provider", JSON.stringify(materialized).slice(0, 300));
		await check(t, "refreshed config carries the global update", materialized.llm?.model === "global-llm", JSON.stringify(materialized).slice(0, 300));
		// A bogus mode must never land in settings (access() would fail open to on).
		const before = fs.readFileSync(globalSettingsPath(), "utf8");
		const bad = await errorText(() => execute(h, { action: "setup.update", modelTools: "banana" }));
		await check(t, "invalid modelTools is rejected with the valid values", /modelTools/.test(bad) && /off, read-only, on/.test(bad), bad);
		await check(t, "rejected mode never lands in settings", fs.readFileSync(globalSettingsPath(), "utf8") === before);
	}, { hasUI: false }));

	test("mcp.disconnect rejects ambiguous targets without disconnecting", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		seedSandboxRoot(h);
		// Two sandboxes whose worktrees share a basename match one target.
		makeSandbox(h, "sb-one", path.join(h.ctx.cwd, "one", "feature-x"));
		makeSandbox(h, "sb-two", path.join(h.ctx.cwd, "two", "feature-x"));
		const error = await errorText(() => execute(h, { action: "mcp.disconnect", target: "feature-x" }));
		await check(t, "ambiguous target is rejected", /ambiguous/i.test(error), error);
		await check(t, "ambiguity never reaches the disconnect attempt", !error.includes("Disconnect failed"), error);
		await check(t, "nothing was disconnected", listMcpConnections().length === 0, JSON.stringify(listMcpConnections()));
	}, { hasUI: false }));

	test("mcp.disconnect uses a unique sandbox id and the direct id fallback", async (t) => withPiHarness(async (h) => {
		const stubs = sdkStubs(t);
		try {
			await runExtension(h.pi);
			seedSandboxRoot(h);
			makeSandbox(h, "sb-live", path.join(h.ctx.cwd, "wt-live"));
			const connected = await execute(h, { action: "mcp.connect", target: "sb-live" });
			const core = (connected.details as { result?: { ok?: boolean; kind?: string; id?: string; message?: string } }).result;
			await check(t, "connectEntry success returns ok/kind/id/message", core?.ok === true && core.kind === "connected" && core.id === "sb-live" && typeof core.message === "string", JSON.stringify(core));
			const disconnected = await execute(h, { action: "mcp.disconnect", target: "sb-live" });
			const result = (disconnected.details as { result?: { ok?: boolean; kind?: string; id?: string } }).result;
			await check(t, "unique sandbox target disconnects the live connection", result?.ok === true && result.kind === "disconnected" && result.id === "sb-live", JSON.stringify(result));
			await check(t, "connection registry is empty", listMcpConnections().length === 0, JSON.stringify(listMcpConnections()));
			// A live connection whose sandbox was removed is only addressable by id.
			makeSandbox(h, "sb-gone", path.join(h.ctx.cwd, "wt-gone"));
			await execute(h, { action: "mcp.connect", target: "sb-gone" });
			fs.rmSync(path.join(h.ctx.cwd, "sandboxes", "sb-gone"), { recursive: true, force: true });
			fs.rmSync(sandboxStateDir(path.join(h.ctx.cwd, "sandboxes", "sb-gone")), { recursive: true, force: true });
			const fallback = await execute(h, { action: "mcp.disconnect", target: "sb-gone" });
			const fallbackResult = (fallback.details as { result?: { ok?: boolean; kind?: string; id?: string } }).result;
			await check(t, "0-match fallback disconnects by direct connection id", fallbackResult?.ok === true && fallbackResult.kind === "disconnected" && fallbackResult.id === "sb-gone", JSON.stringify(fallbackResult));
		} finally {
			stubs.restore();
		}
	}, { hasUI: false }));

	test("baseline.refresh curates engine lines through the default-deny relay", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		const script = path.join(h.ctx.cwd, "fake-engine");
		fs.writeFileSync(
			script,
			"#!/bin/sh\ncase \"$1\" in\n  --version) echo 9.9.9; exit 0;;\nesac\necho \"2026-09-17 12:00:00 | DEBUG | chunker:index:1 - Parsing 3 files\" >&2\necho \"2026-09-17 12:00:01 | WARNING | index:run:9 - watchman unavailable\" >&2\nexit 0\n",
			{ mode: 0o755 },
		);
		process.env.CHHOUND_BINARY = script;
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		const updates: unknown[] = [];
		const result = await tool.execute("baseline-test", { action: "baseline.refresh", repo, ref: "main" }, new AbortController().signal, (update) => { updates.push(update); }, h.ctx);
		const rendered = JSON.stringify(updates);
		await check(t, "DEBUG chatter never reaches the model", updates.length > 0 && !rendered.includes("Parsing 3 files"), rendered.slice(0, 300));
		await check(t, "classified engine events surface", rendered.includes("watchman unavailable"), rendered.slice(0, 300));
		await check(
			t,
			"every update stays pi-shaped",
			updates.every((u) => Array.isArray((u as { content?: unknown }).content) && (u as { details?: { action?: string } }).details?.action === "baseline.refresh"),
			rendered.slice(0, 300),
		);
		const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		await check(t, "baseline refresh still reports success", body.includes("Baseline main: "), body);
	}, { hasUI: false }));

	test("renderResult tolerates every action payload", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const renderer = h.tools.get(MODEL_TOOL_NAME)?.renderResult;
		await check(t, "dispatcher renderer exists", typeof renderer === "function");
		if (!renderer) return;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		for (const action of MODEL_ACTIONS) {
			const error = await errorText(async () => { renderer({ content: [{ type: "text", text: `${action}: test result` }], details: { action } }, { expanded: false, isPartial: false }, theme as never, { args: { action }, toolCallId: "test-call", invalidate() {}, lastComponent: undefined, state: {}, cwd: h.ctx.cwd, executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false }); });
			await check(t, `renders ${action} without throwing`, error === "", error);
		}
		// pi forwards partial progress through this renderer as-is; a UI-shaped
		// update has no `content`, which used to throw here and then crash pi's
		// fallback (`result.content.filter` on undefined).
		const partialError = await errorText(async () => { renderer({ details: { action: "mcp.connect" } } as never, { expanded: false, isPartial: true }, theme as never, { args: { action: "mcp.connect" }, toolCallId: "test-call", invalidate() {}, lastComponent: undefined, state: {}, cwd: h.ctx.cwd, executionStarted: true, argsComplete: true, isPartial: true, expanded: false, showImages: false, isError: false }); });
		await check(t, "renders a content-less progress partial without throwing", partialError === "", partialError);
	}));

	test("settings enforce call-time access while registration stays unconditional", async (t) => withPiHarness(async (h) => {
		saveSettings({ ...loadSettings().settings, modelTools: "off" }, "global");
		await runExtension(h.pi);
		await check(t, "off still registers dispatcher", h.tools.has(MODEL_TOOL_NAME));
		for (const action of MODEL_ACTIONS) {
			const error = await errorText(() => execute(h, { action, target: "unused" }));
			await check(t, `off blocks ${action} with operator remedy`, error.includes("/ch-setup --model-tools on"), error);
		}
		// Change after factory: enforcement must read current settings, not capture startup mode.
		saveSettings({ ...loadSettings().settings, modelTools: "read-only" }, "global");
		const allowed = await errorText(() => execute(h, { action: "status" }));
		await check(t, "read-only permits status", allowed === "", allowed);
		const blocked = await errorText(() => execute(h, { action: "mcp.connect", target: "unused" }));
		await check(t, "read-only mutation has actionable remedy", blocked.includes("/ch-setup --model-tools on"), blocked);
		await check(t, "execute never asks its own consent", h.confirms.length === 0);
	}));

	for (const action of MUTATING_ACTIONS) {
		for (const answer of [false, true]) test(`gate ${action}: consent ${answer}`, async (t) => withPiHarness(async (h) => {
			await runExtension(h.pi);
			await check(t, "exactly one tool_call gate", h.handlers.get("tool_call")?.length === 1);
			const result = await fireToolCall(h, { toolName: MODEL_TOOL_NAME, input: { action, target: "test-target" } }) as { block?: boolean; reason?: string } | undefined;
			await check(t, "one confirmation", h.confirms.length === 1);
			await check(t, "gate honors answer", answer ? !result?.block : result?.block === true && Boolean(result.reason?.trim()));
		}, { answers: [answer] }));
		test(`gate ${action}: no UI defaults to block`, async (t) => withPiHarness(async (h) => {
			await runExtension(h.pi);
			const result = await fireToolCall(h, { toolName: MODEL_TOOL_NAME, input: { action } }) as { block?: boolean; reason?: string } | undefined;
			await check(t, "headless mutation blocked with reason", result?.block === true && Boolean(result.reason?.trim()));
		}, { hasUI: false, answers: [true] }));
	}

	test("gate passes read-only actions and unrelated tools untouched", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		for (const action of READ_ACTIONS) {
			const result = await fireToolCall(h, { toolName: MODEL_TOOL_NAME, input: { action } }) as { block?: boolean } | undefined;
			await check(t, `passes ${action}`, !result?.block);
		}
		const event = { toolName: "unrelated", input: { action: "mcp.connect" } };
		const before = JSON.stringify(event);
		await check(t, "unrelated gate result untouched", await fireToolCall(h, event) === undefined);
		await check(t, "unrelated input unchanged", JSON.stringify(event) === before);
		await check(t, "no confirmations", h.confirms.length === 0);
	}));

	test("worktree.create success e2e: ✓ completion, ok:true, sandboxId; connect only when requested", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		seedCreateRoots(h);
		process.env.CHHOUND_BINARY = writeFakeEngine(h.ctx.cwd);
		const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
		try {
			const tool = h.tools.get(MODEL_TOOL_NAME);
			if (!tool) return;
			const updates: unknown[] = [];
			const result = await tool.execute(
				"create-success",
				{ action: "worktree.create", repo, newBranch: "feature-ok", connect: false },
				new AbortController().signal,
				(update) => { updates.push(update); },
				h.ctx,
			);
			const body = resultText(result);
			const details = result.details as { ok?: boolean; sandboxId?: string };
			await check(t, "success body is the reporter's ✓ completion terminus", /^✓ .*indexed \(baseline copy \+ top-up\) in /.test(body), body);
			await check(t, "details carry ok:true and a non-empty sandboxId", details.ok === true && typeof details.sandboxId === "string" && details.sandboxId.length > 0, JSON.stringify(details));
			const sandboxId = details.sandboxId ?? "";
			const sandboxDir = path.join(h.ctx.cwd, "sandboxes", sandboxId);
			await check(
				t,
				"the indexed sandbox exists on disk with its meta",
				fs.existsSync(sandboxDir) && readSandboxMeta(sandboxStateDir(sandboxDir))?.branch === "feature-ok",
				sandboxDir,
			);
			await check(t, "two engine runs happened (baseline + sandbox top-up)", engineInvocations(h.ctx.cwd).length === 2, JSON.stringify(engineInvocations(h.ctx.cwd)));
			await check(t, "connect:false never attempts an MCP connect", connect.mock.callCount() === 0 && listMcpConnections().length === 0, `connects=${connect.mock.callCount()}`);
			await check(
				t,
				"success updates stay pi-shaped throughout",
				updates.length > 0 && updates.every((u) => Array.isArray((u as { content?: unknown }).content) && (u as { details?: { action?: string } }).details?.action === "worktree.create"),
				JSON.stringify(updates).slice(0, 300),
			);
		} finally {
			connect.mock.restore();
		}
	}, { hasUI: false }));

	test("worktree.create connect:true connects only after a successful index", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		seedCreateRoots(h);
		process.env.CHHOUND_BINARY = writeFakeEngine(h.ctx.cwd);
		let engineRunsAtConnect = -1;
		let createdId: string | undefined;
		const connect = t.mock.method(Client.prototype, "connect", async () => { engineRunsAtConnect = engineInvocations(h.ctx.cwd).length; });
		const listTools = t.mock.method(Client.prototype, "listTools", (async () => ({
			tools: [{ name: "search", description: "fixture", inputSchema: { type: "object" } }],
		})) as unknown as typeof Client.prototype.listTools);
		const close = t.mock.method(Client.prototype, "close", async () => undefined);
		try {
			const tool = h.tools.get(MODEL_TOOL_NAME);
			if (!tool) return;
			const result = await tool.execute(
				"create-connect",
				{ action: "worktree.create", repo, newBranch: "feature-connect", connect: true },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			const body = resultText(result);
			const details = result.details as { ok?: boolean; sandboxId?: string };
			createdId = details.sandboxId;
			await check(t, "create still succeeds with an explicit connect request", /^✓ /.test(body) && details.ok === true && Boolean(details.sandboxId), body);
			await check(t, "connect is attempted exactly once", connect.mock.callCount() === 1 && listMcpConnections().length === 1, `connects=${connect.mock.callCount()} live=${listMcpConnections().length}`);
			await check(t, "both index runs completed before the connect handshake", engineRunsAtConnect === 2, `engine runs at connect=${engineRunsAtConnect}`);
		} finally {
			if (createdId && listMcpConnections().some((conn) => conn.id === createdId)) await disconnectMcp(createdId).catch(() => undefined);
			connect.mock.restore();
			listTools.mock.restore();
			close.mock.restore();
		}
	}, { hasUI: false }));

	test("a late connect failure preserves the create success (ok:true)", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		seedCreateRoots(h);
		// The fake engine indexes fine but does not implement `mcp`, so the
		// post-create connect fails for real AFTER the ✓ completion.
		process.env.CHHOUND_BINARY = writeFakeEngine(h.ctx.cwd);
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		const updates: unknown[] = [];
		const result = await tool.execute(
			"create-late-connect-failure",
			{ action: "worktree.create", repo, newBranch: "feature-late", connect: true },
			new AbortController().signal,
			(update) => { updates.push(update); },
			h.ctx,
		);
		const body = resultText(result);
		const details = result.details as { ok?: boolean; sandboxId?: string };
		await check(t, "the create keeps its ✓ success terminus", /^✓ /.test(body) && details.ok === true && Boolean(details.sandboxId), body);
		await check(t, "the late connect failure is surfaced without flipping the outcome", JSON.stringify(updates).includes("Connect failed"), JSON.stringify(updates).slice(-400));
		await check(t, "a failed connect registers no connection", listMcpConnections().length === 0, listMcpConnections().map((conn) => conn.id).join(",") || "(none)");
	}, { hasUI: false }));

	test("worktree.create connect:true never connects when the index fails", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		seedCreateRoots(h);
		process.env.CHHOUND_BINARY = writeFakeEngine(h.ctx.cwd, { failIndex: true });
		const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
		try {
			const tool = h.tools.get(MODEL_TOOL_NAME);
			if (!tool) return;
			const result = await tool.execute(
				"create-fail-connect",
				{ action: "worktree.create", repo, newBranch: "feature-fail", connect: true },
				new AbortController().signal,
				undefined,
				h.ctx,
			);
			const body = resultText(result);
			const details = result.details as { ok?: boolean };
			await check(t, "the failed create reports ok:false and never a ✓ outcome", details.ok === false && !body.startsWith("✓ ") && /failed/i.test(body), body);
			await check(t, "connect is never attempted before success", connect.mock.callCount() === 0 && listMcpConnections().length === 0, `connects=${connect.mock.callCount()} live=${listMcpConnections().map((conn) => conn.id).join(",") || "(none)"}`);
		} finally {
			connect.mock.restore();
		}
	}, { hasUI: false }));

	test("worktree.create abort yields no false success and clears the widget", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const repo = makeGitRepo(h);
		seedCreateRoots(h);
		process.env.CHHOUND_BINARY = writeFakeEngine(h.ctx.cwd);
		const tool = h.tools.get(MODEL_TOOL_NAME);
		if (!tool) return;
		const controller = new AbortController();
		controller.abort();
		const updates: unknown[] = [];
		const result = await tool.execute(
			"create-abort",
			{ action: "worktree.create", repo, newBranch: "feature-abort" },
			controller.signal,
			(update) => { updates.push(update); },
			h.ctx,
		);
		const body = resultText(result);
		const details = result.details as { ok?: boolean; sandboxId?: string };
		await check(t, "an aborted create never claims success", details.ok === false && details.sandboxId === undefined && !body.startsWith("✓ "), body);
		await check(t, "the abort failure reaches the model", /failed|abort/i.test(body), body);
		await check(t, "an aborted create never spawns the engine", engineInvocations(h.ctx.cwd).length === 0, JSON.stringify(engineInvocations(h.ctx.cwd)));
		await check(t, "abort updates stay pi-shaped", updates.length > 0 && updates.every((u) => Array.isArray((u as { content?: unknown }).content)), JSON.stringify(updates).slice(0, 200));
		const own = h.widgets.filter((w) => w.key === MODEL_WORKTREE_WIDGET_KEY);
		await check(t, "the TUI widget is cleared in the finally", own.length >= 1 && own[own.length - 1]!.content === undefined, JSON.stringify(own.slice(-1)));
	}, { hasUI: true }));
});
