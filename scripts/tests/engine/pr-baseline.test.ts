import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ensureBaseline } from "../../../chhound/baseline.js";
import { runGit } from "../../../chhound/git.js";
import type { ChhoundSettings } from "../../../chhound/types.js";
import { check } from "../lib/checks.js";
import { resolveEngineBinary } from "../lib/engine.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 2 legacy checks moved from smoke.ts section 17 (PR resolution,
// hermetic) — the real mirror-anchor obligations: ensureBaseline against a
// pre-seeded bare mirror (its local heads ARE the remote tips) anchors at the
// PR's base branch and is reused when fresh. SELF-OWNED fixture — the legacy
// section reused the mirror seeded by the shared host-ladder code, which now
// lives in fs/pr-host.test.ts. Pure URL parsing: unit/pr-identity.test.ts.

describe("pr baseline", () => {
	test("legacy PR base anchor obligations", async (t) => {
		// Engine resolution must happen BEFORE env isolation (isolatedEnv strips
		// CHHOUND_BINARY); the resolved binary is re-injected via overrides.
		const engine = await resolveEngineBinary();
		console.log(`engine: ${engine.binary} (${engine.version})`);
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-engine-pr-baseline-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_BINARY: engine.binary } }));
			const settings: ChhoundSettings = {
				version: 1,
				sandboxRoot: path.join(root, "sandboxes"),
				baseRoot: path.join(root, "bases"),
				mirrorRoot: path.join(root, "mirrors"),
				// Materialized engine configs force watchman by default; the
				// config file wins over the env var, so polling is set in the
				// settings the configs are materialized from.
				indexing: { realtimeBackend: "polling" },
			};
			const git = async (args: string[], opts: { cwd?: string } = {}): Promise<void> => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
			};
			const gitOk = async (args: string[], opts: { cwd?: string } = {}) => {
				const r = await runGit(args, opts);
				if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
				return r.stdout;
			};

			// Mirror fixture: bare clone carrying refs/heads/main == the base tip
			// (what the fs/pr-host mirror produces; no refs/pull needed here).
			const seed = path.join(root, "pr-seed");
			fs.mkdirSync(seed);
			await git(["init", "-q", "-b", "main"], { cwd: seed });
			await git(["config", "user.email", "smoke@test"], { cwd: seed });
			await git(["config", "user.name", "Smoke"], { cwd: seed });
			fs.writeFileSync(path.join(seed, "a.ts"), "export const a = 1;\n");
			await git(["add", "-A"], { cwd: seed });
			await git(["commit", "-qm", "init"], { cwd: seed });
			const baseSha = await gitOk(["rev-parse", "HEAD"], { cwd: seed });
			const mirror = path.join(root, "pr-mirror.git");
			await git(["clone", "-q", "--bare", seed, mirror], { cwd: root });

			const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
			const extraArgs = ["--no-embeddings"];
			const prBase = await ensureBaseline({ repoRoot: mirror, settings, ref: "main", onLine, extraArgs });
			await check(t, "PR base baseline primed from mirror", prBase.fresh && prBase.meta.baseCommit === baseSha, `${prBase.ref} @ ${prBase.meta.baseCommit.slice(0, 8)}`);
			const prBase2 = await ensureBaseline({ repoRoot: mirror, settings, ref: "main", onLine, extraArgs });
			await check(t, "PR base baseline reused when fresh", prBase2.fresh === false, prBase2.reason);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
