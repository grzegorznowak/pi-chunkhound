import * as fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../chhound/args.js";
import { ensureBaseline } from "../chhound/baseline.js";
import { chhoundApiKeyEnv } from "../chhound/cli.js";
import { worktreeArgumentCompletions } from "../chhound/completions.js";
import { adoptConfigFile, materializeConfig } from "../chhound/config.js";
import { currentBranch, findRepoRoot, gitRootOrNull, gitWorktreeAdd, repoExcludePath } from "../chhound/git.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import { createProgressUI, formatElapsed } from "../chhound/progress.js";
import { sandboxConfigPath, sandboxDbDir, sandboxDirFor, writeSandboxMeta } from "../chhound/sandbox.js";
import { loadSettings } from "../chhound/settings.js";
import type { PluginState } from "../chhound/types.js";

const HELP = [
	"/chworktree <path> [branch] [options]",
	"",
	"required:",
	"  <path>             directory for the new worktree (folder picker: TAB)",
	"optional:",
	"  [branch]           existing branch to check out",
	"  -b <name>          create a new branch",
	"  --from <ref>       base commit/branch/tag for the worktree",
	"  --config <file>    adopt an existing chunkhound.json for this worktree",
	"  --no-index         skip indexing (worktree only)",
	"  --force-reindex    full re-index instead of baseline top-up",
	"  --refresh-baseline force baseline re-prime",
	"",
	"Each worktree gets its own chunkhound index: baseline copy + top-up at the",
	"branch point. Indexes live in the sandbox library, not in the worktree.",
].join("\n");

