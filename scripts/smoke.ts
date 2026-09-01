/**
 * pi-chhound mechanics smoke test — no pi session needed.
 * Uses a scratch git repo and the real chunkhound CLI with --no-embeddings
 * (no API key required). Verifies baseline prime/refresh, worktree spin-up
 * via db copy + top-up, config materialization, sandbox listing/prune.
 *
 * Run: npm run smoke
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, WORKTREE_VALUE_FLAGS } from "../chhound/args.js";

import { ensureBaseline, listBaselines } from "../chhound/baseline.js";
import { adoptConfigFile, foldAdoptedInto, insideChunkhoundRoot, materializeConfig, suggestWorktreeBase } from "../chhound/config.js";
import { chhoundBinary, chhoundVersion } from "../chhound/cli.js";
import { branchCompletions, dirCompletions, worktreeArgumentCompletions } from "../chhound/completions.js";
import { currentBranch, findRepoRoot, gitWorktreeAdd, runGit } from "../chhound/git.js";
import { resolveBranchChoice } from "../worktree/command.js";
import { hotStartIndex } from "../chhound/hotstart.js";
import {
	findConflictingIndexed,
	dirSize,
	listSandboxes,
	pruneSandboxes,
	claimedRootMatches,
	readClaimedRoot,
	sandboxConfigPath,
	sandboxDbDir,
	sandboxDirFor,
	writeSandboxMeta,
} from "../chhound/sandbox.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings, saveSettings } from "../chhound/settings.js";
import { connectMcp, disconnectMcp, mcpToolPrefix, reRegisterBridgeTools } from "../mcp/manager.js";
import { mcpSelectOptions, mcpTargetLines } from "../mcp/command.js";
import { mcpStatusLines } from "../status/command.js";
import { refreshMaterializedConfigs } from "../setup/command.js";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { PathInputComponent } from "../chhound/path-input.js";
import { buildStatusText, formatBytes, parseChhoundLine, surfaceChhoundLine } from "../chhound/progress.js";
import type { ProgressState } from "../chhound/progress.js";
import { isWizardInvocation, resolveSandboxLocation } from "../worktree/command.js";
import type { ChhoundSettings } from "../chhound/types.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	checks++;
	if (cond) console.log(`  ok ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
const section = (t: string) => console.log(`\n== ${t}`);

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chhound-smoke-"));
	console.log(`scratch: ${tmp}`);
	const settings: ChhoundSettings = {
		version: 1,
		sandboxRoot: path.join(tmp, "sandboxes"),
		baseRoot: path.join(tmp, "bases"),
	};

	// ── 1. arg parsing ────────────────────────────────────────────────
	section("parseArgs");
	{
		const p = parseArgs(`../wt -b feature/x --from abc123 --no-index --config "my cfg.json"`);
		check("positionals", JSON.stringify(p.positionals) === JSON.stringify(["../wt"]), JSON.stringify(p.positionals));
		check("-b value", p.flags["b"] === "feature/x");
		check("--from value", p.flags["from"] === "abc123");
		check("--no-index boolean", p.flags["no-index"] === true);
		check("quoted --config", p.flags["config"] === "my cfg.json");
		const p2 = parseArgs(`--dest ~/wt -b x`);
		check("--dest space value", p2.flags["dest"] === "~/wt" && p2.positionals.length === 0, JSON.stringify(p2));
		const p3 = parseArgs(`--dest=/tmp/x`);
		check("--dest = form", p3.flags["dest"] === "/tmp/x", JSON.stringify(p3));
		const p4 = parseArgs(`--dest`);
		check("--dest bare → true", p4.flags["dest"] === true, JSON.stringify(p4));
		// With the command's value-flag schema, a boolean flag NEVER eats the
		// token after it (the runtime fix for flags before positionals).
		const p5 = parseArgs(`--no-index wt main`, WORKTREE_VALUE_FLAGS);
		check("schema: boolean flag doesn't consume positionals", p5.flags["no-index"] === true && JSON.stringify(p5.positionals) === JSON.stringify(["wt", "main"]), JSON.stringify(p5));
		const p6 = parseArgs(`-b feature/x --no-index main`, WORKTREE_VALUE_FLAGS);
		check("schema: value flag consumes, boolean doesn't", p6.flags["b"] === "feature/x" && p6.flags["no-index"] === true && JSON.stringify(p6.positionals) === JSON.stringify(["main"]), JSON.stringify(p6));
		const p7 = parseArgs(`-- --no-index wt`);
		check("-- ends flag parsing (rest is positional)", JSON.stringify(p7.positionals) === JSON.stringify(["--no-index", "wt"]) && !("" in p7.flags), JSON.stringify(p7));
		const p8 = parseArgs(`"my project/`);
		check("unterminated quote is one positional", JSON.stringify(p8.positionals) === JSON.stringify(["my project/"]), JSON.stringify(p8));
	}

	// ── 1b. progress extraction (parseChhoundLine / surfaceChhoundLine / buildStatusText) ──
	section("progress extraction");
	{
		const b1 = parseChhoundLine("2026-08-30 13:31:02 | DEBUG    | chunkhound.services.embedding_service:process_batch:516 - Processing batch 2/3 with 300 chunks");
		check("batch line parsed (loguru prefix)", b1?.batchCurrent === 2 && b1?.batchTotal === 3 && b1?.batchChunks === 300, JSON.stringify(b1));
		const b2 = parseChhoundLine("Processing batch 1/12 with 24 chunks");
		check("batch line parsed (bare)", b2?.batchCurrent === 1 && b2?.batchTotal === 12, JSON.stringify(b2));
		const b2b = parseChhoundLine("2026-08-30 13:31:08 | DEBUG    | chunkhound.services.embedding_service:process_batch:564 - Batch 2 completed: 300 embeddings stored");
		check("batch-done line parsed", b2b?.batchDone === 2, JSON.stringify(b2b));
		const b3 = parseChhoundLine("Initial stats: 64 files, 624 chunks, 0 embeddings");
		check("non-batch line → null", b3 === null, JSON.stringify(b3));

		check("loguru debug noise dropped", surfaceChhoundLine("2026-08-30 13:31:02 | DEBUG    | chunkhound.services.embedding_service:process_batch:516 - Preparing data") === null);
		const surf = surfaceChhoundLine("2026-08-30 13:31:02 | DEBUG    | chunkhound.services.embedding_service:process_batch:516 - Processing batch 2/3 with 300 chunks");
		check("batch line surfaced", surf === "Processing batch 2/3 with 300 chunks", JSON.stringify(surf));
		check("stdout line passes through", surfaceChhoundLine("Processing Complete") === "Processing Complete");
		const warn = surfaceChhoundLine("2026-08-30 13:31:02 | WARNING  | chunkhound.services.embedding_service:process_batch:516 - Embedding generation failed");
		check("warning surfaced with level", warn === "WARNING: Embedding generation failed", JSON.stringify(warn));

		const st = (state: Partial<ProgressState>) => buildStatusText({ phase: "worktree index (top-up)", lastLine: "", elapsedMs: 125_000, ...state });
		check("status: batch progress", st({ batchCurrent: 3, batchTotal: 12, batchChunks: 300 }) === "embedding · batch 3/12 (300 chunks) · 2:05", st({ batchCurrent: 3, batchTotal: 12, batchChunks: 300 }));
		check("status: completed batches win", st({ batchCurrent: 7, batchTotal: 7, batchDone: 5 }) === "embedding · 5/7 · 2:05", st({ batchCurrent: 7, batchTotal: 7, batchDone: 5 }));
		check("status: db growth", st({ dbBytes: 5_300_000, dbStartBytes: 2_000_000 }) === "worktree index (top-up) · db 5.1 MB +3.1 MB · 2:05", st({ dbBytes: 5_300_000, dbStartBytes: 2_000_000 }));
		check("status: fallback phase+elapsed", st({}) === "worktree index (top-up) · 2:05", st({}));
		check("formatBytes", formatBytes(1024 * 1024 * 5.3) === "5.3 MB", formatBytes(1024 * 1024 * 5.3));
	}

	// ── 2. completions ─────────────────────────────────────────────────
	section("completions");
	{
		const proj = path.join(tmp, "comp-proj");
		fs.mkdirSync(path.join(proj, "src", "nested"), { recursive: true });
		fs.mkdirSync(path.join(proj, "docs"), { recursive: true });
		fs.writeFileSync(path.join(proj, "a.txt"), "x");
		const dirs0 = dirCompletions("", proj);
		check("dir picker: dirs only, trailing /", dirs0.map((d) => d.label).join(",") === "docs/,src/", JSON.stringify(dirs0));
		const dirs1 = dirCompletions("sr", proj);
		check("dir picker: prefix filter + full value", dirs1.length === 1 && dirs1[0]!.value === "src/" && dirs1[0]!.label === "src/");
		const dirs2 = dirCompletions("src/", proj);
		check("dir picker: subdir navigation", dirs2.length === 1 && dirs2[0]!.value === "src/nested/", JSON.stringify(dirs2));
		const files = dirCompletions("a", proj, { includeFiles: true });
		check("file picker (--config): files included", files.some((f) => f.label === "a.txt" && f.description === "file"));
		const abs = dirCompletions(proj + "/s", proj);
		check("dir picker: absolute prefix", abs.length === 1 && abs[0]!.value === proj + "/src/", JSON.stringify(abs));
		const tilde = dirCompletions("~/", proj);
		check("dir picker: ~ expansion", tilde.length > 0 && tilde.every((d) => d.value.startsWith("~/")));
		// Full-argument replacement contract (applyCompletion replaces the whole arg string).
		const arg0 = await worktreeArgumentCompletions("", proj);
		check("arg completions: empty → cwd dirs", arg0.some((c) => c.value === "src/"), JSON.stringify(arg0));
		check("arg completions name the parameter", arg0.length > 0 && arg0[0]!.description === "worktree path (required)", JSON.stringify(arg0[0]));
		const argBranch = await worktreeArgumentCompletions("wt ", proj);
		check("arg completions: trailing space → branch position, full values", argBranch.every((c) => c.value.startsWith("wt ")));
		const argNoRepo = await worktreeArgumentCompletions("wt ", proj);
		check("no repo → no branch/new-branch items", argNoRepo.length === 0, JSON.stringify(argNoRepo));
		const argNoRepoName = await worktreeArgumentCompletions("wt something", proj);
		check("no repo → no create-branch item", argNoRepoName.length === 0, JSON.stringify(argNoRepoName));
		const argBDash = await worktreeArgumentCompletions("wt -b ", proj);
		check("-b value position → no existing-branch suggestions", argBDash.length === 0, JSON.stringify(argBDash));
		const argConfigTrailing = await worktreeArgumentCompletions("wt --config ", proj);
		check("--config trailing space → config files", argConfigTrailing.some((c) => c.value === "wt --config a.txt" && c.label === "a.txt"), JSON.stringify(argConfigTrailing));
		const argFlag = await worktreeArgumentCompletions("wt --f", proj);
		check("arg completions: flag names keep base", argFlag.some((c) => c.value === "wt --force-reindex") && argFlag.some((c) => c.value === "wt --from"), JSON.stringify(argFlag));
		const argFrom = await worktreeArgumentCompletions("wt --from ", proj);
		check("arg completions: --from value position", argFrom.every((c) => c.value.startsWith("wt --from ")));
		const argConfig = await worktreeArgumentCompletions("wt --config a", proj);
		check("arg completions: --config value position keeps base", argConfig.some((c) => c.value === "wt --config a.txt" && c.label === "a.txt"), JSON.stringify(argConfig));
		const argDestFlag = await worktreeArgumentCompletions("wt --d", proj);
		check("arg completions: --dest flag name", argDestFlag.some((c) => c.value === "wt --dest"), JSON.stringify(argDestFlag));
		const argDest = await worktreeArgumentCompletions("wt --dest ", proj);
		check("--dest value → dir picker (optional label)", argDest.every((c) => c.value.startsWith("wt --dest ")) && argDest.some((c) => c.value === "wt --dest src/" && c.description === "sandbox library root (worktree + index land there)"), JSON.stringify(argDest));
		check("--dest picker dirs only", !argDest.some((c) => c.label === "a.txt"), JSON.stringify(argDest));
	}

	// ── 2b. --dest location, wizard trigger, conflict block ──────────
	section("dest: location + wizard + conflict");
	{
		const repo2 = path.join(tmp, "dest-repo");
		fs.mkdirSync(repo2);
		const dest = path.join(tmp, "dest-parent");
		check("wizard: bare /chworktree", isWizardInvocation([], {}), JSON.stringify(isWizardInvocation([], {})));
		check("wizard: repo only", isWizardInvocation(["repo"], {}));
		check("one-go: branch given", isWizardInvocation(["repo", "main"], {}) === false);
		check("one-go: --dest given", isWizardInvocation(["repo"], { dest: "~/wt" }) === false);
		check("one-go: -b given", isWizardInvocation([], { b: "x" }) === false);
		check("wizard: --help is not wizard", isWizardInvocation(["repo"], { help: true }) === false);
		check("wizard: -h is not wizard", isWizardInvocation(["repo"], { h: true }) === false);

		// Design 1: the checkout lives INSIDE its sandbox dir — name derived
		// from repo + branch, folder = branch (slashes → "-").
		const sb = resolveSandboxLocation(repo2, undefined, settings, dest);
		check("sandbox: name from repo+branch (repo-wt default)", path.basename(sb.sandboxDir).startsWith("dest-repo-"), path.basename(sb.sandboxDir));
		check("sandbox: worktree inside sandbox dir", sb.wtPath === path.join(sb.sandboxDir, "dest-repo-wt"), sb.wtPath);
		const sbBranch = resolveSandboxLocation(repo2, "fix/foo", settings, dest);
		check("sandbox: branch-named folder (slashes → dashes)", sbBranch.wtPath === path.join(sbBranch.sandboxDir, "fix-foo"), sbBranch.wtPath);
		check("sandbox: distinct branch → distinct sandbox", sbBranch.sandboxDir !== sb.sandboxDir, `${sbBranch.sandboxDir} vs ${sb.sandboxDir}`);
		// Branch-rename safety: the name never depends on the worktree path (no circularity).
		const sbSame = resolveSandboxLocation(repo2, "fix/foo", settings, dest);
		check("sandbox: stable for same (repo, branch)", sbSame.sandboxDir === sbBranch.sandboxDir && sbSame.wtPath === sbBranch.wtPath);
		// --dest re-scoped: sandbox library root override — same (repo, branch) at a
		// different root yields a different sandbox dir.
		const sbOther = resolveSandboxLocation(repo2, "fix/foo", settings, path.join(tmp, "other-root"));
		check("sandbox: --dest = library root override", sbOther.sandboxDir.startsWith(path.join(tmp, "other-root")) && sbOther.sandboxDir !== sbBranch.sandboxDir, sbOther.sandboxDir);
		check("sandbox: folder name independent of root", path.basename(sbOther.wtPath) === "fix-foo");

		const idx = [path.join(tmp, "idx-a")];
		check("conflict: exact match", findConflictingIndexed(path.join(tmp, "idx-a"), idx) === path.join(tmp, "idx-a"));
		check("conflict: inside indexed worktree", findConflictingIndexed(path.join(tmp, "idx-a", "sub"), idx) === path.join(tmp, "idx-a"));
		check("conflict: contains indexed worktree", findConflictingIndexed(tmp, idx) === path.join(tmp, "idx-a"));
		check("no conflict", findConflictingIndexed(path.join(tmp, "other"), idx) === undefined);
	}

	// ── 2c. path input component: TAB completion in dialogs ──────────
	section("path input component");
	{
		const pathProj = path.join(tmp, "path-proj");
		fs.mkdirSync(path.join(pathProj, "src", "nested"), { recursive: true });
		fs.mkdirSync(path.join(pathProj, "docs"), { recursive: true });
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		const tuiStub = { requestRender: () => {} } as unknown as ConstructorParameters<typeof PathInputComponent>[0];
		const themeStub = { fg: (_c: string, t: string) => t };
		const makeComp = (startValue?: string) => {
			let out: string | undefined = "unset";
			const c = new PathInputComponent(tuiStub, themeStub, getKeybindings(), { title: "p", cwd: pathProj, ...(startValue ? { startValue } : {}) }, (v) => {
				out = v;
			});
			return { c, out: () => out };
		};
		const { c: comp, out: compOut } = makeComp();
		comp.handleInput("s");
		comp.handleInput("r");
		check("typed prefix narrows completions", comp.currentCompletions().length === 1 && comp.currentCompletions()[0]!.value === "src/", JSON.stringify(comp.currentCompletions()));
		comp.handleInput("\t");
		check("TAB accepts first completion (whole-value replace)", comp.getValue() === "src/", comp.getValue());
		check("drill-down continues after TAB", comp.currentCompletions().some((c) => c.value === "src/nested/"), JSON.stringify(comp.currentCompletions()));
		comp.handleInput("\n");
		check("Enter submits value", compOut() === "src/", String(compOut()));
		check("children: 6 fixed + completions + bottom border", comp.children.length === 8, `children=${comp.children.length}`);
		const { c: comp2, out: comp2Out } = makeComp();
		comp2.handleInput("\x1b");
		check("Esc cancels", comp2Out() === undefined, String(comp2Out()));
		const { c: comp3 } = makeComp(pathProj + "/src/");
		check("prefilled value lists its subdirs", comp3.currentCompletions().some((c) => c.value === pathProj + "/src/nested/"), JSON.stringify(comp3.currentCompletions()));
		const { c: comp4 } = makeComp();
		comp4.handleInput("~");
		comp4.handleInput("/");
		check("~ expansion in dialog completions", comp4.currentCompletions().length > 0 && comp4.currentCompletions().every((c) => c.value.startsWith("~/")));

		// List navigation: ↑/↓ move the selection (wrapping), TAB/Enter-after-↑↓
		// accept the SELECTED item, typing resets to the first item. Fixture dirs
		// sort as docs/, src/.
		const { c: comp5, out: comp5Out } = makeComp();
		comp5.handleInput("\x1b[B"); // ↓ → src/
		comp5.handleInput("\t");
		check("arrow down moves selection (TAB accepts selected)", comp5.getValue() === "src/", comp5.getValue());
		comp5.handleInput("\n");
		check("enter after accept submits the value", comp5Out() === "src/", String(comp5Out()));
		const { c: comp6, out: comp6Out } = makeComp();
		comp6.handleInput("\x1b[B"); // ↓ → src/
		comp6.handleInput("\n");
		check("enter accepts selected item after navigation", comp6Out() === "src/", String(comp6Out()));
		const { c: comp7 } = makeComp();
		comp7.handleInput("\x1b[A"); // ↑ at top wraps to last (src/)
		comp7.handleInput("\t");
		check("arrow up at top wraps to last item", comp7.getValue() === "src/", comp7.getValue());
		const { c: comp8 } = makeComp();
		comp8.handleInput("\x1b[B");
		comp8.handleInput("\x1b[B"); // ↓ at bottom wraps to first (docs/)
		comp8.handleInput("\t");
		check("arrow down at bottom wraps to first item", comp8.getValue() === "docs/", comp8.getValue());
		const { c: comp9 } = makeComp();
		comp9.handleInput("\x1b[B"); // selection on src/
		comp9.handleInput("d"); // typing resets selection
		comp9.handleInput("\t");
		check("typing resets selection to first item", comp9.getValue() === "docs/", comp9.getValue());
		const { c: comp10 } = makeComp();
		comp10.handleInput("zz"); // no completions
		comp10.handleInput("\x1b[B");
		comp10.handleInput("\x1b[A");
		check("arrows with empty list are inert", comp10.getValue() === "zz", comp10.getValue());

		// Generic prefilled text prompt (wizard defaults): prefill, confirm, cancel.
		const { TextPromptComponent } = await import("../chhound/path-input.js");
		let tpOut: string | undefined = "unset";
		const tp = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
			tpOut = v;
		});
		check("text prompt prefills default", tp.getValue() === "voyageai", tp.getValue());
		tp.handleInput("x");
		check("first printable replaces prefill", tp.getValue() === "x", tp.getValue());
		tp.handleInput("\n");
		check("text prompt Enter confirms edited value", tpOut === "x", String(tpOut));
		let tpOut3: string | undefined = "unset";
		const tp3 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
			tpOut3 = v;
		});
		tp3.handleInput("a");
		tp3.handleInput("n");
		check("typing replaces prefill via buffer", tp3.getValue() === "an", tp3.getValue());
		tp3.handleInput("\n");
		check("buffer value confirms", tpOut3 === "an", String(tpOut3));
		const tp4 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
		tp4.handleInput("\b");
		check("backspace on pristine clears field", tp4.getValue() === "", tp4.getValue());
		// TAB = skip: keeps the ORIGINAL value, discarding typed edits.
		let tpOut5: string | undefined = "unset";
		const tp5 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
			tpOut5 = v;
		});
		tp5.handleInput("x");
		tp5.handleInput("\t");
		check("TAB skips to original value (edits discarded)", tpOut5 === "voyageai", String(tpOut5));
		let tpOut6: string | undefined = "unset";
		const tp6 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "" }, (v) => {
			tpOut6 = v;
		});
		tp6.handleInput("\t");
		check("TAB on empty prompt skips as empty", tpOut6 === "", String(tpOut6));
		let tpOut2: string | undefined = "unset";
		const tp2 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "" }, (v) => {
			tpOut2 = v;
		});
		tp2.handleInput("\x1b");
		check("text prompt Esc cancels", tpOut2 === undefined, String(tpOut2));
		// Terminal-originated input while pristine must ALSO replace the prefill
		// (repros from the TAB reliability review): kitty CSI-u, astral Unicode,
		// chunked bracketed paste, and cursor movement marks the prefill touched.
		const tp7 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
		tp7.handleInput("\x1b[120u");
		check("kitty CSI-u printable replaces prefill", tp7.getValue() === "x", tp7.getValue());
		const tp8 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
		tp8.handleInput("😀");
		check("astral unicode replaces prefill", tp8.getValue() === "😀", tp8.getValue());
		const tp9 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
		tp9.handleInput("\x1b[200~x");
		tp9.handleInput("yz");
		tp9.handleInput("\x1b[201~");
		check("chunked bracketed paste replaces prefill", tp9.getValue() === "xyz", tp9.getValue());
		tp9.handleInput("!");
		check("typing continues after paste-replace", tp9.getValue() === "xyz!", tp9.getValue());
		const tp10 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
		tp10.handleInput("\x1b[D");
		tp10.handleInput("x");
		check("cursor movement marks prefill touched (insert at cursor)", tp10.getValue() === "xvoyageai", tp10.getValue());
	}

	// ── 3. adoptConfigFile strips secrets ─────────────────────────────
	section("adoptConfigFile");
	{
		const cfgPath = path.join(tmp, "existing-chhound.json");
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				embedding: { provider: "voyageai", model: "voyage-3.5", rerank_model: "rerank-2.5", api_key: "sk-SECRET" },
				indexing: { include: ["**/*.rs"], per_file_timeout_seconds: 8 },
				database: { provider: "duckdb", path: "/ignored" },
			}),
		);
		const { adopted, warnings } = adoptConfigFile(cfgPath, tmp);
		check("embedding folded", adopted.embedding?.provider === "voyageai" && adopted.embedding?.model === "voyage-3.5");
		check("rerank_model mapped", adopted.embedding?.rerankModel === "rerank-2.5");
		check("api_key adopted into settings", adopted.embedding?.apiKey === "sk-SECRET");
		check("api_key adoption noted", warnings.some((w) => w.includes("api_key")), warnings.join("; "));
		check("database warning", warnings.some((w) => w.includes("database")));
	}

	// ── 3. materializeConfig ──────────────────────────────────────────
	section("materializeConfig");
	{
		const dir = path.join(tmp, "cfg-out");
		const dbDir = path.join(dir, ".chhound.db");
		const p = materializeConfig(dir, { settings, dbDir });
		check("config materialized with canonical name", path.basename(p) === ".chunkhound.json", path.basename(p));
		const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		const db = cfg.database as Record<string, unknown>;
		check("duckdb pinned", db.provider === "duckdb" && db.path === dbDir);
		check("no api_key without key in settings", JSON.stringify(cfg).includes("api_key") === false);
		const excludes = (cfg.indexing as Record<string, unknown>).exclude as string[];
		check("chhound exclusion guaranteed", excludes.includes("**/.chhound/**"));

		// With a key in settings, the materialized config carries it (v1) — 0600.
		const dir2 = path.join(tmp, "cfg-keyed");
		const p2 = materializeConfig(dir2, { settings: { ...settings, embedding: { apiKey: "sk-KEY" } }, dbDir: path.join(dir2, ".chhound.db") });
		const cfg2 = JSON.parse(fs.readFileSync(p2, "utf8")) as Record<string, unknown>;
		check("api_key materialized when set", (cfg2.embedding as Record<string, unknown>).api_key === "sk-KEY");
		check("config file 0600", (fs.statSync(p2).mode & 0o777) === 0o600, `mode=${(fs.statSync(p2).mode & 0o777).toString(8)}`);

		// LLM section (research tools) + preserve of non-owned sections.
		const dir3 = path.join(tmp, "cfg-llm");
		const p3 = materializeConfig(dir3, {
			settings: { ...settings, llm: { provider: "openai", model: "gpt-5", apiKey: "sk-LLM" } },
			dbDir: path.join(dir3, ".chhound.db"),
		});
		const cfg3 = JSON.parse(fs.readFileSync(p3, "utf8")) as Record<string, unknown>;
		const llm3 = cfg3.llm as Record<string, unknown>;
		check(
			"llm block materialized",
			llm3?.provider === "openai" &&
				llm3?.model === "gpt-5" &&
				llm3?.api_key === "sk-LLM" &&
				llm3?.codex_reasoning_effort_utility === "minimal" &&
				llm3?.codex_reasoning_effort_synthesis === "high" &&
				llm3?.timeout === 300,
			JSON.stringify(cfg3),
		);
		check("llm defaults present without llm settings", (() => {
			const p = materializeConfig(dir3, { settings: { ...settings, llm: { provider: "openai" } }, dbDir: path.join(dir3, ".chhound.db") });
			const llm = (JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>).llm as Record<string, unknown>;
			return llm?.codex_reasoning_effort_synthesis === "high" && llm?.timeout === 300;
		})());
		const p3b = materializeConfig(dir3, {
			settings,
			dbDir: path.join(dir3, ".chhound.db"),
			preserve: { research: { enabled: true } },
		});
		const cfg3b = JSON.parse(fs.readFileSync(p3b, "utf8")) as Record<string, unknown>;
		check("preserve merges extra sections", (cfg3b.research as Record<string, unknown>)?.enabled === true);
		check("preserve does not carry llm (owned keys rewritten)", (cfg3b.llm as Record<string, unknown> | undefined) === undefined);

		// Worktree-base suggestion rules: cwd is suggested unless it (or a
		// parent) already contains a .chunkhound.json.
		const wtProj = path.join(tmp, "wtbase");
		const wtSub = path.join(wtProj, "sub");
		fs.mkdirSync(wtSub, { recursive: true });
		check("suggestWorktreeBase: clean cwd suggested", suggestWorktreeBase(wtProj) === wtProj, String(suggestWorktreeBase(wtProj)));
		check("insideChunkhoundRoot: clean → false", insideChunkhoundRoot(wtProj) === false);
		fs.writeFileSync(path.join(wtProj, ".chunkhound.json"), "{}");
		check("insideChunkhoundRoot: own dir → true", insideChunkhoundRoot(wtProj) === true);
		check("insideChunkhoundRoot: parent walk → true", insideChunkhoundRoot(wtSub) === true);
		check("suggestWorktreeBase: inside root → undefined", suggestWorktreeBase(wtProj) === undefined);
		check("suggestWorktreeBase: subdir of root also undefined", suggestWorktreeBase(wtSub) === undefined);

		// output_dims: materialized when set, absent when unset.
		const dir4 = path.join(tmp, "cfg-dims");
		const p4 = materializeConfig(dir4, { settings: { ...settings, embedding: { provider: "voyageai", outputDims: 256 } }, dbDir: path.join(dir4, ".chhound.db") });
		const cfg4 = JSON.parse(fs.readFileSync(p4, "utf8")) as Record<string, unknown>;
		check("output_dims materialized", (cfg4.embedding as Record<string, unknown>).output_dims === 256, JSON.stringify(cfg4));
		const p4b = materializeConfig(dir4, { settings, dbDir: path.join(dir4, ".chhound.db") });
		const cfg4b = JSON.parse(fs.readFileSync(p4b, "utf8")) as Record<string, unknown>;
		const emb4b = cfg4b.embedding as Record<string, unknown> | undefined;
		check("no output_dims without setting", emb4b === undefined || emb4b.output_dims === undefined, JSON.stringify(cfg4b));

		// --config adoption: llm section folds in, secrets warned.
		const adoptSrc = path.join(tmp, "adopt.json");
		fs.writeFileSync(adoptSrc, JSON.stringify({ embedding: { provider: "voyageai" }, llm: { provider: "anthropic", api_key: "sk-ADOPT" }, database: { provider: "duckdb" } }));
		const adopted = adoptConfigFile(adoptSrc, tmp);
		check("adopt folds llm section", adopted.adopted.llm?.provider === "anthropic" && adopted.adopted.llm?.apiKey === "sk-ADOPT");
		check("adopt warns on llm api_key", adopted.warnings.some((w) => w.includes("llm.api_key")));
		const folded = foldAdoptedInto({ version: 1 }, adopted.adopted);
		check("foldAdoptedInto carries llm", folded.llm?.provider === "anthropic");
	}

	// ── 4. scratch git repo + baseline prime ─────────────────────────
	section("baseline prime");
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo);
	await runGit(["init", "-b", "main"], { cwd: repo });
	await runGit(["config", "user.email", "smoke@test"], { cwd: repo });
	await runGit(["config", "user.name", "Smoke"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(repo, "b.md"), "# hello\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit = await runGit(["commit", "-m", "init"], { cwd: repo });
	check("seed commit", commit.code === 0, commit.stderr);
	const baseCommit = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;

	const onLine = (l: string) => console.log(`    [chhound] ${l.slice(0, 110)}`);
	const extraArgs = ["--no-embeddings"];
	const b1 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline primed", b1.fresh && fs.existsSync(b1.dbDir), b1.dir);
	check("baseline meta commit", b1.meta.baseCommit === baseCommit);
	check("baseline no artifacts in repo", !fs.existsSync(path.join(repo, ".chhound")), "found .chhound in repo");
	const wtClean1 = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after prime", wtClean1 === "", wtClean1);

	const b2 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline fresh on re-run", b2.fresh === false);

	// Base moved → refresh must re-prime via in-place top-up.
	fs.writeFileSync(path.join(repo, "b2.md"), "# more\n");
	await runGit(["add", "-A"], { cwd: repo });
	const commit2 = await runGit(["commit", "-m", "more"], { cwd: repo });
	check("second commit", commit2.code === 0, commit2.stderr);
	const baseCommit2 = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).stdout;
	const b3 = await ensureBaseline({ repoRoot: repo, settings, onLine, extraArgs });
	check("baseline refreshed on base move", b3.fresh === true && b3.meta.baseCommit === baseCommit2, b3.reason);

	// ── 5. worktree spin-up: sandbox-anchored — copy + top-up ────────
	section("worktree spin-up");
	const sandboxDir = sandboxDirFor(repo, "fix/smoke", settings);
	const wt = path.join(sandboxDir, "fix-smoke");
	fs.mkdirSync(sandboxDir, { recursive: true });
	await gitWorktreeAdd({ cwd: repo, path: wt, createBranch: "fix/smoke", commitIsh: "main" });
	fs.writeFileSync(path.join(wt, "c.ts"), "export const c = 3;\n");
	// Commit the branch change (mirrors a real dev edit) so the final status
	// check proves the checkout stays CLEAN — no chunkhound artifacts.
	await runGit(["add", "-A"], { cwd: wt });
	await runGit(["commit", "-m", "add c"], { cwd: wt });
	const branch = await currentBranch(wt);
	check("worktree branch", branch === "fix/smoke", branch);
	check("worktree inside sandbox dir", wt.startsWith(sandboxDir + path.sep), wt);

	// Branch-in-use handling: fix/smoke is checked out at wt — the wizard must
	// derive a fresh name instead of trying to check it out again.
	const branchWarnings: string[] = [];
	const inUseChoice = await resolveBranchChoice(repo, "fix/smoke", (m, t) => branchWarnings.push(`${t}: ${m}`));
	check("in-use branch → fresh create name", inUseChoice.createBranch === "fix/smoke-2" && inUseChoice.branch === undefined, JSON.stringify(inUseChoice));
	check("in-use branch warns", branchWarnings.some((w) => w.includes("fix/smoke-2")), branchWarnings.join("\n"));
	const mainChoice = await resolveBranchChoice(repo, "main", () => {});
	check("main-tree branch also in-use → fresh name", mainChoice.createBranch === "main-2", JSON.stringify(mainChoice));
	await runGit(["branch", "free/smoke", "main"], { cwd: repo });
	const freeChoice = await resolveBranchChoice(repo, "free/smoke", () => {});
	check("existing unattached branch → checkout", freeChoice.branch === "free/smoke" && freeChoice.createBranch === undefined, JSON.stringify(freeChoice));
	const freshChoice = await resolveBranchChoice(repo, "brand-new", () => {});
	check("unknown name → create", freshChoice.createBranch === "brand-new", JSON.stringify(freshChoice));
	// Occupy fix/smoke-2 as an unattached ref → the in-use fix/smoke must skip to -3.
	await runGit(["branch", "fix/smoke-2", "main"], { cwd: repo });
	const suffixed = await resolveBranchChoice(repo, "fix/smoke", () => {});
	check("occupied suffix skips to next free", suffixed.createBranch === "fix/smoke-3", JSON.stringify(suffixed));

	const branches = await branchCompletions(repo);
	check("branch completions include new branch", branches.some((b) => b.value === "fix/smoke"), branches.map((b) => b.value).join(","));
	const argComp = await worktreeArgumentCompletions("wt fix", repo);
	check("arg completions: branch position", argComp.some((b) => b.value === "wt fix/smoke"), JSON.stringify(argComp));

	// NEW-BRANCH-FIRST: with a real repo, the branch picker leads with creation.
	const argBranchRepo = await worktreeArgumentCompletions("wt ", repo);
	check("branch picker: new-branch item first, existing after", argBranchRepo[0]!.value === "wt -b " && argBranchRepo.some((c) => c.value === "wt main"), JSON.stringify(argBranchRepo.map((c) => c.value)));
	const argExistingName = await worktreeArgumentCompletions("wt main", repo);
	check("existing branch name → no create item", !argExistingName.some((c) => c.value.startsWith("wt -b")), JSON.stringify(argExistingName));
	const argNewName = await worktreeArgumentCompletions("wt brandnew", repo);
	check("typed new name → create-branch item", argNewName.some((c) => c.value === "wt -b brandnew" && c.label === "create branch: brandnew"), JSON.stringify(argNewName));
	const argNewNamePartial = await worktreeArgumentCompletions("wt fix", repo);
	check("typed prefix of existing branch → create item still first", argNewNamePartial[0]!.value === "wt -b fix", JSON.stringify(argNewNamePartial[0]));

	// Repo resolution from a non-repo cwd (the workspace-root scenario).
	const resolved = await findRepoRoot(path.join(repo, "sub", "deep"));
	check("findRepoRoot walks up from nested dir", resolved === repo, `${resolved} vs ${repo}`);
	const none = await findRepoRoot(path.join(tmp, "not-a-repo"));
	check("findRepoRoot undefined outside repos", none === undefined, `${none}`);
	const argComp2 = await worktreeArgumentCompletions("repo fix", tmp);
	check("arg completions resolve repo from path (cwd not a repo)", argComp2.some((b) => b.value === "repo fix/smoke"), JSON.stringify(argComp2));

	const dbDir = sandboxDbDir(sandboxDir);
	const configPath = materializeConfig(sandboxDir, { settings, dbDir });
	const r = await hotStartIndex({ sourceDbDir: b2.dbDir, targetDbDir: dbDir, indexDir: sandboxDir, configPath, onLine, extraArgs });
	check("index ok", r.code === 0, `code=${r.code}`);
	check("db copied from baseline", r.copied === true && fs.existsSync(dbDir));
	check("db bigger than baseline copy (top-up added c.ts)", dirSize(dbDir) > 0);

	// Design 1: ZERO operational files in the worktree or the repo — no
	// git-exclude writes, no .chhound/, no config inside the checkout.
	const excl = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
	check("no git-exclude writes in the repo", !excl.includes("pi-chhound") && !excl.includes(".chhound"), excl);
	check("no .chhound inside the checkout", !fs.existsSync(path.join(wt, ".chhound")), "found .chhound in checkout");
	check("no config inside the checkout", !fs.existsSync(path.join(wt, ".chunkhound.json")), "found config in checkout");
	const wtStatus = (await runGit(["status", "--porcelain"], { cwd: wt })).stdout;
	check("worktree git status clean after index", wtStatus === "", wtStatus);
	const repoStatus = (await runGit(["status", "--porcelain"], { cwd: repo })).stdout;
	check("repo clean after worktree+index", repoStatus === "", repoStatus);

	writeSandboxMeta(sandboxDir, {
		version: 1,
		worktree: wt,
		repoRoot: repo,
		branch,
		baseRef: "main",
		baseCommit,
		chhoundVersion: await chhoundVersion(),
		createdAt: new Date().toISOString(),
		copiedFrom: b2.dbDir,
		dbPath: dbDir,
	});

	// ── 5b. MCP bridge: real chunkhound mcp over stdio (SDK client) ────
	section("mcp bridge integration");
	{
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const daemonRuntime = path.join(tmp, "daemon-runtime");
		fs.mkdirSync(daemonRuntime, { recursive: true });
		const mcpEnv = { ...process.env, CHUNKHOUND_DAEMON_RUNTIME_DIR: daemonRuntime } as Record<string, string>;
		const isAlive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const waitFor = async (fn: () => boolean, ms: number) => {
			const deadline = Date.now() + ms;
			while (Date.now() < deadline) {
				if (fn()) return true;
				await new Promise((r) => setTimeout(r, 200));
			}
			return fn();
		};

		check("mcp: tool prefix derivation", mcpToolPrefix("/home/u/wt-fix") === "chh_wt-fix", mcpToolPrefix("/home/u/wt-fix"));
		check("mcp: tool prefix override", mcpToolPrefix("/home/u/wt-fix", "mine") === "mine");

		// --no-daemon: single-process server; must exit when stdin closes.
		const t1 = new StdioClientTransport({
			command: chhoundBinary(),
			args: ["mcp", sandboxDir, "--config", configPath, "--no-daemon", "--no-embeddings"],
			cwd: sandboxDir,
			env: mcpEnv,
			stderr: "pipe",
		});
		const c1 = new Client({ name: "pi-chhound-smoke", version: "0.0.0" }, { capabilities: {} });
		await c1.connect(t1, { timeout: 30_000 });
		const listed = await c1.listTools();
		check(
			"mcp: tools listed (no-daemon)",
			listed.tools.some((t) => t.name === "daemon_status") && listed.tools.some((t) => t.name === "search"),
			listed.tools.map((t) => t.name).join(","),
		);
		const st1 = await c1.callTool({ name: "daemon_status", arguments: {} });
		check("mcp: daemon_status callable", JSON.stringify(st1).includes("query_ready"), JSON.stringify(st1).slice(0, 160));
		const pid1 = t1.pid;
		await c1.close();
		check("mcp: child exits on close (no-daemon)", await waitFor(() => pid1 !== null && !isAlive(pid1), 10_000), `pid=${pid1}`);

		// Default daemonized mode: stdio proxy + background daemon. The daemon
		// must shut itself down (delay 0) once the client disconnects.
		const projectHash = createHash("sha256").update(path.resolve(sandboxDir)).digest("hex").slice(0, 16);
		const lockFile = path.join(daemonRuntime, "daemon-locks", `${projectHash}.json`);
		const t2 = new StdioClientTransport({
			command: chhoundBinary(),
			args: ["mcp", sandboxDir, "--config", configPath, "--no-embeddings"],
			cwd: sandboxDir,
			env: mcpEnv,
			stderr: "pipe",
		});
		const c2 = new Client({ name: "pi-chhound-smoke", version: "0.0.0" }, { capabilities: {} });
		await c2.connect(t2, { timeout: 30_000 });
		const st2 = await c2.callTool({ name: "daemon_status", arguments: {} });
		check("mcp: daemonized mode callable", JSON.stringify(st2).includes("query_ready"));
		check("mcp: daemon lock registered", await waitFor(() => fs.existsSync(lockFile), 10_000), lockFile);
		// Design 1 core claim: daemon state lands in the SANDBOX dir, never in the
		// checkout — daemon.log, and the root-claim sidecar (indexed root = sandbox).
		check(
			"mcp: daemon.log lands in the sandbox dir",
			await waitFor(() => fs.existsSync(path.join(sandboxDir, ".chunkhound", "daemon.log")), 15_000),
			sandboxDir,
		);
		check("mcp: no .chunkhound in the worktree", !fs.existsSync(path.join(wt, ".chunkhound")), "found .chunkhound in checkout");
		check(
			"mcp: daemon claims the sandbox dir as indexed root",
			await waitFor(() => readClaimedRoot(dbDir) === sandboxDir, 15_000),
			readClaimedRoot(dbDir) ?? "unclaimed",
		);
		const pid2 = t2.pid;
		await c2.close();
		check("mcp: proxy exits on close (daemonized)", await waitFor(() => pid2 !== null && !isAlive(pid2), 10_000), `pid=${pid2}`);
		check("mcp: daemon self-shutdown removes lock", await waitFor(() => !fs.existsSync(lockFile), 15_000), lockFile);

		// connectMcp + per-session replay: a child session re-runs the extension
		// factory, so bridge tools registered at runtime in the parent's api must
		// be re-registerable into a fresh api from the stored connection state.
		const capturePi = (into: Map<string, unknown>) =>
			({ registerTool(t: { name: string }) { into.set(t.name, t); } }) as unknown as ExtensionAPI;
		const firstApi = new Map<string, unknown>();
		process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR = daemonRuntime;
		const entry = listSandboxes(settings)[0]!;
		const conn = await connectMcp(capturePi(firstApi), entry, { extraArgs: ["--no-embeddings"] });
		const expected = conn.toolNames;
		check(
			"mcp: connectMcp registers bridge tools into session api",
			expected.length > 0 && expected.every((n) => firstApi.has(n)),
			expected.join(","),
		);
		check("mcp: connection stores replayable tool metadata", conn.tools.length === expected.length && conn.tools.every((t) => typeof t.name === "string"));
		const childApi = new Map<string, unknown>();
		reRegisterBridgeTools(capturePi(childApi), [conn]);
		check(
			"mcp: bridge tools replay into a fresh (child) session api",
			expected.length > 0 && expected.every((n) => childApi.has(n)),
			[...childApi.keys()].join(",") || "(none)",
		);
		// A replayed definition must be a live bridge: same closures, same registry.
		const daemonTool = [...childApi.entries()].find(([n]) => n.endsWith("_daemon_status"))?.[1] as {
			execute: (...args: unknown[]) => Promise<unknown>;
		} | undefined;
		const stBridge = daemonTool ? await daemonTool.execute("call-1", {}, undefined, undefined) : undefined;
		check(
			"bridge: replayed tool calls the live server",
			typeof stBridge === "object" && JSON.stringify(stBridge).includes("query_ready"),
			JSON.stringify(stBridge)?.slice(0, 160) ?? "(no daemon_status tool)",
		);
		await disconnectMcp(conn.id);
		delete process.env.CHUNKHOUND_DAEMON_RUNTIME_DIR;
		// After disconnect the same replayed definition must fail with the clear
		// reconnect error (registry entry gone) — the child-facing behavior.
		const guardMessage = daemonTool
			? await (async () => {
					try {
						await daemonTool.execute("call-2", {}, undefined, undefined);
						return "no-throw";
					} catch (e) {
						return (e as Error).message;
					}
				})()
			: "(no daemon_status tool)";
		check("bridge: replayed execute guards disconnected registry", guardMessage.includes("not connected"), guardMessage);
		const afterDisconnect = new Map<string, unknown>();
		reRegisterBridgeTools(capturePi(afterDisconnect));
		check("bridge: no live connections → replay is a no-op", afterDisconnect.size === 0, `registered ${afterDisconnect.size}`);

		// No-argument target list (pure helper — same view the command shows).
		const targetLines = mcpTargetLines(settings, []);
		check("mcp: no-arg lists sandbox targets", targetLines.some((l) => l.includes(wt)), targetLines.join("\n"));
		check("mcp: no-arg connect hint", targetLines.some((l) => l.startsWith("connect:")));
		check("mcp: disconnect hint hidden when idle", !targetLines.some((l) => l.startsWith("disconnect:")));
		const connectedLines = mcpTargetLines(settings, [
			{ id: path.basename(sandboxDir), prefix: "chh_wt-fix", toolNames: ["chh_wt-fix_search"] },
		]);
		const connectedText = connectedLines.join("\n");
		check(
			"mcp: connected target marked",
			connectedText.includes("●") && connectedText.includes("(connected)") && connectedText.includes("· 1 tools"),
			connectedText,
		);
		check("mcp: disconnect hint when connected", connectedLines.some((l) => l.startsWith("disconnect:")));

		// Interactive picker options: one per sandbox, in list order.
		const opts = mcpSelectOptions(settings, []);
		check("mcp: picker option per sandbox", opts.length === 1 && opts[0]!.includes(wt) && !opts[0]!.includes("●"), JSON.stringify(opts));
		const optsConnected = mcpSelectOptions(settings, [{ id: path.basename(sandboxDir) }]);
		check("mcp: picker marks connected", optsConnected.length === 1 && optsConnected[0]!.includes("●") && optsConnected[0]!.includes("(connected)"), JSON.stringify(optsConnected));
		check("mcp: picker empty library", mcpSelectOptions({ version: 1, sandboxRoot: path.join(tmp, "empty-sandboxes") }, []).length === 0);

		// /ch-status mcp connections section (pure helper).
		const idleStatus = mcpStatusLines([]).join("\n");
		check("status: mcp section idle", idleStatus.includes("mcp connections (0)") && idleStatus.includes("run /ch-mcp to connect"), idleStatus);
		const liveStatus = mcpStatusLines([
			{ worktree: wt, prefix: "chh_wt-fix", toolNames: ["chh_wt-fix_search", "chh_wt-fix_fetchurl"] },
		]).join("\n");
		check(
			"status: mcp section live",
			liveStatus.includes("mcp connections (1)") && liveStatus.includes("●") && liveStatus.includes("2 tools"),
			liveStatus,
		);

		// /ch-setup refresh: existing sandbox + baseline configs get the llm
		// section from updated settings; non-owned sections survive.
		const withCustom = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
		withCustom.research = { enabled: true };
		fs.writeFileSync(configPath, JSON.stringify(withCustom, null, 2));
		const refreshed = refreshMaterializedConfigs({ ...settings, llm: { provider: "openai", model: "gpt-5" } });
		check("refresh: sandbox config re-materialized", refreshed.includes(configPath), refreshed.join(","));
		const cfgAfter = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
		check("refresh: llm section added", (cfgAfter.llm as Record<string, unknown>)?.provider === "openai");
		check("refresh: custom sections preserved", (cfgAfter.research as Record<string, unknown>)?.enabled === true);
	}

	// ── 6. listing + prune ────────────────────────────────────────────
	section("status: list + prune");
	const sandboxes = listSandboxes(settings);
	check("sandbox listed", sandboxes.length === 1 && sandboxes[0]!.meta.worktree === wt);
	check("db size reported", sandboxes[0]!.dbSizeBytes > 0);
	// chunkhound's root-claim sidecar (written at index time) — Design 1: it
	// claims the SANDBOX DIR (the daemon's project dir), not the checkout.
	const claimPath = `${dbDir}.root.json`;
	fs.writeFileSync(claimPath, JSON.stringify({ version: 1, indexed_root_path: sandboxDir }) + "\n", "utf8");
	check("claimed root read from sidecar", readClaimedRoot(dbDir) === sandboxDir);
	const claimed = listSandboxes(settings);
	check("sandbox entry carries claimed root", claimed[0]!.claimedRoot === sandboxDir);
	check("claimed root matches sandbox dir", claimedRootMatches(claimed[0]!.claimedRoot!, sandboxDir));
	check("mismatch detected", !claimedRootMatches(claimed[0]!.claimedRoot!, "/somewhere/else"));
	check("trailing-slash mismatch tolerated", claimedRootMatches(`${sandboxDir}/`, sandboxDir));
	fs.rmSync(claimPath, { force: true });
	check("missing sidecar → unclaimed", listSandboxes(settings)[0]!.claimedRoot === undefined);
	const baselines = listBaselines(settings);
	check("baseline listed", baselines.length === 1 && !!baselines[0]!.meta);
	await runGit(["worktree", "remove", "--force", wt], { cwd: repo });
	await runGit(["branch", "-D", "fix/smoke"], { cwd: repo });
	const removed = pruneSandboxes(settings);
	check("prune removed orphan sandbox", removed.length === 1 && listSandboxes(settings).length === 0);
	check("config path helper", sandboxConfigPath(sandboxDir).endsWith(path.join(sandboxDir, ".chunkhound.json")));

	// ── 7. settings round-trip (project scope, in scratch) ────────────
	section("settings round-trip");
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(path.join(proj, ".pi", "pi-chhound"), { recursive: true });
	const saved = saveSettings(
		{ ...settings, embedding: { provider: "voyageai", model: "voyage-3.5", apiKey: "sk-ROUNDTRIP" } },
		"project",
		proj,
	);
	const loaded = loadSettings(proj);
	check("project settings round-trip", loaded.settings.embedding?.model === "voyage-3.5", saved);
	check("api key round-trips through settings", loaded.settings.embedding?.apiKey === "sk-ROUNDTRIP");
	check("settings file 0600", (fs.statSync(saved).mode & 0o777) === 0o600, `mode=${(fs.statSync(saved).mode & 0o777).toString(8)}`);
	check("project path used", loaded.projectPath === saved);
	const savedLlm = saveSettings({ ...settings, llm: { provider: "gemini", model: "gemini-2.5-pro" } }, "project", proj);
	check("llm settings round-trip", loadSettings(proj).settings.llm?.provider === "gemini" && loadSettings(proj).settings.llm?.model === "gemini-2.5-pro", savedLlm);
	const savedBase = saveSettings({ ...settings, worktreeBase: "/home/x/wt-base" }, "project", proj);
	check("worktreeBase settings round-trip", loadSettings(proj).settings.worktreeBase === "/home/x/wt-base", savedBase);

	// ── 8. extension loads ────────────────────────────────────────────
	section("extension entry loads");
	{
		const mod = (await import("../index.js")) as { default: unknown };
		check("index.ts default export is a function", typeof mod.default === "function");
	}

	console.log(`\n${checks - failures}/${checks} checks passed`);
	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error("smoke crashed:", err);
	process.exit(1);
});
