import * as fs from "node:fs";
import path from "node:path";
import { globalSettingsPath, projectSettingsPath } from "./paths.js";
import { SETTINGS_VERSION, type ChhoundSettings } from "./types.js";

export const DEFAULT_SETTINGS: ChhoundSettings = { version: SETTINGS_VERSION };

export interface LoadedSettings {
	settings: ChhoundSettings;
	globalPath: string;
	projectPath?: string;
	issue?: string;
}

export function mergeSettings(base: ChhoundSettings, overlay: Partial<ChhoundSettings>): ChhoundSettings {
	return {
		...base,
		...overlay,
		version: SETTINGS_VERSION,
		embedding: { ...(base.embedding ?? {}), ...(overlay.embedding ?? {}) },
		llm: { ...(base.llm ?? {}), ...(overlay.llm ?? {}) },
		indexing: { ...(base.indexing ?? {}), ...(overlay.indexing ?? {}) },
		research: { ...(base.research ?? {}), ...(overlay.research ?? {}) },
		baseline: { ...(base.baseline ?? {}), ...(overlay.baseline ?? {}) },
	};
}

function readSettingsFile(p: string): { settings: ChhoundSettings; issue?: string } {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
		if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== SETTINGS_VERSION) {
			return { settings: DEFAULT_SETTINGS, issue: `unsupported or missing version in ${p}` };
		}
		return { settings: raw as ChhoundSettings };
	} catch (err) {
		// First run: no file yet is the normal state, not an issue.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { settings: DEFAULT_SETTINGS };
		}
		try {
			fs.copyFileSync(p, `${p}.bak`);
		} catch {
			// no backup possible
		}
		return {
			settings: DEFAULT_SETTINGS,
			issue: `could not read ${p}: ${err instanceof Error ? err.message : String(err)} (backed up to .bak)`,
		};
	}
}

/**
 * Load settings: global first, then project (project shadows global per-key).
 * Project root should be the git repo root when inside a repo, else cwd.
 */
export function loadSettings(projectRoot?: string): LoadedSettings {
	const globalPath = globalSettingsPath();
	const global = readSettingsFile(globalPath);
	let settings = mergeSettings(DEFAULT_SETTINGS, global.settings);
	let projectPath: string | undefined;
	let issue = global.issue;
	if (projectRoot) {
		const p = projectSettingsPath(projectRoot);
		if (fs.existsSync(p)) {
			const proj = readSettingsFile(p);
			settings = mergeSettings(settings, proj.settings);
			projectPath = p;
			issue = issue ?? proj.issue;
		}
	}
	return { settings, globalPath, projectPath, issue };
}

/** Atomic write (temp + rename). Returns the path written. */
export function saveSettings(settings: ChhoundSettings, scope: "global" | "project", projectRoot?: string): string {
	const p = scope === "global" ? globalSettingsPath() : projectSettingsPath(projectRoot ?? process.cwd());
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, p);
	// Settings may hold the api key (v1) — restrict access.
	try {
		fs.chmodSync(p, 0o600);
	} catch {
		// best-effort
	}
	return p;
}
