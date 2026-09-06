export type Tier = "unit" | "fs" | "command" | "robustness/fs" | "engine" | "robustness/engine" | "acceptance";

export interface TestClassification {
	tier: Tier;
	subject: string;
	features?: readonly string[];
}

/** Every discovered test must have exactly one entry here. */
export const manifest: Readonly<Record<string, TestClassification>> = {
	"acceptance/legacy-smoke.test.ts": { tier: "acceptance", subject: "legacy-smoke" },
	"unit/args.test.ts": { tier: "unit", subject: "args" },
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
