/**
 * Session-log persistence for chhound MCP connections.
 *
 * Notebook concept (pi-agenticoding): records are custom entries in pi's
 * session jsonl (`pi.appendEntry`), rehydrated on `session_start` from
 * `ctx.sessionManager.getBranch()`. Branch-scoped — resume = same branch =
 * same records; fork/new sessions follow pi's branch model (same as notebook
 * pages). Records survive process restarts and /reload because the session
 * log is on disk.
 *
 * Lifecycle:
 * - `/ch-mcp connect` (daemon mode) appends a `connected` record.
 * - `/ch-mcp --disconnect` appends a `disconnected` tombstone (the log is
 *   append-only; later records win per sandbox).
 * - `session_start` rehydrates the branch and reconnects anything missing.
 * - `session_shutdown` closes all connections — the chunkhound daemon stops
 *   itself when its last client detaches (engine's designed behavior).
 *
 * Deliberately NOT recorded: read-only / --no-daemon connections (they force
 * single-process stdio; two of them on one database would clash on the
 * DuckDB file lock) and API keys (re-derived from plugin state at restore —
 * no secrets in the session log).
 */
import path from "node:path";
import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { listSandboxes } from "../chhound/sandbox.js";
import type { SandboxEntry } from "../chhound/sandbox.js";
import type { ChhoundSettings } from "../chhound/types.js";
import { connectMcp, getMcpConnection } from "./manager.js";

export const CONNECTION_ENTRY_TYPE = "chhound-mcp-connection";

const RECORD_VERSION = 1;

export interface ConnectionRecord {
	sandboxId: string;
	state: "connected" | "disconnected";
	/** Optional tool-prefix override, replayed on restore. */
	prefix?: string;
}

function isKnownVersion(value: unknown): boolean {
	return value === undefined || value === RECORD_VERSION;
}

/** Append a connection record to the current session log. */
export function recordConnection(pi: ExtensionAPI, record: ConnectionRecord): void {
	pi.appendEntry(CONNECTION_ENTRY_TYPE, {
		version: RECORD_VERSION,
		sandboxId: record.sandboxId,
		state: record.state,
		...(typeof record.prefix === "string" && record.prefix.length > 0 ? { prefix: record.prefix } : {}),
	});
}

/**
 * Rebuild the desired connection set from a session branch
 * (`ctx.sessionManager.getBranch()`). Later records win; a `disconnected`
 * tombstone beats any older `connected` record for the same sandbox.
 * Unknown record versions and malformed payloads are ignored (notebook
 * convention: version 1 current, absent = legacy, future = rejected).
 */
export function rehydrateConnections(branch: readonly SessionEntry[]): Map<string, ConnectionRecord> {
	const records = new Map<string, ConnectionRecord>();
	for (const entry of branch) {
		if (entry?.type !== "custom") continue;
		const custom = entry as CustomEntry;
		if (custom.customType !== CONNECTION_ENTRY_TYPE) continue;
		const data = custom.data as Record<string, unknown> | undefined;
		if (!data || typeof data !== "object" || Array.isArray(data)) continue;
		if (!isKnownVersion(data.version)) continue;
		const sandboxId = data.sandboxId;
		if (typeof sandboxId !== "string" || sandboxId.length === 0) continue;
		if (data.state !== "connected" && data.state !== "disconnected") continue;
		const record: ConnectionRecord = { sandboxId, state: data.state };
		if (typeof data.prefix === "string" && data.prefix.length > 0) record.prefix = data.prefix;
		records.set(sandboxId, record);
	}
	return records;
}

function sandboxById(settings: ChhoundSettings, id: string): SandboxEntry | undefined {
	return listSandboxes(settings).find((s) => path.basename(s.dir) === id);
}

/**
 * Reconnect every `connected` record that is not already live in this
 * process. Fire-and-forget from session_start (never blocks the session;
 * never rejects — per-record failures are logged and swallowed).
 * Sandboxes that no longer exist get a tombstone so the stale record cannot
 * resurrect on every session start. `settings.autoReconnect === false`
 * disables restore entirely.
 */
export async function restoreConnections(
	pi: ExtensionAPI,
	settings: ChhoundSettings,
	records: Map<string, ConnectionRecord>,
	opts: { apiKey?: string; extraArgs?: string[] } = {},
): Promise<void> {
	if (settings.autoReconnect === false) return;
	const tasks: Promise<void>[] = [];
	for (const record of records.values()) {
		if (record.state !== "connected") continue;
		if (getMcpConnection(record.sandboxId)) continue; // already live (same-process switch)
		const entry = sandboxById(settings, record.sandboxId);
		if (!entry) {
			console.error(`[chhound-mcp] connection record for '${record.sandboxId}' — sandbox no longer exists; forgetting it.`);
			recordConnection(pi, { sandboxId: record.sandboxId, state: "disconnected" });
			continue;
		}
		tasks.push(
			(async () => {
				try {
					const conn = await connectMcp(pi, entry, {
						...(typeof record.prefix === "string" ? { prefix: record.prefix } : {}),
						apiKey: opts.apiKey,
						...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
					});
					console.error(`[chhound-mcp] auto-restored '${conn.id}' → ${conn.worktree} (${conn.toolNames.length} tools)`);
				} catch (e) {
					console.error(`[chhound-mcp] auto-restore failed for '${record.sandboxId}': ${(e as Error).message}`);
				}
			})(),
		);
	}
	await Promise.allSettled(tasks);
}
