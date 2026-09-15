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
	const notifications: Array<{ msg: string; type: string }> = [];
	return {
		ctx: {
			cwd,
			hasUI: false,
			pi: {},
			ui: {
				notify: (msg: string, type: string) => { notifications.push({ msg, type }); },
				input: async () => input.shift(),
				select: async () => select.shift(),
				confirm: async () => false,
			},
		},
		notifications,
	};
}

describe("worktree wizard outcomes", () => {
	test("repo-picker cancellation returns cancelled", async (t) => {
		const { runWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const fake = fakeCtx(process.cwd(), [], [undefined]);
			const outcome = await runWizard(fake.ctx as never, {} as never);
			await check(t, "select undefined is an explicit cancellation", outcome.kind === "cancelled", JSON.stringify(outcome));
			await check(t, "direct cancellation keeps its info notification", fake.notifications.some(({ msg, type }) => msg === "Cancelled." && type === "info"), JSON.stringify(fake.notifications));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("manager-launched cancellation suppresses only its Cancelled notification", async (t) => {
		const { runWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const fake = fakeCtx(process.cwd(), [], [undefined]);
			const outcome = await runWizard(fake.ctx as never, {} as never, undefined, { suppressCancelNotify: true });
			await check(t, "manager cancellation remains explicit", outcome.kind === "cancelled", JSON.stringify(outcome));
			await check(t, "manager cancellation emits no Cancelled notification", !fake.notifications.some(({ msg }) => msg === "Cancelled."), JSON.stringify(fake.notifications));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("branch prompt cancellation uses input fallback and returns cancelled", async (t) => {
		const { runBranchWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const repoRoot = path.join(root, "repo");
			await fs.mkdir(repoRoot);
			const outcome = await runBranchWizard(fakeCtx(repoRoot, [undefined]).ctx as never, {} as never, repoRoot);
			await check(t, "branch input cancellation is explicit", outcome.kind === "cancelled", JSON.stringify(outcome));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("invalid PR URL returns failed", async (t) => {
		const { runPrWizard } = await import("../../worktree/command.js");
		const outcome = await runPrWizard(fakeCtx(process.cwd(), []).ctx as never, {} as never, "not-a-pr-url");
		await check(t, "invalid PR input is a failure", outcome.kind === "failed", JSON.stringify(outcome));
	});

	test("exhausted PR URL attempts fail and retain error notifications", async (t) => {
		const { runWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const fake = fakeCtx(process.cwd(), ["bad-one", "bad-two", "bad-three"], ["a pull request — paste its GitHub URL"]);
			const outcome = await runWizard(fake.ctx as never, {} as never);
			await check(t, "exhausted PR URL prompt is failed, not cancelled", outcome.kind === "failed", JSON.stringify(outcome));
			await check(t, "PR URL errors remain visible", fake.notifications.filter(({ type }) => type === "error").length === 4, JSON.stringify(fake.notifications));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("terminal library-root overlap fails rather than cancelling", async (t) => {
		const [{ runBranchWizard, resolveSandboxLocation }, { sandboxStateDir, writeSandboxMeta }] = await Promise.all([
			import("../../worktree/command.js"),
			import("../../chhound/sandbox.js"),
		]);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			const library = path.join(root, "library");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: library } }));
			const repoRoot = path.join(root, "repo");
			await fs.mkdir(repoRoot);
			const location = resolveSandboxLocation(repoRoot, undefined, {} as never, library);
			const stateDir = sandboxStateDir(location.sandboxDir);
			await fs.mkdir(stateDir, { recursive: true });
			writeSandboxMeta(stateDir, {
				version: 1, worktree: location.wtPath, repoRoot, branch: "repo-wt", baseRef: "main", baseCommit: "test", chhoundVersion: "test", createdAt: "2026-09-14T00:00:00.000Z", copiedFrom: "", dbPath: path.join(stateDir, ".chhound.db"),
			} as never);
			const fake = fakeCtx(repoRoot, ["", "", "", "", ""]);
			const outcome = await runBranchWizard(fake.ctx as never, {} as never, repoRoot);
			await check(t, "terminal overlap is failed, not cancelled", outcome.kind === "failed", JSON.stringify(outcome));
			await check(t, "terminal overlap keeps its error notification", fake.notifications.some(({ msg, type }) => type === "error" && msg.startsWith("Blocked:")), JSON.stringify(fake.notifications));
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("ok create result without a non-empty sandboxId is failed (V2-14)", async (t) => {
		// The real createIndexedWorktree only resolves ok:true together with the
		// sandbox dir's basename, so the wizard's success predicate is
		// `created.ok && created.sandboxId` — not merely `created.ok`.
		const { runBranchWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const repoRoot = path.join(root, "repo");
			const library = path.join(root, "library");
			await fs.mkdir(repoRoot);
			for (const result of [{ ok: true }, { ok: true, sandboxId: "" }] as const) {
				const outcome = await runBranchWizard(fakeCtx(repoRoot, ["", library]).ctx as never, {} as never, repoRoot, { create: async () => result });
				await check(t, `ok:true with sandboxId ${JSON.stringify(result.sandboxId)} stays failed, not created`, outcome.kind === "failed", JSON.stringify(outcome));
			}
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("injected create result becomes created or failed", async (t) => {
		const { runBranchWizard } = await import("../../worktree/command.js");
		const env = snapshotEnv();
		const root = await makeFixtureRoot("ch-worktree-wizard-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const repoRoot = path.join(root, "repo");
			const library = path.join(root, "library");
			await fs.mkdir(repoRoot);
			for (const result of [{ ok: true, sandboxId: "repo-branch" }, { ok: false }] as const) {
				const outcome = await runBranchWizard(fakeCtx(repoRoot, ["", library]).ctx as never, {} as never, repoRoot, { create: async () => result });
				await check(t, `${result.ok ? "ok" : "failed"} create result maps through real branch flow`, result.ok ? outcome.kind === "created" && outcome.sandboxId === "repo-branch" : outcome.kind === "failed", JSON.stringify(outcome));
			}
		} finally {
			restoreEnv(env);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
