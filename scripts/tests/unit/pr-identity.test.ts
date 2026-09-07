import { describe, test } from "node:test";
import { ownerRepoFromRemoteUrl, parsePrUrl } from "../../../chhound/pr.js";
import { check } from "../lib/checks.js";

// Inventory: 6 legacy checks moved from smoke.ts section 17 (PR resolution,
// hermetic) — the pure URL-parsing and remote-url identity predicates. The
// git/gh-shim host ladder + detached checkout moved to fs/pr-host.test.ts and
// the real mirror anchor/refresh to engine/pr-baseline.test.ts.

describe("pr identity", () => {
	test("legacy PR URL parsing obligations", async (t) => {
		const pu = parsePrUrl("https://github.com/ghuser/add/pull/29");
		await check(t, "parsePrUrl full URL", pu?.owner === "ghuser" && pu?.repo === "add" && pu?.number === 29, JSON.stringify(pu));
		await check(t, "parsePrUrl tolerates trailing slash/query", parsePrUrl("https://github.com/ghuser/add/pull/29/?x=1")?.number === 29, "");
		await check(t, "parsePrUrl rejects non-PR input", parsePrUrl("feature/x") === undefined && parsePrUrl("https://github.com/a/b/tree/main") === undefined && parsePrUrl("github.com/a/b/issues/3") === undefined, "");
		await check(t, "ownerRepoFromRemoteUrl https", JSON.stringify(ownerRepoFromRemoteUrl("https://github.com/GhUser/Add.git")) === JSON.stringify({ owner: "ghuser", repo: "add" }), "");
		await check(t, "ownerRepoFromRemoteUrl ssh", JSON.stringify(ownerRepoFromRemoteUrl("git@github.com:ghuser/add.git")) === JSON.stringify({ owner: "ghuser", repo: "add" }), "");
		await check(t, "ownerRepoFromRemoteUrl non-github → undefined", ownerRepoFromRemoteUrl("https://gitlab.com/a/b") === undefined && ownerRepoFromRemoteUrl("/tmp/bare.git") === undefined, "");
	});
});
