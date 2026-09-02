import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChhoundSettings } from "./types.js";

export const PKG_DIR_NAME = "pi-chhound";
export const SETTINGS_FILE = "settings.json";

/** Global settings: ~/.pi/agent/pi-chhound/settings.json (agenticoding convention). */
export function globalSettingsPath(): string {
	return path.join(homedir(), ".pi", "agent", PKG_DIR_NAME, SETTINGS_FILE);
}

/** Project settings: <project>/.pi/pi-chhound/settings.json (CONFIG_DIR_NAME = ".pi"). */
export function projectSettingsPath(projectRoot: string): string {
	return path.join(projectRoot, ".pi", PKG_DIR_NAME, SETTINGS_FILE);
}

export function xdgStateHome(): string {
	return process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
}

export function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
}

/** Managed sandbox library root — one dir PAIR per (repo, branch): the sandbox
 * dir (worktree checkout + config) and its hidden `.state/<name>` sibling
 * (index db + meta, outside the indexed root). */
export function sandboxRoot(settings: ChhoundSettings): string {
	return (
		settings.sandboxRoot ||
		process.env.CHHOUND_SANDBOX_ROOT ||
		// Legacy alias: pre-Design-1 settings named this "worktree base" (worktrees
		// lived at <base>/<branch>). Under Design 1 worktrees live inside their
		// sandbox, so the base IS the sandbox library root.
		settings.worktreeBase ||
		path.join(xdgStateHome(), PKG_DIR_NAME, "sandboxes")
	);
}

/** Baseline cache root — one dir per repo/ref. */
export function baseRoot(settings: ChhoundSettings): string {
	return (
		settings.baseRoot ||
		process.env.CHHOUND_BASE_ROOT ||
		path.join(xdgCacheHome(), PKG_DIR_NAME, "bases")
	);
}

/**
 * Bare-repo mirror cache root — one bare clone per remote repo (the worktree
 * host for PR/remote sandboxes when no local checkout of the repo exists).
 * Mirrors live at <root>/github.com/<owner>/<repo>.
 */
export function mirrorRoot(settings: ChhoundSettings): string {
	return (
		settings.mirrorRoot ||
		process.env.CHHOUND_MIRROR_ROOT ||
		path.join(xdgCacheHome(), PKG_DIR_NAME, "repos")
	);
}

export function shortHash(input: string, len = 8): string {
	return createHash("sha256").update(input).digest("hex").slice(0, len);
}

/** Slugify a path segment for use in directory names. */
export function slugify(segment: string): string {
	return segment.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/**
 * Parse a git remote URL into a filesystem-safe "host/owner/repo" slug path.
 * Handles git@host:owner/repo.git, https://host/owner/repo(.git), ssh://git@host/owner/repo.
 */
export function remoteSlug(remoteUrl: string): string {
	let u = remoteUrl.trim();
	u = u.replace(/^git@/, "").replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "");
	u = u.replace(/\.git$/, "");
	const match = u.match(/^([^:/]+)[:/](.+)$/);
	if (!match) return slugify(u);
	return path.join(slugify(match[1]), slugify(match[2]));
}
