import { describe, test } from "node:test";
import { parseArgs, WORKTREE_VALUE_FLAGS } from "../../chhound/args.js";
import { check } from "../lib/checks.js";

// Inventory: 12 legacy checks moved from smoke.ts section 1 (parseArgs).
describe("parseArgs", () => {
	test("legacy parseArgs obligations", async (t) => {
		const p = parseArgs(`../wt -b feature/x --from abc123 --no-index --config "my cfg.json"`);
		await check(t, "positionals", JSON.stringify(p.positionals) === JSON.stringify(["../wt"]), JSON.stringify(p.positionals));
		await check(t, "-b value", p.flags["b"] === "feature/x");
		await check(t, "--from value", p.flags["from"] === "abc123");
		await check(t, "--no-index boolean", p.flags["no-index"] === true);
		await check(t, "quoted --config", p.flags["config"] === "my cfg.json");
		const p2 = parseArgs(`--dest ~/wt -b x`);
		await check(t, "--dest space value", p2.flags["dest"] === "~/wt" && p2.positionals.length === 0, JSON.stringify(p2));
		const p3 = parseArgs(`--dest=/tmp/x`);
		await check(t, "--dest = form", p3.flags["dest"] === "/tmp/x", JSON.stringify(p3));
		const p4 = parseArgs(`--dest`);
		await check(t, "--dest bare → true", p4.flags["dest"] === true, JSON.stringify(p4));
		const p5 = parseArgs(`--no-index wt main`, WORKTREE_VALUE_FLAGS);
		await check(t, "schema: boolean flag doesn't consume positionals", p5.flags["no-index"] === true && JSON.stringify(p5.positionals) === JSON.stringify(["wt", "main"]), JSON.stringify(p5));
		const p6 = parseArgs(`-b feature/x --no-index main`, WORKTREE_VALUE_FLAGS);
		await check(t, "schema: value flag consumes, boolean doesn't", p6.flags["b"] === "feature/x" && p6.flags["no-index"] === true && JSON.stringify(p6.positionals) === JSON.stringify(["main"]), JSON.stringify(p6));
		const p7 = parseArgs(`-- --no-index wt`);
		await check(t, "-- ends flag parsing (rest is positional)", JSON.stringify(p7.positionals) === JSON.stringify(["--no-index", "wt"]) && !("" in p7.flags), JSON.stringify(p7));
		const p8 = parseArgs(`"my project/`);
		await check(t, "unterminated quote is one positional", JSON.stringify(p8.positionals) === JSON.stringify(["my project/"]), JSON.stringify(p8));
	});
});
