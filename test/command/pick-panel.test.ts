import { describe, test } from "node:test";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { PickPanelComponent, promptPick } from "../../chhound/pick-panel.js";
import { check } from "../lib/checks.js";

// Inventory: the wizard's repo picker and rm picker must feel like the
// /ch-worktree manager list (banded cursor row + bold label), which pi's native
// select cannot express; the native select stays as the RPC/print fallback.

const options = ["alpha (baseline) — /repos/alpha", "beta (indexed) — /repos/beta", "a pull request — paste its GitHub URL"];

const themeStub = (record?: { bands: string[]; bolds: string[] }) => ({
	fg: (_color: string, text: string) => text,
	bold: (text: string) => {
		record?.bolds.push(text);
		return text;
	},
	bg: (color: string, text: string) => {
		if (color === "selectedBg") record?.bands.push(text);
		return text;
	},
});

const tuiStub = { requestRender: () => {} } as unknown as ConstructorParameters<typeof PickPanelComponent>[0];

describe("pick panel", () => {
	test("cursor row carries the manager band; chrome and width hold", async (t) => {
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const record = { bands: [] as string[], bolds: [] as string[] };
			const component = new PickPanelComponent(tuiStub, themeStub(record), getKeybindings(), { title: "Select a repository", options }, () => {});
			const frame = component.render(60).join("\n");
			await check(t, "exactly one row is banded — the cursor row", record.bands.length === 1 && record.bands[0]!.includes(options[0]!) && !record.bands[0]!.includes(options[1]!), frame);
			await check(t, "the band reaches the dialog width", visibleWidth(record.bands[0]!) === 60, String(visibleWidth(record.bands[0]!)));
			await check(t, "the cursor label is bold and arrow-marked", record.bolds.includes(options[0]!) && frame.includes(`→ ${options[0]}`), frame);
			await check(t, "unselected rows stay plain and unbanded", frame.includes(`  ${options[1]}`) && frame.includes(`  ${options[2]}`) && !record.bolds.includes(options[1]!), frame);
			await check(t, "dialog chrome: rules, title, hint", frame.includes("─".repeat(60)) && frame.includes("Select a repository") && frame.includes("Enter select") && frame.includes("Esc cancel"), frame);
			await check(t, "every rendered line fits the dialog width", component.render(60).every((line) => visibleWidth(line) <= 60), JSON.stringify(component.render(60)));
			const long = new PickPanelComponent(tuiStub, themeStub(), getKeybindings(), { title: "t", options: ["x".repeat(120)] }, () => {});
			await check(t, "a long option clips at the dialog width", long.render(30).every((line) => visibleWidth(line) <= 30), JSON.stringify(long.render(30)));
		} finally { setKeybindings(original); }
	});

	test("navigation clamps, pages the viewport, and resolves on Enter/Esc", async (t) => {
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			let picked: string | undefined = "unset";
			const component = new PickPanelComponent(tuiStub, themeStub(), getKeybindings(), { title: "Pick", options }, (value) => { picked = value; });
			component.handleInput("\x1b[B");
			await check(t, "arrow-down moves the cursor", component.index === 1, String(component.index));
			component.handleInput("\x1b[106u");
			await check(t, "Kitty-encoded j moves the cursor (keyboard protocol)", component.index === 2, String(component.index));
			component.handleInput("\x1b[B");
			await check(t, "the cursor clamps at the last row (no wrap)", component.index === 2, String(component.index));
			component.handleInput("\x1b[107u");
			await check(t, "Kitty-encoded k moves back", component.index === 1, String(component.index));
			component.handleInput("\n");
			await check(t, "Enter resolves the highlighted option", picked === options[1], String(picked));

			let cancelled: string | undefined = "unset";
			const esc = new PickPanelComponent(tuiStub, themeStub(), getKeybindings(), { title: "Pick", options }, (value) => { cancelled = value; });
			esc.handleInput("\x1b");
			await check(t, "Esc cancels with undefined", cancelled === undefined, String(cancelled));

			let scrolled: string | undefined = "unset";
			const many = Array.from({ length: 20 }, (_, index) => `option-${index + 1}`);
			const paged = new PickPanelComponent(tuiStub, themeStub(), getKeybindings(), { title: "Pick", options: many }, (value) => { scrolled = value; });
			let frame = paged.render(40).join("\n");
			await check(t, "20 options render a 12-row window with the position", frame.includes("option-1") && frame.includes("option-12") && !frame.includes("option-13") && frame.includes("(1/20)"), frame);
			paged.handleInput("\x1b[6~");
			frame = paged.render(40).join("\n");
			await check(t, "PgDn moves a page and scrolls the cursor into view", paged.index === 12 && !/option-1\b/.test(frame) && frame.includes("option-13") && !frame.includes("option-14") && frame.includes("(13/20)"), frame);
			paged.handleInput("\n");
			await check(t, "Enter resolves the scrolled-to option", scrolled === "option-13", String(scrolled));
		} finally { setKeybindings(original); }
	});

	test("promptPick prefers the plugin panel and falls back to ui.select", async (t) => {
		const original = getKeybindings();
		try {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const offered: string[][] = [];
			const viaSelect = await promptPick({ select: async (_title: string, incoming: string[]) => { offered.push(incoming); return incoming[1]; } }, { title: "Pick", options: ["a", "b"] });
			await check(t, "no ctx.ui.custom → the native select gets the same options", viaSelect === "b" && offered.length === 1 && offered[0]!.join(",") === "a,b", JSON.stringify({ viaSelect, offered }));

			let component: PickPanelComponent | undefined;
			let chosen: string | undefined = "unset";
			const ui = {
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: string | undefined) => void) => PickPanelComponent) => await new Promise<unknown>((resolve) => {
					component = factory(tuiStub, themeStub(), getKeybindings(), (value) => { chosen = value; resolve(undefined); });
				}),
			};
			const pending = promptPick(ui as never, { title: "Pick", options: ["a", "b"] });
			component!.handleInput("\n");
			await pending;
			await check(t, "ctx.ui.custom present → the plugin panel resolves the pick", chosen === "a", String(chosen));
		} finally { setKeybindings(original); }
	});
});
