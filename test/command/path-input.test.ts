import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { PathInputComponent, TextPromptComponent } from "../../chhound/path-input.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: 51 legacy checks moved from smoke.ts section 5 (path input
// component). Command tier: REAL pi-tui component classes with a fake
// theme/TUI and the pristine keybinding registry. The global keybindings
// registry is restored in finally (captured before the pristine reset).
// Deterministic fake HOME, never the operator home: the dialog's ~ expansion
// reads os.homedir(), so the fake home is seeded with one visible dir.
// TextPromptComponent is statically imported here (legacy dynamic-imported it
// from the same module it already statically imported PathInputComponent
// from — no behavioral difference).

describe("path input", () => {
	test("legacy dialog + text prompt obligations", async (t) => {
		const env = snapshotEnv();
		const originalKeybindings = getKeybindings();
		const root = await makeFixtureRoot("pi-chhound-command-path-input-");
		try {
			const home = await makeFakeHome(root);
			fs.mkdirSync(path.join(home, "documents")); // only visible dir the ~/ listing needs
			applyEnv(isolatedEnv({ home }));
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const pathProj = path.join(root, "path-proj");
			fs.mkdirSync(path.join(pathProj, "src", "nested"), { recursive: true });
			fs.mkdirSync(path.join(pathProj, "docs"), { recursive: true });
			const tuiStub = { requestRender: () => {} } as unknown as ConstructorParameters<typeof PathInputComponent>[0];
			const themeStub = { fg: (_c: string, t: string) => t };
			const makeComp = (startValue?: string, includeFiles?: boolean) => {
				let out: string | undefined = "unset";
				const c = new PathInputComponent(tuiStub, themeStub, getKeybindings(), { title: "p", cwd: pathProj, ...(startValue ? { startValue } : {}), ...(includeFiles ? { includeFiles } : {}) }, (v) => {
					out = v;
				});
				return { c, out: () => out };
			};
			const { c: comp, out: compOut } = makeComp();
			comp.handleInput("s");
			comp.handleInput("r");
			await check(t, "typed prefix narrows completions", comp.currentCompletions().length === 1 && comp.currentCompletions()[0]!.value === "src/", JSON.stringify(comp.currentCompletions()));
			comp.handleInput("\t");
			await check(t, "TAB accepts first completion (whole-value replace)", comp.getValue() === "src/", comp.getValue());
			await check(t, "drill-down continues after TAB", comp.currentCompletions().some((c) => c.value === "src/nested/"), JSON.stringify(comp.currentCompletions()));
			comp.handleInput("\n");
			await check(t, "Enter submits value", compOut() === "src/", String(compOut()));
			await check(t, "children: 6 fixed + completions + bottom border", comp.children.length === 8, `children=${comp.children.length}`);
			const { c: comp2, out: comp2Out } = makeComp();
			comp2.handleInput("\x1b");
			await check(t, "Esc cancels", comp2Out() === undefined, String(comp2Out()));
			const { c: comp3 } = makeComp(pathProj + "/src/");
			await check(t, "prefilled value lists its subdirs", comp3.currentCompletions().some((c) => c.value === pathProj + "/src/nested/"), JSON.stringify(comp3.currentCompletions()));
			const { c: comp4 } = makeComp();
			comp4.handleInput("~");
			comp4.handleInput("/");
			await check(t, "~ expansion in dialog completions", comp4.currentCompletions().length > 0 && comp4.currentCompletions().every((c) => c.value.startsWith("~/")));

			// List navigation: ↑/↓ move the ▸ row (clamped, no wrap) and MIRROR it
			// into the field, so Enter always confirms the highlighted entry once
			// the list was used; TAB drills into the selected row. Fixture dirs
			// sort as docs/, src/.
			const { c: comp5, out: comp5Out } = makeComp();
			comp5.handleInput("\x1b[B"); // ↓ → src/
			comp5.handleInput("\t");
			await check(t, "arrow down moves selection (TAB accepts selected)", comp5.getValue() === "src/", comp5.getValue());
			comp5.handleInput("\n");
			await check(t, "enter after accept submits the value", comp5Out() === "src/", String(comp5Out()));
			const { c: comp6, out: comp6Out } = makeComp();
			comp6.handleInput("\x1b[B"); // ↓ → src/
			await check(t, "arrow down mirrors the row into the field", comp6.getValue() === "src/", comp6.getValue());
			comp6.handleInput("\n");
			await check(t, "enter accepts selected item after navigation", comp6Out() === "src/", String(comp6Out()));
			const { c: comp7 } = makeComp();
			comp7.handleInput("\x1b[A"); // ↑ at top: clamped on first row (docs/)
			await check(t, "arrow up at top stays on first row, field follows", comp7.getValue() === "docs/", comp7.getValue());
			const { c: comp8 } = makeComp();
			comp8.handleInput("\x1b[B");
			comp8.handleInput("\x1b[B"); // ↓ at bottom: clamped on last row (src/)
			await check(t, "arrow down at bottom stays on last row", comp8.getValue() === "src/", comp8.getValue());
			const { c: comp9 } = makeComp();
			comp9.handleInput("\x1b[B"); // field mirrors src/
			comp9.handleInput("d"); // typing APPENDS at the caret (end of mirrored path)
			await check(t, "typing after ↓ edits the mirrored path at its end", comp9.getValue() === "src/d", comp9.getValue());
			await check(t, "typing refilters from the edited path", comp9.currentCompletions().length === 0, JSON.stringify(comp9.currentCompletions()));
			const { c: comp10 } = makeComp();
			comp10.handleInput("zz"); // no completions
			comp10.handleInput("\x1b[B");
			comp10.handleInput("\x1b[A");
			await check(t, "arrows with empty list are inert", comp10.getValue() === "zz", comp10.getValue());

			// Caret-only moves (←/→) must NOT tear down the navigation snapshot.
			// (Runs before big/ is added to the fixture: root lists docs/, src/.)
			const { c: leftComp } = makeComp();
			leftComp.handleInput("\x1b[B"); // mirror src/ into the field
			leftComp.handleInput("\x1b[D"); // ←: caret move, value unchanged
			await check(t, "caret moves keep the snapshot and selection", leftComp.getValue() === "src/" && leftComp.currentCompletions().length === 2 && leftComp.currentCompletions()[0]!.value === "docs/", `${leftComp.getValue()} ${JSON.stringify(leftComp.currentCompletions())}`);
			const { c: leftTyping } = makeComp();
			leftTyping.handleInput("\x1b[B");
			leftTyping.handleInput("\x1b[D");
			leftTyping.handleInput("x"); // now the value changes → refilter from the caret
			await check(t, "a real edit after caret move refilters from the caret", leftTyping.getValue() === "srcx/", leftTyping.getValue());

			// Browsing long directories: the model holds the FULL list; the 12-row
			// window scrolls with the ▸ row; PgUp/PgDn page. Fixture: big/ with
			// d00..d19 (created after the assertions above, which only saw src/,
			// docs/).
			const big = path.join(pathProj, "big");
			fs.mkdirSync(big);
			for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(big, `d${String(i).padStart(2, "0")}`));
			// A file at the root — invisible to dir-only listings above; includeFiles
			// mode (e.g. --config) lists it after the directories.
			fs.writeFileSync(path.join(pathProj, "a.txt"), "x");
			const { c: bigComp, out: bigOut } = makeComp();
			bigComp.handleInput("b");
			bigComp.handleInput("i");
			bigComp.handleInput("g");
			bigComp.handleInput("/");
			await check(t, "browser model holds the FULL list (no 12-cap)", bigComp.currentCompletions().length === 20, `model=${bigComp.currentCompletions().length}`);
			await check(t, "viewport renders 12 rows + chrome", bigComp.children.length === 6 + 12 + 1, `children=${bigComp.children.length}`);
			for (let i = 0; i < 13; i++) bigComp.handleInput("\x1b[B");
			await check(t, "↓×13 reaches row 13 (window slides)", bigComp.getValue() === "big/d13/", bigComp.getValue());
			await check(t, "viewport stays 12 rows while scrolling", bigComp.children.length === 6 + 12 + 1, `children=${bigComp.children.length}`);
			const rendered = bigComp.render(80).join("\n");
			await check(t, "viewport shows the window rows (scrolled-off rows hidden)", !rendered.includes("d00/") && !rendered.includes("d01/") && rendered.includes("d02/"), rendered.split("\n").slice(6, 6 + 12).join(" | "));
			await check(t, "▸ marker follows the selected row through the window", rendered.includes("▸ d13/"), rendered.split("\n").slice(6, 6 + 12).join(" | "));
			bigComp.handleInput("\n");
			await check(t, "enter commits the scrolled-to entry", bigOut() === "big/d13/", String(bigOut()));
			const { c: pageComp } = makeComp();
			pageComp.handleInput("b");
			pageComp.handleInput("i");
			pageComp.handleInput("g");
			pageComp.handleInput("/");
			pageComp.handleInput("\x1b[6~"); // PgDn → row 12
			await check(t, "PgDn pages one window down", pageComp.getValue() === "big/d12/", pageComp.getValue());
			pageComp.handleInput("\x1b[6~"); // PgDn again → clamped at last (d19)
			await check(t, "PgDn clamps at the last row", pageComp.getValue() === "big/d19/", pageComp.getValue());
			pageComp.handleInput("\x1b[5~"); // PgUp → row 7
			await check(t, "PgUp pages one window up", pageComp.getValue() === "big/d07/", pageComp.getValue());

			// Caret-after-prefill: typing must APPEND (caret at end), not insert at 0.
			const { c: caretComp, out: caretOut } = makeComp(pathProj + "/");
			caretComp.handleInput("s");
			await check(t, "prefill caret sits at end: typing appends", caretComp.getValue() === pathProj + "/s", caretComp.getValue());
			caretComp.handleInput("\n");
			await check(t, "enter commits the appended path", caretOut() === pathProj + "/s", String(caretOut()));

			// Single-row list: ↓ mirror fires even when the index cannot move.
			const { c: singleComp, out: singleOut } = makeComp();
			singleComp.handleInput("s");
			singleComp.handleInput("r"); // list = [src/] only (prefix filter)
			singleComp.handleInput("\x1b[B");
			await check(t, "↓ on a single-row list mirrors the row into the field", singleComp.getValue() === "src/", singleComp.getValue());
			singleComp.handleInput("\n");
			await check(t, "enter after ↓ commits the single row", singleOut() === "src/", String(singleOut()));

			// includeFiles mode: the TAB hint follows the SELECTED row (dir = drills
			// in, file = fills). Root rows sort as big/, docs/, src/, a.txt.
			const { c: fileComp } = makeComp(undefined, true);
			const fileRender = () => fileComp.render(80).join("\n");
			const tabLine = () => fileRender().split("\n").find((l) => l.includes("TAB")) ?? "";
			await check(t, "includeFiles lists files after dirs", fileComp.currentCompletions().length === 4 && fileComp.currentCompletions().every((c, i) => (i < 3 ? c.value.endsWith("/") : c.value === "a.txt")), JSON.stringify(fileComp.currentCompletions()));
			await check(t, "hint on a selected dir says TAB drills in", fileRender().includes("TAB drills in"), tabLine());
			for (let i = 0; i < 6 && fileComp.getValue() !== "a.txt"; i++) fileComp.handleInput("\x1b[B");
			await check(t, "navigation reaches the file row", fileComp.getValue() === "a.txt", fileComp.getValue());
			await check(t, "hint on the selected file says TAB fills", fileRender().includes("TAB fills"), tabLine());

			// Generic prefilled text prompt (wizard defaults): prefill, confirm, cancel.
			let tpOut: string | undefined = "unset";
			const tp = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
				tpOut = v;
			});
			await check(t, "text prompt prefills default", tp.getValue() === "voyageai", tp.getValue());
			tp.handleInput("x");
			await check(t, "first printable replaces prefill", tp.getValue() === "x", tp.getValue());
			tp.handleInput("\n");
			await check(t, "text prompt Enter confirms edited value", tpOut === "x", String(tpOut));
			let tpOut3: string | undefined = "unset";
			const tp3 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
				tpOut3 = v;
			});
			tp3.handleInput("a");
			tp3.handleInput("n");
			await check(t, "typing replaces prefill via buffer", tp3.getValue() === "an", tp3.getValue());
			tp3.handleInput("\n");
			await check(t, "buffer value confirms", tpOut3 === "an", String(tpOut3));
			const tp4 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
			tp4.handleInput("\b");
			await check(t, "backspace on pristine clears field", tp4.getValue() === "", tp4.getValue());
			// TAB = skip: keeps the ORIGINAL value, discarding typed edits.
			let tpOut5: string | undefined = "unset";
			const tp5 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, (v) => {
				tpOut5 = v;
			});
			tp5.handleInput("x");
			tp5.handleInput("\t");
			await check(t, "TAB skips to original value (edits discarded)", tpOut5 === "voyageai", String(tpOut5));
			let tpOut6: string | undefined = "unset";
			const tp6 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "" }, (v) => {
				tpOut6 = v;
			});
			tp6.handleInput("\t");
			await check(t, "TAB on empty prompt skips as empty", tpOut6 === "", String(tpOut6));
			let tpOut2: string | undefined = "unset";
			const tp2 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "" }, (v) => {
				tpOut2 = v;
			});
			tp2.handleInput("\x1b");
			await check(t, "text prompt Esc cancels", tpOut2 === undefined, String(tpOut2));
			// Terminal-originated input while pristine must ALSO replace the prefill
			// (repros from the TAB reliability review): kitty CSI-u, astral Unicode,
			// chunked bracketed paste, and cursor movement marks the prefill touched.
			const tp7 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
			tp7.handleInput("\x1b[120u");
			await check(t, "kitty CSI-u printable replaces prefill", tp7.getValue() === "x", tp7.getValue());
			const tp8 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
			tp8.handleInput("😀");
			await check(t, "astral unicode replaces prefill", tp8.getValue() === "😀", tp8.getValue());
			const tp9 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
			tp9.handleInput("\x1b[200~x");
			tp9.handleInput("yz");
			tp9.handleInput("\x1b[201~");
			await check(t, "chunked bracketed paste replaces prefill", tp9.getValue() === "xyz", tp9.getValue());
			tp9.handleInput("!");
			await check(t, "typing continues after paste-replace", tp9.getValue() === "xyz!", tp9.getValue());
			const tp10 = new TextPromptComponent(themeStub, getKeybindings(), { title: "t", startValue: "voyageai" }, () => {});
			tp10.handleInput("\x1b[D");
			tp10.handleInput("x");
			await check(t, "cursor movement marks prefill touched (insert at cursor)", tp10.getValue() === "xvoyageai", tp10.getValue());
		} finally {
			setKeybindings(originalKeybindings);
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
