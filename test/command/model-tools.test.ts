import { describe, test } from "node:test";
import { loadSettings, saveSettings } from "../../chhound/settings.js";
import { listMcpConnections } from "../../mcp/manager.js";
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

	test("setup.show never emits persisted API keys", async (t) => withPiHarness(async (h) => {
		await runExtension(h.pi);
		const seeded = loadSettings().settings;
		seeded.embedding = { ...seeded.embedding, apiKey: "emb-secret" };
		seeded.llm = { ...seeded.llm, apiKey: "llm-secret" };
		saveSettings(seeded, "global");
		const result = await execute(h, { action: "setup.show" });
		const body = result.content.map((part) => part.text).join("\n");
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
