import { statSync } from "node:fs";
import path from "node:path";
import { chhoundVersion } from "../../chhound/cli.js";

export interface EngineBinary {
	/** Absolute path to the chunkhound executable to re-inject into child envs. */
	binary: string;
	/** Version line from `chunkhound --version` (diagnostics only). */
	version: string;
}

/**
 * Resolve the engine binary BEFORE env isolation: isolatedEnv strips
 * CHHOUND_BINARY and later PATH changes must not switch which engine the
 * tests drive. CHHOUND_BINARY wins; otherwise `chunkhound` is resolved via
 * PATH. Callers re-inject the returned absolute path into isolated child
 * environments via `isolatedEnv({ overrides: { CHHOUND_BINARY: binary } })`.
 * A missing/unexecutable engine is an explicit prerequisite failure — never
 * an automatic skip.
 */
export async function resolveEngineBinary(): Promise<EngineBinary> {
	const configured = process.env.CHHOUND_BINARY;
	const raw = configured?.trim() || "chunkhound";
	let binary = raw;
	if (!(raw.includes("/") || raw.includes(path.sep))) {
		const found = (process.env.PATH ?? "")
			.split(path.delimiter)
			.map((dir) => dir && path.join(dir, raw))
			.find((c) => {
				try {
					return c && statSync(c).isFile();
				} catch {
					return false;
				}
			});
		if (!found) {
			throw new Error(
				"chunkhound engine not found on PATH and CHHOUND_BINARY is unset — install the engine or export CHHOUND_BINARY",
			);
		}
		binary = found;
	}
	const st = statSync(binary);
	if (!st.isFile()) {
		throw new Error(`CHHOUND_BINARY does not point to a file: ${binary}`);
	}
	if (process.platform !== "win32" && (st.mode & 0o111) === 0) {
		throw new Error(`chunkhound binary is not executable: ${binary}`);
	}
	return { binary: path.resolve(binary), version: await chhoundVersion() };
}
