import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxEntry } from "../../chhound/sandbox.js";
import * as mcp from "../../mcp/manager.js";
import { check } from "../lib/checks.js";
import { runExtension, withPiHarness } from "../lib/pi-harness.js";

const GLOBAL_NAMES = ["websearch", "fetchurl"] as const;
const MCP_TOOLS = ["search", "code_research", "daemon_status", ...GLOBAL_NAMES].map((name) => ({
	name,
	description: `fixture ${name}`,
	inputSchema: { type: "object" as const, properties: {} },
}));
const PREFIX = "chh_fixture";
const EXPECTED_BRIDGE_NAMES = ["search", "code_research", "daemon_status"].map((name) => `${PREFIX}_${name}`).sort();

function registrationsNamed(registrations: readonly { name: string }[], names: readonly string[]): string[] {
	return registrations.map((tool) => tool.name).filter((name) => names.includes(name)).sort();
}

function fixtureEntry(root: string): SandboxEntry {
	const dir = path.join(root, "fixture-sandbox");
	const stateDir = path.join(root, ".state", "fixture-sandbox");
	// main's connect path re-checks storage presence mid-flight (review V2-06),
	// so the fixture sandbox must exist on disk while connecting.
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	return {
		dir,
		stateDir,
		dbSizeBytes: 0,
		meta: {
			version: 1,
			worktree: path.join(dir, "fixture"),
			branch: "fixture",
			baseRef: "main",
			baseCommit: "0".repeat(40),
			chhoundVersion: "fixture",
			createdAt: new Date(0).toISOString(),
			copiedFrom: "",
			dbPath: path.join(root, "fixture.duckdb"),
		},
	};
}

type DirectBridgeRegistration = (
	pi: ExtensionAPI,
	id: string,
	piName: string,
	tool: { name: string; description?: string; inputSchema?: unknown },
) => void;

describe("global web tool registration and bridge exclusion (initially RED)", () => {
	test("factory registers the two unprefixed tools once with zero connections", async (t) => withPiHarness(async (h) => {
		await check(t, "fixture starts with zero MCP connections", mcp.listMcpConnections().length === 0);
		await runExtension(h.pi);
		await check(
			t,
			"exactly websearch and fetchurl are globally registered once each",
			JSON.stringify(registrationsNamed(h.registrations, GLOBAL_NAMES)) === JSON.stringify([...GLOBAL_NAMES].sort()),
			`registered: ${h.registrations.map((tool) => tool.name).join(", ") || "(none)"}`,
		);
		mcp.reRegisterBridgeTools(h.pi);
		mcp.reRegisterBridgeTools(h.pi);
		await check(
			t,
			"bridge replay with no connections never duplicates global tools",
			JSON.stringify(registrationsNamed(h.registrations, GLOBAL_NAMES)) === JSON.stringify([...GLOBAL_NAMES].sort()),
			registrationsNamed(h.registrations, GLOBAL_NAMES).join(", ") || "(none)",
		);
	}));

	test("a fake five-tool MCP connection exposes only three prefixed bridge tools", async (t) => withPiHarness(async (h) => {
		const connect = t.mock.method(Client.prototype, "connect", async () => undefined);
		const listTools = t.mock.method(Client.prototype, "listTools", async () => ({ tools: MCP_TOOLS }));
		const close = t.mock.method(Client.prototype, "close", async () => undefined);
		let id: string | undefined;
		try {
			const conn = await mcp.connectMcp(h.pi, fixtureEntry(h.ctx.cwd), { prefix: PREFIX });
			id = conn.id;
			await check(t, "SDK connection was faked without starting stdio", connect.mock.callCount() === 1 && listTools.mock.callCount() === 1);
			await check(
				t,
				"connect registers exactly the three codebase-scoped names",
				JSON.stringify(conn.toolNames.slice().sort()) === JSON.stringify(EXPECTED_BRIDGE_NAMES),
				conn.toolNames.join(", "),
			);
			await check(
				t,
				"no prefixed websearch or fetchurl bridge leaked",
				!h.registrations.some((tool) => tool.name === `${PREFIX}_websearch` || tool.name === `${PREFIX}_fetchurl`),
				h.registrations.map((tool) => tool.name).join(", "),
			);

			// Factory execution represents the live-connection restore/replay path.
			await runExtension(h.pi);
			const originalGlobals = new Map(GLOBAL_NAMES.map((name) => [name, h.tools.get(name)]));
			await check(t, "both standalone tools still exist beside a connected bridge", GLOBAL_NAMES.every((name) => originalGlobals.get(name) !== undefined));
			mcp.reRegisterBridgeTools(h.pi, [conn]);
			mcp.reRegisterBridgeTools(h.pi, [conn]);
			await check(
				t,
				"restore/replay does not duplicate or replace standalone tools",
				GLOBAL_NAMES.every((name) => h.tools.get(name) === originalGlobals.get(name))
					&& registrationsNamed(h.registrations, GLOBAL_NAMES).length === 2,
				registrationsNamed(h.registrations, GLOBAL_NAMES).join(", ") || "(none)",
			);
		} finally {
			if (id && mcp.getMcpConnection(id)) await mcp.disconnectMcp(id);
			connect.mock.restore();
			listTools.mock.restore();
			close.mock.restore();
		}
	}));

	test("direct bridge registration skips global tool metadata", async (t) => withPiHarness(async (h) => {
		const direct = (mcp as typeof mcp & { registerBridgeTool?: DirectBridgeRegistration }).registerBridgeTool;
		await check(t, "registerBridgeTool is exported as the direct seam", typeof direct === "function", "Missing export mcp/manager.ts:registerBridgeTool");
		if (!direct) return;
		for (const name of GLOBAL_NAMES) {
			direct(h.pi, "fixture", `${PREFIX}_${name}`, { name, description: `fixture ${name}`, inputSchema: { type: "object", properties: {} } });
		}
		await check(
			t,
			"direct calls for websearch/fetchurl register nothing",
			h.registrations.length === 0,
			h.registrations.map((tool) => tool.name).join(", "),
		);
	}));
});
