import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, tierOrder, tierTimeoutMs, type Tier } from "./manifest.js";

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsRoot, "../..");
const reporter = path.join(testsRoot, "lib", "reporter.ts");

type Selection = { all: boolean; tiers: string[]; features: string[]; subjects: string[]; selfcheck: boolean };
type Report = { assertions: number; failedAssertions: number; failedBeforeAssertion: number; skipped: number; cancelled: number; timeouts: number; fileFailures: number };
type Summary = Report & { success: boolean; reason?: string };

let activeChild: ChildProcess | undefined;
let interrupted: NodeJS.Signals | undefined;
let interruptTimer: NodeJS.Timeout | undefined;

async function emitSummary(summary: Summary): Promise<void> {
	console.log(`CHHOUND_TEST_SUMMARY ${JSON.stringify(summary)}`);
	const artifact = process.env.CHHOUND_TEST_SUMMARY_PATH;
	if (artifact) await fs.writeFile(artifact, JSON.stringify(summary) + "\n", { mode: 0o600 });
}

async function discover(dir = testsRoot, prefix = ""): Promise<string[]> {
	const found: string[] = [];
	for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) found.push(...await discover(path.join(dir, entry.name), relative));
		else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative);
	}
	return found;
}

function parse(argv: string[]): Selection {
	const selected: Selection = { all: false, tiers: [], features: [], subjects: [], selfcheck: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		if (flag === "--all") selected.all = true;
		else if (flag === "--selfcheck") selected.selfcheck = true;
		else if (["--tier", "--feature", "--subject"].includes(flag)) {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			selected[`${flag.slice(2)}s` as "tiers" | "features" | "subjects"].push(...value.split(",").filter(Boolean));
		} else throw new Error(`unknown selector: ${flag}`);
	}
	if (!selected.all && !selected.selfcheck && !selected.tiers.length && !selected.features.length && !selected.subjects.length) throw new Error("select --all, --tier, --feature, or --subject");
	return selected;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: repoRoot, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
		activeChild = child;
		let output = "";
		const append = (chunk: Buffer) => { if (output.length < 20_000) output += chunk.toString("utf8").slice(0, 20_000 - output.length); };
		if (capture) { child.stdout?.on("data", append); child.stderr?.on("data", append); }
		child.once("error", (error) => { if (activeChild === child) activeChild = undefined; if (interruptTimer) clearTimeout(interruptTimer); reject(error); });
		child.once("close", (code) => { if (activeChild === child) activeChild = undefined; if (interruptTimer) clearTimeout(interruptTimer); resolve({ code, output }); });
	});
}

