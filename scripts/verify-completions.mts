/** Verify pi-chhound's completion behavior against pristine pi-tui's public
 *  autocomplete provider API (CombinedAutocompleteProvider) — including the
 *  ChhoundArgumentProvider wrapper that routes TAB (force) requests in
 *  /chworktree's argument position to the plugin's own picker. No pi patches
 *  involved: the plugin must work on an untouched pi install. */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { parseArgs } from "../chhound/args.ts";
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
// Pathological-but-real fixtures: a dir with a space and one starting with "-".
fs.mkdirSync(path.join(cwd, "my project"), { recursive: true });
fs.mkdirSync(path.join(cwd, "-target"), { recursive: true });
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

// L: --dest value position → sandbox library root dir picker (dirs only, optional label)
const l = await s("/chworktree wt --dest ", false);
check("L: --dest value → worktree library root dir picker", !!l && l.items.every((i: any) => i.value.startsWith("wt --dest ")) && l.items.some((i: any) => i.value === "wt --dest src/" && i.label === "src/" && i.description === "worktree library root (worktrees + indexes land there)"), JSON.stringify(l?.items?.map((i: any) => i.label)));
check("L: --dest picker dirs only", !!l && !l.items.some((i: any) => i.value.endsWith("a.txt")), JSON.stringify(l?.items?.map((i: any) => i.value)));

// M: --dest value through the wrapper (TAB force)
const m = await w("/chworktree wt --dest ", true);
check("M: TAB (force) in --dest value → sandbox library root picker", !!m && m.items.some((i: any) => i.value === "wt --dest src/" && i.label === "src/"), JSON.stringify(m?.items?.map((i: any) => i.label)));

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

// ── Flag-aware slot routing (flags must never shift positional slots) ──

// P: boolean flag BEFORE the path position must not shift it to branch slot
const p = await s("/chworktree --no-index ", false);
check("P: flags don't shift positional slots", !!p && p.items.some((i: any) => i.value === "--no-index src/" && i.label === "src/"), JSON.stringify(p?.items?.map((i: any) => i.label)));

// Q: branch position survives interleaved boolean flags
const q = await s("/chworktree repo --no-index ma", false);
check("Q: branch position survives interleaved flags", !!q && q.items.some((i: any) => i.value === "repo --no-index main"), JSON.stringify(q?.items?.map((i: any) => i.value)));

// ── Equals-form flag values (--dest=value) ──

const r = await s("/chworktree --dest=", false);
check("R: --dest= equals value slot", !!r && r.items.some((i: any) => i.value === "--dest=src/" && i.label === "src/"), JSON.stringify(r?.items?.map((i: any) => i.value)));
const s2 = await s("/chworktree wt --config=", false);
check("S: --config= equals value slot (files)", !!s2 && s2.items.some((i: any) => i.value === "wt --config=README.md" && i.label === "README.md"), JSON.stringify(s2?.items?.map((i: any) => i.value)));

// ── Paths with spaces: quoted values round-trip through parseArgs ──

const t = await s("/chworktree my", false);
const tItem = t?.items.find((i: any) => i.value === '"my project/');
check("T: space path completes quoted", !!tItem, JSON.stringify(t?.items?.map((i: any) => i.value)));
const tLine = tItem && t ? provider.applyCompletion(["/chworktree my"], 0, "/chworktree my".length, tItem, t.prefix).lines[0]! : "";
const tParsed = parseArgs(tLine.slice("/chworktree ".length));
check("T: quoted value parses as ONE positional", tParsed.positionals.length === 1 && tParsed.positionals[0] === "my project/", JSON.stringify(tParsed));

// U: typing INSIDE quotes completes within the quote context
const u = await s('/chworktree "my', false);
check("U: typing inside quotes completes", !!u && u.items.some((i: any) => i.value === '"my project/'), JSON.stringify(u?.items?.map((i: any) => i.value)));

// ── Dash-named paths ("-target") — completed via the -- separator ──

const v = await s("/chworktree -t", false);
const vItem = v?.items.find((i: any) => i.value === "-- -target/");
check("V: dash path completes via -- separator", !!vItem, JSON.stringify(v?.items?.map((i: any) => i.value)));
const vLine = vItem && v ? provider.applyCompletion(["/chworktree -t"], 0, "/chworktree -t".length, vItem, v.prefix).lines[0]! : "";
check("V: accepted dash path parses as positional", parseArgs(vLine.slice("/chworktree ".length)).positionals.includes("-target/"), JSON.stringify(parseArgs(vLine.slice("/chworktree ".length))));

// ── /ch-mcp: values carry the typed base; invalid slots are suppressed ──

const w2 = await s("/ch-mcp --read-only ", false);
check("W: MCP items carry the typed base", !!w2 && w2.items.some((i: any) => i.value === `--read-only ${fakeWt}`), JSON.stringify(w2?.items?.map((i: any) => i.value)));
const x = await s("/ch-mcp chosen --prefix ", false);
check("X: MCP --prefix value slot has no sandbox items", !x || !x.items.some((i: any) => String(i.value).includes(fakeWt)), JSON.stringify(x?.items?.map((i: any) => i.value)));
const y = await s("/ch-mcp chosen ", false);
check("Y: no sandbox items after the target", !y || !y.items.some((i: any) => String(i.value).includes(fakeWt)), JSON.stringify(y?.items?.map((i: any) => i.value)));

// ── Deterministic ordering: dirs first, then name (dialog TAB picks items[0]) ──

const z = await s("/chworktree ", false);
const zItems = z?.items.map((i: any) => i.value) ?? [];
check("Z: dir entries sorted (dirs first, alpha)", zItems[0] === "-target/" && zItems.indexOf("docs/") < zItems.indexOf('"my project/') && zItems.indexOf('"my project/') < zItems.indexOf("src/"), JSON.stringify(zItems));

console.log(`\n${checks - failures}/${checks} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
