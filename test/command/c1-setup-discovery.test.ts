import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearDiscoveryOnboardingMarker, hasDiscoveryOnboardingMarker, setDiscoveryOnboardingMarker } from "../../chhound/library.js";
import type { LibraryEntry } from "../../chhound/library.js";
import { globalSettingsPath } from "../../chhound/paths.js";
import { runSetupDiscovery } from "../../chhound/discovery.js";
import type { SetupDeps } from "../../chhound/discovery.js";
import { registerSetupCommand } from "../../setup/command.js";
import { check } from "../lib/checks.js";
import { c1EntryFrom, plantCandidate } from "../lib/c1.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Inventory: both scenarios of the C1 "setup transaction + onboarding control
// flow" section of scripts/smoke.ts @ 9576fb1 (draft PR #3), re-homed
// RED-first into the command tier (feature label c1). Scenario titles + all
// leaf check names verbatim. Command boundary: the /ch-setup registration
// handler is CAPTURED through a fake ExtensionAPI (wiring asserted, not only
// the runSetupDiscovery seam), and SetupDeps are injected so no UI, real
// settings or engine state is touched. Env: fake HOME (global settings +
// library.json live under it); catalog byte-preservation fixture per scenario.
// HARDENING (pre-green RED commit, reviewed): added leaves pin that the
// marker is actually CONSULTED (marker-present global run skips consent and
// completes) and that bypass modes never record the global onboarding marker.

describe("c1 setup discovery", () => {
	test("C1 setup transaction: captured handler and SetupDeps enforce verify-first consent boundaries", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-command-c1-setup-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const candidate = plantCandidate(path.join(root, "repo"), ".chunkhound.json");

			let captured: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			registerSetupCommand(
				{
					registerCommand: (_name: string, d: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
						captured = d.handler;
					},
				} as unknown as ExtensionAPI,
				{},
			);
			const events: string[] = [];
			const candidates = [candidate];
			const deps: SetupDeps = {
				verifyCombined: async () => {
					events.push("verify");
					return true;
				},
				discover: async () => {
					events.push("discover");
					return { candidates, truncated: false, permissionErrors: 0, cancelled: false };
				},
				consent: async () => {
					events.push("consent");
					return "fast-pass" as const;
				},
				readGlobalMarker: async () => false,
				writeGlobalMarker: async () => {
					events.push("marker");
				},
				writeCatalog: async () => {
					events.push("catalog");
				},
			};
			const result = await runSetupDiscovery(deps, { uiAvailable: true });
			await check(t, "C1 setup handler was captured for command integration", typeof captured === "function");
			await check(
				t,
				"C1 successful global UI setup verifies before consent then records",
				events.join(",") === "verify,consent,discover,marker,catalog" && !result.cancelled,
			);

			const beforeBypasses = events.length;
			const headless = await runSetupDiscovery(
				{ ...deps, consent: async () => { throw new Error("prompted headless"); } },
				{ uiAvailable: false },
			);
			const verifyOnly = await runSetupDiscovery(
				{ ...deps, consent: async () => { throw new Error("prompted verify-only"); } },
				{ uiAvailable: true, verifyOnly: true },
			);
			const projectOnly = await runSetupDiscovery(
				{ ...deps, consent: async () => { throw new Error("prompted project-only"); } },
				{ uiAvailable: true, projectOnly: true },
			);
			await check(
				t,
				"C1 verify-only/headless/project-only never prompt or write global catalog",
				!headless.cancelled &&
					!verifyOnly.cancelled &&
					!projectOnly.cancelled &&
					!events.slice(beforeBypasses).includes("consent") &&
					!events.slice(beforeBypasses).includes("catalog"),
			);
			// HARDENING: the same three bypass runs must never record the GLOBAL
			// onboarding marker either — none of them got the consent ask, so
			// none may mark onboarding complete (else every later global setup
			// would silently skip consent).
			await check(t, "C1 bypass modes never record the global onboarding marker", !events.slice(beforeBypasses).includes("marker"));
			// HARDENING: when the global marker is ALREADY present, a global UI
			// run must skip the consent ask entirely and still complete — the
			// draft checks never distinguished marker-present (consent would
			// throw here if consulted).
			const marked = await runSetupDiscovery(
				{
					...deps,
					readGlobalMarker: async () => true,
					consent: async () => { throw new Error("consented while marker present"); },
				},
				{ uiAvailable: true },
			);
			await check(t, "C1 marker-present setup skips consent and completes", !marked.cancelled);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("C1 setup transaction: failure/cancel preserve catalog bytes; marker is global and resettable", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-command-c1-setup-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const library = path.join(path.dirname(globalSettingsPath()), "library.json");
			const candidate = plantCandidate(path.join(root, "repo"), ".chunkhound.json");
			const entry: LibraryEntry = {
				repoRoot: candidate.repoRoot,
				configPath: candidate.configPath,
				dbPath: candidate.dbPath,
				layout: candidate.layout,
				sidecarRoot: candidate.sidecarRoot,
				verdict: "adoptable",
				source: "fast-pass",
				addedAt: "2026-01-01T00:00:00.000Z",
				lastSeenAt: "2026-01-01T00:00:00.000Z",
			};
			fs.mkdirSync(path.dirname(library), { recursive: true });
			fs.writeFileSync(library, JSON.stringify({ version: 1, entries: [entry] }));
			const before = fs.readFileSync(library, "utf8");

			let marker = setDiscoveryOnboardingMarker({});
			let writes = 0;
			const cancelled = await runSetupDiscovery(
				{
					verifyCombined: async () => false,
					discover: async () => ({ candidates: [], truncated: false, permissionErrors: 0, cancelled: true }),
					writeCatalog: async () => {
						writes++;
					},
				},
				{ uiAvailable: true },
			);
			marker = clearDiscoveryOnboardingMarker(marker);
			await check(
				t,
				"C1 failed verification gives no consent/catalog state change",
				cancelled.cancelled && writes === 0 && fs.readFileSync(library, "utf8") === before,
			);
			await check(
				t,
				"C1 global additive marker resets and project overlay cannot satisfy it",
				!hasDiscoveryOnboardingMarker(marker) && !hasDiscoveryOnboardingMarker({ discoveryOnboardingComplete: false }),
			);
			const standalone = await runSetupDiscovery(
				{
					verifyCombined: async () => true,
					discover: async () => ({ candidates: [candidate], truncated: false, permissionErrors: 0, cancelled: false }),
				},
				{ standalone: true, uiAvailable: false },
			);
			await check(t, "C1 standalone deep sweep remains reachable without onboarding", standalone.candidates.length === 1);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