async function selfcheck(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chhound-runner-selfcheck-"));
	try {
		const cases: readonly [string, string, number, Partial<Report>, boolean?][] = [
			["clean", `import { test } from 'node:test'; test('scenario', async t => { await t.test('leaf', () => {}); });`, 0, { assertions: 1, failedAssertions: 0, failedBeforeAssertion: 0 }],
			["leaf", `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('scenario', async t => { await t.test('leaf', () => assert.ok(false)); });`, 1, { failedAssertions: 1, failedBeforeAssertion: 0 }],
			["throw", `import { test } from 'node:test'; test('scenario', () => { throw new Error('boom'); });`, 1, { failedAssertions: 0, failedBeforeAssertion: 1 }],
			["timeout", `import { test } from 'node:test'; test('scenario', { timeout: 30 }, async () => await new Promise(() => {}));`, 1, { failedAssertions: 0, failedBeforeAssertion: 1, timeouts: 1 }],
			["skip", `import { test } from 'node:test'; test('skipped', { skip: true }, () => {});`, 0, { skipped: 1 }],
			["cancel", `import { test } from 'node:test'; test('scenario', t => { t.test('cancelled', () => new Promise(() => {})); throw new Error('stop'); });`, 1, { cancelled: 1, failedBeforeAssertion: 1 }],
			["file", `throw new Error('top-level failure');`, 1, { fileFailures: 1 }],
			["redaction", `import { test } from 'node:test'; test('scenario', () => { throw new Error('\\"apiKey\\":\\"sk-chcanary-123\\"'); });`, 1, { failedBeforeAssertion: 1 }, true],
		];
		for (const [name, source, expectedCode, expected, redact] of cases) {
			const file = path.join(root, `${name}.test.mjs`);
			const report = path.join(root, `${name}.json`);
			await fs.writeFile(file, source, { mode: 0o600 });
			const result = await run(process.execPath, ["--import", "tsx", "--test", "--test-reporter", reporter, file], { ...process.env, CHHOUND_TEST_REPORT_PATH: report }, true);
			assert.equal(result.code, expectedCode, `${name} exit code`);
			const summary = JSON.parse(await fs.readFile(report, "utf8")) as Report;
			for (const [field, value] of Object.entries(expected) as [keyof Report, number][]) assert.equal(summary[field], value, `${name} ${field}`);
			if (redact) assert.ok(!result.output.includes("sk-chcanary-123"), "reporter redacts JSON-shaped apiKey values");
		}
		console.log("runner selfcheck assertions: clean; failing leaf; scenario throw; timeout; skip; cancel; file failure; JSON apiKey redaction");
	} finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
	const selection = parse(process.argv.slice(2));
	if (selection.selfcheck) { await selfcheck(); return; }
	const discovered = await discover();
	const unknown = discovered.filter((file) => manifest[file] === undefined);
	const missing = Object.keys(manifest).filter((file) => !discovered.includes(file));
	if (unknown.length || missing.length) throw new Error(`manifest mismatch: unclassified=[${unknown}] missing=[${missing}]`);
	const all = discovered.map((file) => ({ file, classification: manifest[file]! }));
	const matchesTier = (tier: Tier) => selection.tiers.some((requested) => requested === tier || (requested === "robustness" && tier.startsWith("robustness/")));
	for (const tier of selection.tiers) if (!tierOrder.includes(tier as Tier) && tier !== "robustness") throw new Error(`unknown tier: ${tier}`);
	for (const [kind, values] of [["feature", selection.features], ["subject", selection.subjects]] as const) {
		for (const value of values) {
			const found = all.some(({ classification }) => kind === "feature" ? classification.features?.includes(value) : classification.subject === value);
			if (!found) throw new Error(`${kind} selector matched no test files: ${value}`);
		}
	}
	const selected = all.filter(({ classification }) => selection.all || (!selection.tiers.length || matchesTier(classification.tier)) && (!selection.features.length || selection.features.some((f) => classification.features?.includes(f))) && (!selection.subjects.length || selection.subjects.includes(classification.subject)));
	if (!selected.length) throw new Error("selector intersection matched no test files");
	const reportRoot = await fs.mkdtemp(path.join(repoRoot, "tmp-test-summary-"));
	const total: Report = { assertions: 0, failedAssertions: 0, failedBeforeAssertion: 0, skipped: 0, cancelled: 0, timeouts: 0, fileFailures: 0 };
	let failed = false;
	try {
		for (const tier of tierOrder) {
			if (interrupted) break;
			const files = selected.filter(({ classification }) => classification.tier === tier).map(({ file }) => path.join(testsRoot, file));
			if (!files.length) continue;
			console.log(`\n== tier ${tier}`);
			const reportPath = path.join(reportRoot, `${tier.replace("/", "-")}.json`);
			const diagDir = path.join(reportRoot, `${tier.replace("/", "-")}-diag`);
			await fs.mkdir(diagDir, { recursive: true });
			const concurrency = tier === "unit" ? Math.min(4, os.cpus().length) : 1;
			const result = await run(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, `--test-timeout=${tierTimeoutMs[tier]}`, `--test-reporter=${reporter}`, ...files], { ...process.env, CHHOUND_TEST_REPORT_PATH: reportPath, CHHOUND_TEST_TIER: tier, CHHOUND_TEST_DIAG_DIR: diagDir });
			if (result.code !== 0) {
				failed = true;
				// Test processes may write failure artifacts (captured subprocess output)
				// into the diag dir; surface them through the runner's own stdout, which
				// reaches CI logs even though node:test swallows child console output.
				// Best-effort: artifact I/O must never mask the real failure summary.
				try {
					for (const file of (await fs.readdir(diagDir)).sort()) {
						const text = await fs.readFile(path.join(diagDir, file), "utf8");
						console.error(`=== ${tier} artifact: ${file} ===\n${text.slice(-16_000)}`);
					}
				} catch (error) {
					console.error(`diag artifact read failed for ${tier}: ${error instanceof Error ? error.message : error}`);
				}
			}
			try {
				const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Report;
				for (const key of Object.keys(total) as (keyof Report)[]) total[key] += report[key];
			} catch (error) { failed = true; console.error(`reporter failure for ${tier}: ${error instanceof Error ? error.message : error}`); }
		}
		const hasFailures = failed || total.failedAssertions > 0 || total.failedBeforeAssertion > 0 || total.cancelled > 0 || total.timeouts > 0 || total.fileFailures > 0 || interrupted !== undefined;
		await emitSummary({ success: !hasFailures, ...(interrupted ? { reason: `interrupted by ${interrupted}` } : {}), ...total });
		if (hasFailures) process.exitCode = 1;
	} finally { await fs.rm(reportRoot, { recursive: true, force: true }); }
}

const interrupt = (signal: NodeJS.Signals) => {
	if (interrupted) return;
	interrupted = signal;
	console.error(`test runner received ${signal}; stopping active node:test child`);
	activeChild?.kill(signal);
	interruptTimer = setTimeout(() => activeChild?.kill("SIGKILL"), 5_000);
	interruptTimer.unref();
};
process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));

main().catch(async (error) => {
	const reason = error instanceof Error ? error.message : String(error);
	console.error(`test runner preflight failed: ${reason}`);
	await emitSummary({ success: false, reason, assertions: 0, failedAssertions: 0, failedBeforeAssertion: 0, skipped: 0, cancelled: 0, timeouts: 0, fileFailures: 0 });
	process.exitCode = 1;
});