export function registerWorktreeCommand(pi: ExtensionAPI, state: PluginState): void {
	pi.registerCommand("chworktree", {
		description:
			"Create a git worktree with its own chunkhound index. " +
			"Usage: /chworktree <path> [branch] [-b <name>] [--from <ref>] [--config <file>] " +
			"[--no-index] [--force-reindex] [--refresh-baseline] — /chworktree --help for details",
		getArgumentCompletions: (argumentPrefix) => worktreeArgumentCompletions(argumentPrefix, process.cwd()),
		handler: async (args, ctx) => {
			const { positionals, flags } = parseArgs(args);
			const notify = (msg: string, type: "info" | "warning" | "error") => ctx.ui.notify(msg, type);

			if (flags["help"] || flags["h"] || !positionals[0]) {
				notify(HELP, "info");
				return;
			}
			const wtArg = positionals[0]!;

			const requestedPath = path.resolve(ctx.cwd, wtArg);

			let repoRoot = await gitRootOrNull(ctx.cwd);
			if (!repoRoot) {
				const probe = fs.existsSync(requestedPath) ? requestedPath : path.dirname(requestedPath);
				repoRoot = await findRepoRoot(probe);
			}
			if (!repoRoot) {
				notify(
					`No git repo found: ${ctx.cwd} is not inside one and ${requestedPath} does not resolve to one. ` +
						`Run /chworktree from inside a repo, or pick a path inside/next to one.`,
					"error",
				);
				return;
			}
			repoRoot = path.resolve(repoRoot);

			// Picking the source repo itself (e.g. `chunkhound/` in the folder picker)
			// means "worktree of this repo" — derive a sibling path instead.
			let target = requestedPath;
			if (target === repoRoot) {
				target = deriveWorktreePath(repoRoot);
				notify(`${wtArg} is the source repo itself — creating the worktree at ${target} instead.`, "info");
			}
			if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
				notify(`Refusing: ${target} exists and is not empty.`, "error");
				return;
			}
			// From here on, `wtPath` is the worktree location.
			const wtPath = target;

			// Branch semantics mirror `git worktree add`:
			//   /chworktree <path> [<existing-branch>]
			//   /chworktree <path> -b <new-branch> [--from <commit-ish>]
			let createBranch: string | undefined;
			let branch: string | undefined;
			let commitIsh: string | undefined;
			if (flags["b"] === true && positionals[1]) {
				createBranch = positionals[1];
			} else if (typeof flags["b"] === "string") {
				createBranch = flags["b"];
			} else if (positionals[1]) {
				branch = positionals[1];
			}
			if (flags["b"] === true && !positionals[1]) {
				notify("-b requires a branch name: /chworktree <path> -b <new-branch>", "error");
				return;
			}
			if (typeof flags["from"] === "string") commitIsh = flags["from"];

			const loaded = loadSettings(repoRoot);
			if (loaded.issue) notify(loaded.issue, "warning");
			const settings = loaded.settings;

			const progress = createProgressUI(ctx);
			try {
				notify(`Creating worktree ${wtPath}…`, "info");
				try {
					await gitWorktreeAdd({ cwd: repoRoot, path: wtPath, createBranch, branch, commitIsh });
				} catch (err) {
					notify(err instanceof Error ? err.message : String(err), "error");
					return;
				}
				const branchNow = await currentBranch(wtPath);

				if (flags["no-index"]) {
					notify(
						`Worktree created (no index): ${wtPath} @ ${branchNow}\nRun /chworktree ${wtArg} --force-reindex later to index it.`,
						"info",
					);
					return;
				}

				// 1) Baseline (primed/refreshed from origin/<ref> when stale)
				progress.setPhase("baseline index");
				notify(
					"⏳ Indexing started — the session is busy until it completes and won't accept new messages meanwhile. " +
						"Progress updates in the footer. Tip: /chworktree --no-index creates the worktree without indexing.",
					"warning",
				);
				const baseline = await ensureBaseline({
					repoRoot,
					settings,
					onLine: progress.setLine,
					force: flags["refresh-baseline"] === true,
					apiKey: state.apiKey,
				});

				// 2) Sandbox: config (no secrets, pinned duckdb) + db copy target
				const sandboxDir = sandboxDirFor(repoRoot, wtPath, settings);
				const dbDir = sandboxDbDir(sandboxDir);
				let adopted;
				if (typeof flags["config"] === "string") {
					try {
						adopted = adoptConfigFile(flags["config"], ctx.cwd).adopted;
					} catch (err) {
						notify(err instanceof Error ? err.message : String(err), "error");
						return;
					}
				}
				const configPath = materializeConfig(sandboxDir, { settings, dbDir, adopted });

				// 3) Keep the worktree clean: git-exclude .chhound artifacts (repo-wide
				//    info/exclude — the only one git reads for linked worktrees)
				const excludePath = await repoExcludePath(wtPath);
				if (excludePath) {
					const extra = [".chhound/", ".chhound.json"].filter((p) => {
						try {
							return !fs.readFileSync(excludePath, "utf8").split("\n").includes(p.trim());
						} catch {
							return true;
						}
					});
					if (extra.length > 0) {
						fs.mkdirSync(path.dirname(excludePath), { recursive: true });
						fs.appendFileSync(excludePath, "\n# pi-chhound\n" + extra.join("\n") + "\n");
					}
				}

				// 4) Sync index: baseline db copy + top-up at the worktree's branch point
				progress.setPhase("worktree index (top-up)");
				notify(
					`Indexing ${wtPath} (top-up from baseline ${baseline.ref} @ ${baseline.meta.baseCommit.slice(0, 12)})…`,
					"info",
				);
				const result = await hotStartIndex({
					sourceDbDir: baseline.dbDir,
					targetDbDir: dbDir,
					indexDir: wtPath,
					configPath,
					forceReindex: flags["force-reindex"] === true,
					env: chhoundApiKeyEnv(state.apiKey),
					onLine: progress.setLine,
				});
				if (result.code !== 0) {
					const tail = result.stderrTail.split("\n").slice(-4).join("\n");
					notify(`Index failed after ${formatElapsed(progress.elapsed())} (code ${result.code}):\n${tail}`, "error");
					return;
				}

				// 5) Meta + summary
				writeSandboxMeta(sandboxDir, {
					version: 1,
					worktree: wtPath,
					branch: branchNow,
					baseRef: baseline.ref,
					baseCommit: baseline.meta.baseCommit,
					chhoundVersion: baseline.meta.chhoundVersion,
					createdAt: new Date().toISOString(),
					copiedFrom: baseline.dbDir,
					dbPath: dbDir,
				});
				notify(
					[
						`✓ ${wtPath} @ ${branchNow} indexed (${result.copied ? "baseline copy + top-up" : "full index"}) in ${formatElapsed(progress.elapsed())}.`,
						`db: ${dbDir}`,
						`config: ${sandboxConfigPath(sandboxDir)}`,
						`Next: cd ${wtPath} && chunkhound mcp --config ${sandboxConfigPath(sandboxDir)}`,
					].join("\n"),
					"info",
				);
			} catch (err) {
				notify(`/chworktree failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				progress.done();
			}
		},
	});
}

/** Sibling worktree location for a repo root: `<repo>-wt`, `<repo>-wt-2`, … */
export function deriveWorktreePath(repoRoot: string): string {
	const parent = path.dirname(repoRoot);
	const base = path.basename(repoRoot);
	let candidate = path.join(parent, `${base}-wt`);
	for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(parent, `${base}-wt-${i}`);
	return candidate;
}
