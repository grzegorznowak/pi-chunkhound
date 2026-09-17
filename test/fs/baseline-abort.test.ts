import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { baselineDirFor, ensureBaseline } from "../../chhound/baseline.js";
import { runChhound } from "../../chhound/cli.js";
import type { ChhoundSettings } from "../../chhound/types.js";
import { check } from "../lib/checks.js";
import { applyEnv, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

function fixtureSettings(root: string): ChhoundSettings {
	return { version: 1, baseRoot: path.join(root, "bases"), sandboxRoot: path.join(root, "sandboxes") };
}

function makeGitRepo(root: string): string {
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
	git("add", "-A");
	git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init");
	return repo;
}

function writeScript(root: string, name: string, body: string): string {
	const p = path.join(root, name);
	fs.writeFileSync(p, body, { mode: 0o755 });
	return p;
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

// Inventory: abort seam obligations (F2-03) — pre-abort spawns nothing,
// cancellable lock wait never touches another owner's lock, and an abort in
// flight releases the lock + removes db/config/temp worktree. No real engine:
// CHHOUND_BINARY is a fixture script.
describe("abort seam (baseline prime + engine runner)", () => {
	test("pre-aborted runs and primes never spawn the engine", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-baseline-abort-");
		const env = snapshotEnv();
		try {
			const marker = path.join(root, "spawned.marker");
			applyEnv({ ...env, CHHOUND_BINARY: writeScript(root, "fake-engine", `#!/bin/sh\ntouch "${marker}"\nexit 0\n`) });
			const controller = new AbortController();
			controller.abort();
			let runError: unknown;
			try { await runChhound(["--version"], { signal: controller.signal }); } catch (e) { runError = e; }
			await check(t, "pre-aborted runChhound rejects with AbortError", (runError as Error)?.name === "AbortError", String(runError));
			await check(t, "pre-aborted runChhound never spawns", !fs.existsSync(marker));
			const repo = makeGitRepo(root);
			const settings = fixtureSettings(root);
			let primeError: unknown;
			try { await ensureBaseline({ repoRoot: repo, settings, signal: controller.signal }); } catch (e) { primeError = e; }
			await check(t, "pre-aborted ensureBaseline rejects with AbortError", (primeError as Error)?.name === "AbortError", String(primeError));
			await check(t, "pre-aborted ensureBaseline creates no baseline dir", !fs.existsSync(baselineDirFor(repo, "main", settings)));
			await check(t, "pre-aborted ensureBaseline never spawns", !fs.existsSync(marker));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("settled engine runs remove their abort listener", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-runner-listener-");
		const env = snapshotEnv();
		try {
			applyEnv({ ...env, CHHOUND_BINARY: writeScript(root, "ok-engine", "#!/bin/sh\nexit 0\n") });
			const controller = new AbortController();
			const result = await runChhound(["index", root], { signal: controller.signal });
			await check(t, "run completes", result.code === 0);
			const listeners = getEventListeners(controller.signal, "abort").length;
			await check(t, "abort listener removed on settle", listeners === 0, `listeners=${listeners}`);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("abort while waiting for a live prime lock keeps the lock and returns promptly", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-lock-abort-");
		const env = snapshotEnv();
		try {
			applyEnv({ ...env, CHHOUND_BINARY: writeScript(root, "version-engine", "#!/bin/sh\necho 9.9.9\nexit 0\n") });
			const repo = makeGitRepo(root);
			const settings = fixtureSettings(root);
			const dir = baselineDirFor(repo, "main", settings);
			fs.mkdirSync(dir, { recursive: true });
			const lockPath = path.join(dir, ".prime.lock");
			fs.writeFileSync(lockPath, String(process.pid)); // live foreign owner
			const controller = new AbortController();
			const started = Date.now();
			const pending = ensureBaseline({ repoRoot: repo, settings, ref: "main", signal: controller.signal });
			setTimeout(() => controller.abort(), 150);
			let error: unknown;
			try { await pending; } catch (e) { error = e; }
			const elapsed = Date.now() - started;
			await check(t, "waiting prime rejects with AbortError", (error as Error)?.name === "AbortError", String(error));
			await check(t, "cancellable lock wait returns promptly", elapsed < 1500, `elapsed=${elapsed}ms`);
			await check(
				t,
				"the other owner's lock is untouched",
				fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8") === String(process.pid),
				`exists=${fs.existsSync(lockPath)}`,
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("abort during a prime cleans up lock, db, config and temp worktree", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-prime-abort-");
		const env = snapshotEnv();
		try {
			const startedMarker = path.join(root, "indexing.marker");
			const script = writeScript(
				root,
				"slow-engine",
				`#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9"; exit 0;;\nesac\ntouch "${startedMarker}"\nexec sleep 30\n`,
			);
			applyEnv({ ...env, CHHOUND_BINARY: script });
			const repo = makeGitRepo(root);
			const settings = fixtureSettings(root);
			const dir = baselineDirFor(repo, "main", settings);
			const controller = new AbortController();
			const pending = ensureBaseline({ repoRoot: repo, settings, ref: "main", signal: controller.signal });
			const indexed = await until(() => fs.existsSync(startedMarker), 10_000);
			await check(t, "engine index started", indexed, `marker=${startedMarker}`);
			controller.abort();
			let error: unknown;
			try { await pending; } catch (e) { error = e; }
			await check(t, "aborted prime rejects", error instanceof Error, String(error));
			await check(t, "prime lock released", !fs.existsSync(path.join(dir, ".prime.lock")));
			await check(t, "partial db removed", !fs.existsSync(path.join(dir, "db", ".chunkhound.db")));
			await check(t, "materialized config removed", !fs.existsSync(path.join(dir, ".chunkhound.json")));
			await check(t, "no meta written", !fs.existsSync(path.join(dir, "meta.json")));
			const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString();
			const worktrees = porcelain.split("\n").filter((line) => line.startsWith("worktree ")).length;
			await check(t, "temp prime worktree removed", worktrees === 1, porcelain);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
