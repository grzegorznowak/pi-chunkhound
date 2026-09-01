import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeAllMcp, reRegisterBridgeTools } from "./mcp/manager.js";
import { registerMcpCommand } from "./mcp/command.js";
import { rehydrateConnections, restoreConnections } from "./mcp/persist.js";
import { loadSettings } from "./chhound/settings.js";
import type { PluginState } from "./chhound/types.js";
import { ChhoundArgumentProvider } from "./chhound/provider-wrap.js";
import { registerSetupCommand } from "./setup/command.js";
import { registerStatusCommand } from "./status/command.js";
import { registerWorktreeCommand } from "./worktree/command.js";

export default function (pi: ExtensionAPI): void {
	const state: PluginState = {};
	registerSetupCommand(pi, state);
	registerWorktreeCommand(pi, state);
	registerStatusCommand(pi, state);
	registerMcpCommand(pi, state);

	// Replay live MCP bridge tools into this session's extension object. pi
	// re-runs the factory per session (main, spawned children, /reload registry
	// rebuilds), and tools registered at runtime — like /ch-mcp's chh_* — would
	// otherwise exist only in the session that connected, making them invisible
	// to spawned children (their tool whitelist is built from the parent's
	// active tools but resolved against their own registry). No-ops when no
	// connection is live.
	reRegisterBridgeTools(pi);

	// Tear down any live chunkhound MCP connections on session end / /reload
	// (chunkhound daemons shut themselves down when their client disconnects).
	// session_start then restores the session's recorded connections.
	pi.on("session_shutdown", () => {
		void closeAllMcp();
	});

	// Auto-reconnect: rebuild the session's desired connection set from the
	// session log (pi.appendEntry records written by /ch-mcp) and connect
	// anything missing. session_shutdown closes all connections (the daemon
	// stops itself when its last client detaches), so this is what brings the
	// chh_* tools back on resume, restart, and /reload. Spawned children never
	// fire session_start — they only inherit live connections via the factory
	// replay above, so no child ever triggers a daemon spawn here.
	pi.on("session_start", (_event, ctx) => {
		void restoreConnections(pi, loadSettings(ctx.cwd).settings, rehydrateConnections(ctx.sessionManager.getBranch()), {
			apiKey: state.apiKey,
		});

		// TAB in /chworktree's argument position must show the plugin's dir picker
		// (pristine pi's TAB opens its own file picker there). pi resets all
		// autocomplete provider wrappers on /reload, so registering on every
		// session_start is safe and self-healing.
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((current) => new ChhoundArgumentProvider(current));
	});
}
