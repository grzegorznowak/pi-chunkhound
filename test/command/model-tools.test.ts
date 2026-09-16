import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadSettings, saveSettings } from "../../chhound/settings.js";
import { sandboxDbDir, sandboxStateDir, writeSandboxMeta } from "../../chhound/sandbox.js";
import type { SandboxMeta } from "../../chhound/types.js";
import { listMcpConnections } from "../../mcp/manager.js";
import { progressRelay, worktreeOutcomeText } from "../../model-tools.js";
import { resolveSandboxLocation } from "../../worktree/command.js";
import { check } from "../lib/checks.js";
import { fireToolCall, MODEL_ACTIONS, MODEL_TOOL_NAME, MUTATING_ACTIONS, READ_ACTIONS, runExtension, withPiHarness, type PiHarness } from "../lib/pi-harness.js";

async function execute(h: PiHarness, input: Record<string, unknown>) {
	const tool = h.tools.get(MODEL_TOOL_NAME);
	if (!tool) throw new Error(`Missing factory registration: ${MODEL_TOOL_NAME}`);
	return tool.execute("test-call", input, new AbortController().signal, undefined, h.ctx);
}
async function errorText(body: () => Promise<unknown>): Promise<string> {
	try { await body(); return ""; } catch (error) { return String(error); }
}
function forbiddenSchema(node: unknown): boolean {
	if (!node || typeof node !== "object") return false;
	return Object.entries(node).some(([key, value]) => ["anyOf", "oneOf", "$ref", "const"].includes(key) || forbiddenSchema(value));
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
		relay({ kind: "line", line: "Indexing 1/3" });
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
			updates.map((u) => (u.content as Array<{ text?: string }>)[0]?.text).join(" | ") === "Connected to sb | Indexing 1/3 | [index] | warm start | plain line",
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
		const repo = path.join(h.ctx.cwd, "repo");
		fs.mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
		// A non-empty target is refused by oneGoLocation before create runs; the
		// refusal reason must reach the model instead of a generic message.
		const location = resolveSandboxLocation(repo, "feature-x", loadSettings(repo).settings);
		fs.mkdirSync(location.wtPath, { recursive: true });
		fs.writeFileSync(path.join(location.wtPath, "leftover.txt"), "x");
		const error = await errorText(() => execute(h, { action: "worktree.create", repo, newBranch: "feature-x" }));
		await check(t, "refusal reason is the error", error.includes("exists and is not empty"), error);
		await check(t, "generic location failure is not the message", !error.includes("could not select a safe worktree location"), error);
	}, { hasUI: false }));

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
});
