import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginState } from "./chhound/types.js";
import { registerSetupCommand } from "./setup/command.js";
import { registerStatusCommand } from "./status/command.js";
import { registerWorktreeCommand } from "./worktree/command.js";

export default function (pi: ExtensionAPI): void {
	const state: PluginState = {};
	registerSetupCommand(pi, state);
	registerWorktreeCommand(pi, state);
	registerStatusCommand(pi, state);
}
