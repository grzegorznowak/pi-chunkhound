import fs from "node:fs";

type Event = { type: string; data?: Record<string, unknown> };

const secretKey = "(?:api[_-]?key|api[_-]?token|access[_-]?token|auth(?:orization)?|credential(?:s)?|password|secret(?:s)?|token|key)";
const secretValue = new RegExp(`((?:"?${secretKey}"?)\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}\\]]+)`, "gi");

const cap = (value: unknown, limit = 2500): string => {
	let text: string;
	try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { text = String(value); }
	return text.replace(secretValue, "$1[redacted]").replace(/\s+/g, " ").slice(0, limit);
};

/** Cross-process test failures arrive as plain objects; message is top-level. */
const errorText = (error: unknown): string => {
	if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
		return (error as { message: string }).message;
	}
	return String(error);
};

/**
 * Node's public event-stream reporter interface; no TAP/stdout scraping.
 * Parent membership is derived from a global well-nested frame stack: a
 * test is a parent iff at least one test:start occurred strictly between
 * its own start and its terminal event (frame.mark vs startCounter). This
 * avoids two misclassification traps: declaration-order enqueue slots (a
 * describe body enqueues ALL children before the first runs, so a later
 * sibling clobbers the slot and the first sibling's pass is double-counted
 * as an assertion leaf), and file attribution (leaf subtests created by the
 * shared check() helper carry the HELPER's data.file, not the test file's).
 * Per-file event sequences are well-nested, so interleaved frames from
 * concurrent files pop in matching order; stale deeper frames (e.g. a
 * timed-out child that never terminates) are discarded defensively.
 */
export default async function* reporter(source: AsyncIterable<Event>): AsyncGenerator<string> {
	const frames: { nesting: number; mark: number }[] = [];
	let startCounter = 0;
	let assertions = 0;
	let failedAssertions = 0;
	let failedBeforeAssertion = 0;
	let skipped = 0;
	let cancelled = 0;
	let timeouts = 0;
	let fileFailures = 0;
	let lastHeader = "";

	for await (const event of source) {
		const data = event.data ?? {};
		const nesting = Number(data.nesting ?? 0);
		if (event.type === "test:start") {
			frames.push({ nesting, mark: startCounter });
			startCounter++;
			const header = `${data.file ?? ""}/${data.name ?? ""}`;
			if (header !== lastHeader && nesting <= 1) {
				lastHeader = header;
				yield `== ${process.env.CHHOUND_TEST_TIER ?? "test"}/${header}\n`;
			}
			continue;
		}
		if (event.type !== "test:pass" && event.type !== "test:fail" && event.type !== "test:skip" && event.type !== "test:cancel") continue;
		const details = (data.details ?? {}) as Record<string, unknown>;
		const failureType = String((details.error as Record<string, unknown> | undefined)?.failureType ?? "");
		// Pop this test's frame; discard stale deeper frames from children
		// that never terminated (timeout/kill paths) without touching
		// shallower frames belonging to still-open ancestors or other files.
		let frame: { nesting: number; mark: number } | undefined;
		while (frames.length > 0) {
			const top = frames[frames.length - 1];
			if (top.nesting === nesting) {
				frame = frames.pop();
				break;
			}
			if (top.nesting < nesting) break;
			frames.pop();
		}
		const isParent = (frame !== undefined && startCounter > frame.mark + 1) || failureType === "subtestsFailed";
		const isFile = nesting === 0 && String(data.name ?? "") === String(data.file ?? "");
		const isCancelled = event.type === "test:cancel" || failureType.toLowerCase().includes("cancelled");
		if (event.type === "test:skip" || data.skip === true) { skipped++; yield `skip ${String(data.name)}\n`; continue; }
		if (isCancelled) { cancelled++; yield `cancelled ${String(data.name)}\n`; continue; }
		if (isFile) {
			if (event.type === "test:fail") { fileFailures++; yield `FAIL file ${String(data.file)} — ${cap(errorText(details.error))}\n`; }
			continue;
		}
		if (isParent) {
			if (event.type === "test:fail" && failureType !== "subtestsFailed") {
				failedBeforeAssertion++;
				if (failureType === "testTimeoutFailure") timeouts++;
				yield `FAIL scenario ${String(data.name)} — ${cap(errorText(details.error))}\n`;
			}
			continue;
		}
		// A top-level test is a scenario; its direct nested tests are assertion leaves.
		if (event.type === "test:fail" && nesting === 0) {
			failedBeforeAssertion++;
			if (failureType === "testTimeoutFailure") timeouts++;
			yield `FAIL scenario ${String(data.name)} — ${cap(errorText(details.error))}\n`;
		} else if (event.type === "test:pass") { assertions++; yield `ok ${String(data.name)}\n`; }
		else {
			failedAssertions++;
			if (failureType === "testTimeoutFailure") timeouts++;
			yield `FAIL ${String(data.name)} — ${cap(errorText(details.error))}\n`;
		}
	}
	const summary = { assertions, failedAssertions, failedBeforeAssertion, skipped, cancelled, timeouts, fileFailures };
	const output = process.env.CHHOUND_TEST_REPORT_PATH;
	if (output) fs.writeFileSync(output, JSON.stringify(summary) + "\n", { mode: 0o600 });
	yield `summary assertions=${assertions} failed=${failedAssertions} scenarioFailures=${failedBeforeAssertion} skipped=${skipped} cancelled=${cancelled} timeouts=${timeouts} fileFailures=${fileFailures}\n`;
}
