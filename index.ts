import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeAllMcp } from "./mcp/manager.js";
import { registerMcpCommand } from "./mcp/command.js";
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

	// Tear down any live chunkhound MCP connections on session end / /reload
	// (chunkhound daemons shut themselves down when their client disconnects).
	pi.on("session_shutdown", () => {
		void closeAllMcp();
	});

	// TAB in /chworktree's argument position must show the plugin's dir picker
	// (pristine pi's TAB opens its own file picker there). pi resets all
	// autocomplete provider wrappers on /reload, so registering on every
	// session_start is safe and self-healing.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((current) => new ChhoundArgumentProvider(current));
	});
}
