import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { LIBRARY_VERSION, libraryPath, mergeLibraryEntry, readLibrary, writeLibrary } from "../../chhound/library.js";
import type { LibraryEntry } from "../../chhound/library.js";
import { globalSettingsPath } from "../../chhound/paths.js";
import { check } from "../lib/checks.js";
import { c1EntryFrom, C1_CANARY, plantCandidate } from "../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: the first two scenarios of the C1 "catalog schema + concurrent
// merge" section of scripts/smoke.ts @ 9576fb1 (draft PR #3), re-homed
// RED-first into the modular suite (feature label c1). Scenario identities
// (titles + leaf check names) are verbatim. The third scenario of that
// section — real contending child writers + lock timeout — moved to
// robustness/fs/c1-library-writers.test.ts (whole, verbatim). Env: fake HOME
// so library.json resolves beside the fake global settings file; catalog
// fixture bytes planted per scenario (no shared mutable state).

describe("c1 library catalog", () => {
	test("C1 catalog schema: personal versioned entries are secret-free and deduplicated", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-library-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			// library.json lives beside the global settings file under fake HOME.
			const library = path.join(path.dirname(globalSettingsPath()), "library.json");
			const repo = path.join(root, "repo");
			const entry = c1EntryFrom(plantCandidate(repo, ".chunkhound.json"));
			fs.mkdirSync(path.dirname(library), { recursive: true });
			const existing: LibraryEntry = { ...entry, configPath: "/old/config.json", dbPath: "/old/db", lastSeenAt: "2026-01-01T00:00:01.000Z" };
			fs.writeFileSync(library, JSON.stringify({ version: 1, entries: [existing] }) + "\n", { mode: 0o600 });

			const read = await readLibrary();
			const merged = mergeLibraryEntry(read.catalog, entry, new Date("2026-01-02T00:00:00.000Z"));

			await check(t, "C1 catalog is beside global settings", libraryPath() === library);
			await check(
				t,
				"C1 catalog version and exact entry fields",
				merged.version === LIBRARY_VERSION &&
					Object.keys(merged.entries[0]!).sort().join(",") ===
						"addedAt,configPath,dbPath,lastSeenAt,layout,repoRoot,sidecarRoot,source,verdict",
			);
			await check(
				t,
				"C1 dedup refreshes current paths and lastSeenAt",
				merged.entries.length === 1 && merged.entries[0]!.dbPath === entry.dbPath && merged.entries[0]!.lastSeenAt === "2026-01-02T00:00:00.000Z",
			);
			await check(t, "C1 catalog never serializes canary", !JSON.stringify(merged).includes(C1_CANARY));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 catalog malformed/future: sanitized advisory read and guarded write", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-fs-c1-library-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const library = path.join(path.dirname(globalSettingsPath()), "library.json");
			const repo = path.join(root, "repo");
			const entry = c1EntryFrom(plantCandidate(repo, ".chunkhound.json"));
			const futureFixture = path.join(root, "future-library.json");
			const malformedEntryFixture = path.join(root, "malformed-entry-library.json");
			fs.mkdirSync(path.dirname(library), { recursive: true });

			fs.writeFileSync(library, `{ broken ${C1_CANARY}`, { mode: 0o600 });
			fs.writeFileSync(futureFixture, JSON.stringify({ version: 99, entries: [entry] }), { mode: 0o600 });
			fs.writeFileSync(malformedEntryFixture, JSON.stringify({ version: 1, entries: [{ repoRoot: repo, configPath: 9, secret: C1_CANARY }] }), { mode: 0o600 });

			const malformed = await readLibrary();
			await check(
				t,
				"C1 malformed JSON is empty advisory with sanitized issue",
				malformed.catalog.entries.length === 0 && !!malformed.issue && !malformed.issue.includes(C1_CANARY) && !malformed.issue.includes("Unexpected token"),
			);
			fs.copyFileSync(futureFixture, library);
			const future = await readLibrary();
			let refused = false;
			try {
				await writeLibrary({ version: LIBRARY_VERSION, entries: [entry] });
			} catch {
				refused = true;
			}
			await check(t, "C1 future version is empty advisory", future.catalog.entries.length === 0 && !!future.issue);
			await check(t, "C1 future version write is refused", refused);
			fs.copyFileSync(malformedEntryFixture, library);
			const malformedEntries = await readLibrary();
			await check(
				t,
				"C1 malformed catalog entries are dropped without exposing canaries",
				malformedEntries.catalog.entries.length === 0 && !malformedEntries.issue?.includes(C1_CANARY),
			);
			fs.writeFileSync(library, JSON.stringify({ version: 1, entries: [] }));
			let oldWasParseable = false;
			await writeLibrary(
				{ version: LIBRARY_VERSION, entries: [entry] },
				{
					onPhase: (phase) => {
						if (phase === "beforeRename") oldWasParseable = JSON.parse(fs.readFileSync(library, "utf8")).entries.length === 0;
					},
				},
			);
			await check(
				t,
				"C1 atomic temp-and-rename leaves parseable catalog",
				oldWasParseable && JSON.parse(fs.readFileSync(library, "utf8")).entries.length === 1,
			);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
