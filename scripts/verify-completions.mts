/** Verify pi-chhound's completion behavior against pristine pi-tui's public
 *  autocomplete provider API (CombinedAutocompleteProvider) — including the
 *  ChhoundArgumentProvider wrapper that routes TAB (force) requests in
 *  /chworktree's argument position to the plugin's own picker. No pi patches
 *  involved: the plugin must work on an untouched pi install. */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { runGit } from "../chhound/git.ts";
import { mcpArgumentCompletions, worktreeArgumentCompletions } from "../chhound/completions.ts";
import { ChhoundArgumentProvider } from "../chhound/provider-wrap.ts";

let checks = 0, failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
	checks++;
	if (cond) console.log(`  ok ${name}`);
	else { failures++; console.log(`  FAIL ${name} — ${detail}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-verify-"));
const cwd = path.join(tmp, "proj");
fs.mkdirSync(path.join(cwd, "src", "nested"), { recursive: true });
fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
fs.writeFileSync(path.join(cwd, "README.md"), "# r\n");

// The project dir doubles as the git repo (branch completions need a repo cwd).
const repo = cwd;
await runGit(["init", "-b", "main", "-q"], { cwd: repo });
await runGit(["config", "user.email", "t@t"], { cwd: repo });
await runGit(["config", "user.name", "T"], { cwd: repo });
fs.writeFileSync(path.join(repo, "a.txt"), "a");
await runGit(["add", "-A"], { cwd: repo });
await runGit(["commit", "-qm", "init"], { cwd: repo });

// Fixture sandbox library for /ch-mcp completions: project settings point
// sandboxRoot at a temp dir (project shadows global), meta.json names a wt.
const sandboxRoot = path.join(tmp, "sandboxes");
fs.mkdirSync(path.join(cwd, ".pi", "pi-chhound"), { recursive: true });
fs.writeFileSync(
	path.join(cwd, ".pi", "pi-chhound", "settings.json"),
	JSON.stringify({ version: 1, sandboxRoot }) + "\n",
);
const fakeWt = path.join(tmp, "wt-fix");
const sandboxDir = path.join(sandboxRoot, "repo-wt-fix-abcdef01");
fs.mkdirSync(sandboxDir, { recursive: true });
fs.writeFileSync(
	path.join(sandboxDir, "meta.json"),
	JSON.stringify({
		version: 1,
		worktree: fakeWt,
		repoRoot: cwd,
		branch: "fix/smoke",
		baseRef: "main",
		baseCommit: "abc",
		chhoundVersion: "test",
		createdAt: new Date().toISOString(),
		copiedFrom: "",
		dbPath: "",
	}) + "\n",
);

const commands = [
	{
		name: "chworktree",
		description: "x",
		getArgumentCompletions: (prefix: string) => worktreeArgumentCompletions(prefix, cwd),
	},
	{
		name: "ch-mcp",
		description: "x",
		getArgumentCompletions: (prefix: string) => mcpArgumentCompletions(prefix, cwd),
	},
	{ name: "read", description: "no arg completions" },
];
const provider = new CombinedAutocompleteProvider(commands, cwd, null);
const s = async (line: string, force = false) => {
	const lines = [line];
	return provider.getSuggestions(lines, 0, line.length, { signal: new AbortController().signal, force });
};

// A: TAB on command name (force=false, explicitTab) → command-name completion
const a = await s("/chworktree", false);
check("A: command-name completion offered", !!a && a.items.some((i: any) => i.value === "chworktree"), JSON.stringify(a));
const applied = provider.applyCompletion(["/chworktree"], 0, "/chworktree".length, a!.items[0]!, a!.prefix);
const lineAfterAccept = applied.lines[0]!.slice(0, applied.cursorCol);
check("A: accept → '/chworktree '", lineAfterAccept === "/chworktree ", JSON.stringify(lineAfterAccept));

// B: next TAB (what pi shows after the accept) → OUR dir picker
const b = await s("/chworktree ", false);
check("B: re-trigger shows dir picker", !!b && b.items.some((i: any) => i.value === "src/" && i.label === "src/"), JSON.stringify(b));

// C: command WITHOUT arg completions returns null (no file picker after accept)
const c = await s("/read ", false);
check("C: arg-less commands return null (no file picker)", c === null, JSON.stringify(c));

// D: branch position keeps working with full values
const d = await s("/chworktree wt main", false);
check("D: branch position full values", !!d && d.items.some((i: any) => i.value === "wt main"), JSON.stringify(d));

// E: drill-down — accept a directory, next level shows its contents
const e = await s("/chworktree src", false);
const srcItem = e!.items.find((i: any) => i.value === "src/");
const appliedDir = provider.applyCompletion(["/chworktree src"], 0, "/chworktree src".length, srcItem!, e!.prefix);
const lineAfterDir = appliedDir.lines[0]!.slice(0, appliedDir.cursorCol);
check("E: dir accept → '/chworktree src/'", lineAfterDir === "/chworktree src/", JSON.stringify(lineAfterDir));
// After the dir accept the line ends with "/": pi shows the next level — the
// provider must already offer the nested contents there.
const e2 = await s("/chworktree src/", false);
check("E: next level shows nested contents", !!e2 && e2.items.some((i: any) => i.value === "src/nested/" && i.label === "nested/"), JSON.stringify(e2?.items?.map((i: any) => i.label)));

// ── Wrapper (ChhoundArgumentProvider): TAB (force) in /chworktree's argument
// position must show the plugin's picker, not pi's built-in file picker ──
// The wrapper resolves through process.cwd(), so point it at the fixture.
process.chdir(cwd);
const wrapped = new ChhoundArgumentProvider(provider);
const w = async (line: string, force: boolean) => {
	const lines = [line];
	return wrapped.getSuggestions(lines, 0, line.length, { signal: new AbortController().signal, force });
};

// F: TAB after command-name accept (force) → OUR dir picker (was file picker)
const f = await w("/chworktree ", true);
check("F: TAB (force) shows dir picker", !!f && f.items.some((i: any) => i.value === "src/" && i.label === "src/") && !f.items.some((i: any) => i.value === "a.txt"), JSON.stringify(f?.items?.map((i: any) => i.label)));

// G: TAB drill-down (force) after dir accept → next level, still ours
const g = await w("/chworktree src/", true);
check("G: TAB (force) drills into dir", !!g && g.items.some((i: any) => i.value === "src/nested/" && i.label === "nested/"), JSON.stringify(g?.items?.map((i: any) => i.label)));

// H: natural typing still works through the wrapper
const h = await w("/chworktree ", false);
check("H: natural typing via wrapper shows dir picker", !!h && h.items.some((i: any) => i.value === "src/"), JSON.stringify(h?.items?.map((i: any) => i.label)));

// I: outside our command's argument position, TAB (force) delegates to the
// wrapped provider (pi's file picker — empty prefix lists cwd incl. files)
const i = await w("", true);
check("I: non-command TAB delegates to file picker", !!i && i.items.some((it: any) => it.value === "a.txt"), JSON.stringify(i?.items?.map((it: any) => it.value).slice(0, 6)));

// J: applyCompletion through the wrapper still replaces the whole argument
const j = await w("/chworktree ", true);
const jItem = j!.items.find((it: any) => it.value === "src/");
const jApplied = wrapped.applyCompletion(["/chworktree "], 0, "/chworktree ".length, jItem!, j!.prefix);
check("J: wrapper applyCompletion → '/chworktree src/'", jApplied.lines[0]!.slice(0, jApplied.cursorCol) === "/chworktree src/", JSON.stringify(jApplied.lines[0]));

// K: TAB on the command name itself (no space) still delegates → command item
const k = await w("/chworktree", false);
check("K: TAB on command name delegates to command completion", !!k && k.items.some((it: any) => it.value === "chworktree"), JSON.stringify(k?.items?.map((it: any) => it.value)));

// L: --dest value position → destination dir picker (dirs only, optional label)
const l = await s("/chworktree wt --dest ", false);
check("L: --dest value → destination dir picker", !!l && l.items.every((i: any) => i.value.startsWith("wt --dest ")) && l.items.some((i: any) => i.value === "wt --dest src/" && i.label === "src/" && i.description === "worktree destination folder (optional)"), JSON.stringify(l?.items?.map((i: any) => i.label)));
check("L: --dest picker dirs only", !!l && !l.items.some((i: any) => i.value.endsWith("a.txt")), JSON.stringify(l?.items?.map((i: any) => i.value)));

// M: --dest value through the wrapper (TAB force)
const m = await w("/chworktree wt --dest ", true);
check("M: TAB (force) in --dest value → destination picker", !!m && m.items.some((i: any) => i.value === "wt --dest src/" && i.label === "src/"), JSON.stringify(m?.items?.map((i: any) => i.label)));

// N: /ch-mcp argument completions — sandbox worktrees from the fixture library
const n = await s("/ch-mcp ", false);
check("N: /ch-mcp lists sandbox worktrees", !!n && n.items.some((i: any) => i.value === fakeWt && i.label === "wt-fix"), JSON.stringify(n?.items?.map((i: any) => i.value)));
const n2 = await s("/ch-mcp wt-f", false);
check("N: /ch-mcp prefix filter", !!n2 && n2.items.some((i: any) => i.value === fakeWt), JSON.stringify(n2?.items?.map((i: any) => i.value)));
const n3 = await s("/ch-mcp --", false);
check("N: /ch-mcp flags offered", !!n3 && n3.items.some((i: any) => i.value === "--disconnect"), JSON.stringify(n3?.items?.map((i: any) => i.value)));

// O: /ch-mcp TAB (force) through the wrapper → our picker, not pi's
const o = await w("/ch-mcp ", true);
check("O: TAB (force) on /ch-mcp shows sandbox", !!o && o.items.some((i: any) => i.value === fakeWt), JSON.stringify(o?.items?.map((i: any) => i.value)));

console.log(`\n${checks - failures}/${checks} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
