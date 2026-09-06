// Temporary whole-suite adapter — it exceeds the 120s/file envelope until Phase 2 extraction.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const smoke = path.join(repoRoot, "scripts", "smoke.ts");
const outputCap = 16_000;
const secretKey = "(?:api[_-]?key|api[_-]?token|access[_-]?token|auth(?:orization)?|credential(?:s)?|password|secret(?:s)?|token|key)";
const secretValue = new RegExp(`((?:"?${secretKey}"?)\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}\\]]+)`, "gi");

const redact = (text: string): string => text.replace(secretValue, "$1[redacted]");

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	return new Promise((resolve, reject) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
		child.once("error", reject);
	});
}

/** Failure-focused excerpt: FAIL lines, crash lines and the passing tally. */
function failureFocus(text: string): string {
	const lines = text.split("\n");
	const relevant = lines.filter((line) => line.includes("FAIL ") || line.includes("smoke crashed") || /\/\d+ checks passed$/.test(line.trim()));
	const tail = lines.slice(-3).join("\n");
	return [...relevant, ...(relevant.length ? [] : [tail])].join("\n") || text.slice(-1000);
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = waitForClose(child);
	child.kill("SIGTERM");
	const killed = new Promise<void>((resolve) => {
		const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); resolve(); }, 5_000);
		timer.unref();
	});
	await Promise.race([closed.then(() => undefined), killed]);
	await closed;
}

test("remaining legacy smoke obligations", { timeout: 300_000 }, async (t) => {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chhound-legacy-adapter-"));
	let child: ChildProcess | undefined;
	try {
		const output = await new Promise<string>((resolve, reject) => {
			child = spawn(process.execPath, ["--import", "tsx", smoke], {
				cwd: repoRoot,
				env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let text = "";
			const append = (chunk: Buffer) => {
				text = (text + chunk.toString("utf8")).slice(-outputCap);
			};
			child.stdout?.on("data", append);
			child.stderr?.on("data", append);
			const closed = waitForClose(child);
			closed.then(({ code, signal }) => code === 0 ? resolve(text) : reject(new Error(`legacy smoke exit=${code} signal=${signal}; focus:\n${redact(failureFocus(text))}`)), reject);
		});
		assert.ok(!output.includes("FAIL "), "legacy smoke reported FAIL");
		assert.ok(!output.includes("smoke crashed"), "legacy smoke crashed");
	} finally {
		if (child) await stopChild(child);
		await fs.rm(scratch, { recursive: true, force: true });
	}
});
