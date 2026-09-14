import { describe, test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, restoreEnv, snapshotEnv } from "../lib/isolation.js";

// These exercise the real wizard functions. ui.custom is deliberately absent:
// promptText/promptPath must use ui.input in this scripted RPC-like context.
// The connect confirm remains inside createIndexedWorktree; its Yes/No behavior
// is a manual §8 verification, not an artificial outcome mapper test.
function fakeCtx(cwd: string, input: Array<string | undefined>, select: Array<string | undefined> = []) {
	return {
		cwd,
		hasUI: false,
		pi: {},
		ui: {
			notify() {},
			input: async () => input.shift(),
			select: async () => select.shift(),
			confirm: async () => false,
		},
	};
}

describe("worktree wizard outcomes", () => {
	test("repo-picker cancellation returns cancelled", async (t) => {
		const { runWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("chworktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const outcome = await runWizard(fakeCtx(process.cwd(), [], [undefined]) as never, {} as never);
			await check(t, "select undefined is an explicit cancellation", outcome.kind === "cancelled", JSON.stringify(outcome));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("branch prompt cancellation uses input fallback and returns cancelled", async (t) => {
		const { runBranchWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("chworktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const repoRoot = path.join(root, "repo");
			await fs.mkdir(repoRoot);
			const outcome = await runBranchWizard(fakeCtx(repoRoot, [undefined]) as never, {} as never, repoRoot);
			await check(t, "branch input cancellation is explicit", outcome.kind === "cancelled", JSON.stringify(outcome));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("invalid PR URL returns failed", async (t) => {
		const { runPrWizard } = await import("../../worktree/command.js");
		const outcome = await runPrWizard(fakeCtx(process.cwd(), []) as never, {} as never, "not-a-pr-url");
		await check(t, "invalid PR input is a failure", outcome.kind === "failed", JSON.stringify(outcome));
	});

	test("injected create result becomes created or failed", async (t) => {
		const { runBranchWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("chworktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const repoRoot = path.join(root, "repo");
			const library = path.join(root, "library");
			await fs.mkdir(repoRoot);
			for (const result of [{ ok: true, sandboxId: "repo-branch" }, { ok: false }] as const) {
				const outcome = await runBranchWizard(fakeCtx(repoRoot, ["", library]) as never, {} as never, repoRoot, { create: async () => result });
				await check(t, `${result.ok ? "ok" : "failed"} create result maps through real branch flow`, result.ok ? outcome.kind === "created" && outcome.sandboxId === "repo-branch" : outcome.kind === "failed", JSON.stringify(outcome));
			}
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
