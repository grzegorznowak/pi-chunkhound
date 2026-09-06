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

const id = (data: Record<string, unknown>): string => `${data.file ?? ""}:${data.nesting ?? 0}:${data.name ?? ""}`;

/** Node's public event-stream reporter interface; no TAP/stdout scraping. */
export default async function* reporter(source: AsyncIterable<Event>): AsyncGenerator<string> {
	const children = new Set<string>();
	const stack = new Map<number, string>();
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
		if (event.type === "test:enqueue") {
			const current = id(data);
			if (nesting > 0) children.add(stack.get(nesting - 1) ?? "");
			stack.set(nesting, current);
			for (const depth of [...stack.keys()]) if (depth > nesting) stack.delete(depth);
			continue;
		}
		if (event.type === "test:start") {
			const header = `${data.file ?? ""}/${data.name ?? ""}`;
			if (header !== lastHeader && nesting <= 1) {
				lastHeader = header;
				yield `== ${process.env.CHHOUND_TEST_TIER ?? "test"}/${header}\n`;
			}
			continue;
		}
		if (event.type !== "test:pass" && event.type !== "test:fail" && event.type !== "test:skip" && event.type !== "test:cancel") continue;
		const current = id(data);
		const details = (data.details ?? {}) as Record<string, unknown>;
		const failureType = String((details.error as Record<string, unknown> | undefined)?.failureType ?? "");
		const isFile = nesting === 0 && String(data.name ?? "") === String(data.file ?? "");
		const isParent = children.has(current) || failureType === "subtestsFailed";
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
