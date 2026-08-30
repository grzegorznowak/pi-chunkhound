/** Verify pi-chhound's completion behavior against pristine pi-tui's public
 *  autocomplete provider API (CombinedAutocompleteProvider). No pi patches
 *  involved: the plugin must work on an untouched pi install. */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { runGit } from "../chhound/git.ts";
import { worktreeArgumentCompletions } from "../chhound/completions.ts";

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

const commands = [
	{
		name: "chworktree",
		description: "x",
		getArgumentCompletions: (prefix: string) => worktreeArgumentCompletions(prefix, cwd),
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

console.log(`\n${checks - failures}/${checks} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
