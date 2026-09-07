export type Tier = "unit" | "fs" | "command" | "robustness/fs" | "engine" | "robustness/engine" | "acceptance";

export interface TestClassification {
	tier: Tier;
	subject: string;
	features?: readonly string[];
}

/** Every discovered test must have exactly one entry here. */
export const manifest: Readonly<Record<string, TestClassification>> = {
	"acceptance/legacy-smoke.test.ts": { tier: "acceptance", subject: "legacy-smoke" },
	"command/extension-entry.test.ts": { tier: "command", subject: "extension-entry" },
	"command/path-input.test.ts": { tier: "command", subject: "path-input" },
	"command/setup-settings.test.ts": { tier: "command", subject: "setup-settings" },
	"engine/baseline.test.ts": { tier: "engine", subject: "baseline" },
	"engine/mcp-bridge.test.ts": { tier: "engine", subject: "mcp-bridge" },
	"engine/mcp-restore.test.ts": { tier: "engine", subject: "mcp-restore" },
	"engine/pr-baseline.test.ts": { tier: "engine", subject: "pr-baseline" },
	"engine/sandbox-hotstart.test.ts": { tier: "engine", subject: "sandbox-hotstart" },
	"fs/baseline-gc.test.ts": { tier: "fs", subject: "baseline-gc" },
	"fs/completions.test.ts": { tier: "fs", subject: "completions" },
	"fs/config.test.ts": { tier: "fs", subject: "config" },
	"fs/copy-tree.test.ts": { tier: "fs", subject: "copy-tree" },
	"fs/git-branches.test.ts": { tier: "fs", subject: "git-branches" },
	"fs/pr-host.test.ts": { tier: "fs", subject: "pr-host" },
	"fs/sandbox-catalog.test.ts": { tier: "fs", subject: "sandbox-catalog" },
	"fs/sandbox-location.test.ts": { tier: "fs", subject: "sandbox-location" },
	"fs/settings.test.ts": { tier: "fs", subject: "settings" },
	"robustness/engine/mcp-death.test.ts": { tier: "robustness/engine", subject: "mcp-death" },
	"unit/args.test.ts": { tier: "unit", subject: "args" },
	"unit/connection-records.test.ts": { tier: "unit", subject: "connection-records" },
	"unit/mcp-view.test.ts": { tier: "unit", subject: "mcp-view" },
	"unit/pr-identity.test.ts": { tier: "unit", subject: "pr-identity" },
	"unit/progress.test.ts": { tier: "unit", subject: "progress" },
	"unit/worktree-intent.test.ts": { tier: "unit", subject: "worktree-intent" },
};

export const tierOrder: readonly Tier[] = [
	"unit",
	"fs",
	"command",
	"robustness/fs",
	"engine",
	"robustness/engine",
	"acceptance",
];

export const tierTimeoutMs: Readonly<Record<Tier, number>> = {
	unit: 15_000,
	fs: 45_000,
	command: 30_000,
	"robustness/fs": 45_000,
	engine: 120_000,
	"robustness/engine": 120_000,
	acceptance: 300_000,
};
