import assert from "node:assert/strict";
import type { TestContext } from "node:test";

/**
 * Report one migration obligation as an independently-running leaf test.
 * Callers must await each check so a failed leaf cannot suppress later checks.
 */
export async function check(t: TestContext, name: string, condition: boolean, detail = ""): Promise<void> {
	await t.test(name, () => {
		assert.ok(condition, detail);
	});
}
