/**
 * Test-environment isolation helpers (design page "Shared-helper contracts").
 *
 * - Full env (+cwd) snapshot/restore: presence AND value. Keys that were
 *   originally absent are deleted again on restore; keys added during the
 *   scope are removed; nothing leaks between scenarios.
 * - Owned fixture roots under os.tmpdir() with a fake HOME plus private
 *   XDG_* roots.
 * - isolatedEnv(): a base env with real user/engine/provider state removed,
 *   ready for fixture overrides. No secrets, real settings, real engine
 *   roots or real Git config can be reached through it. HOME/XDG roots are
 *   replaced by private fixture roots and TMPDIR/TMP/TEMP point inside the
 *   fake HOME.
 *
 * Engine-binary resolution must happen BEFORE isolation (see lib/engine.ts);
 * helper modules have no side effects at import time.
 */
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

export type EnvSnapshot = Record<string, string | undefined>;

/** Full copy of the current environment (keys only; undefined never stored). */
export function snapshotEnv(): EnvSnapshot {
	return { ...process.env };
}

/** Replace the process environment with the given snapshot (presence AND value). */
export function applyEnv(env: EnvSnapshot): void {
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** Restore a snapshot taken by snapshotEnv(). */
export function restoreEnv(snapshot: EnvSnapshot): void {
	applyEnv(snapshot);
}

export interface ScopeSnapshot {
	env: EnvSnapshot;
	cwd: string;
}

export function snapshotScope(): ScopeSnapshot {
	return { env: snapshotEnv(), cwd: process.cwd() };
}

export function restoreScope(snapshot: ScopeSnapshot): void {
	restoreEnv(snapshot.env);
	if (process.cwd() !== snapshot.cwd) process.chdir(snapshot.cwd);
}

/**
 * Allocate an owned scratch root under os.tmpdir(); caller removes it.
 * Rejects traversal so the prefix can never escape the temp root.
 */
export async function makeFixtureRoot(prefix: string): Promise<string> {
	if (!/^[A-Za-z0-9._-]+$/.test(prefix) || prefix.includes("..")) {
		throw new Error(`invalid fixture-root prefix: ${prefix}`);
	}
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Create a fake HOME tree (private XDG subroots pre-created) and return the
 * home path. The caller owns the parent root and removes it afterwards.
 */
export async function makeFakeHome(parent: string, name = "home"): Promise<string> {
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
		throw new Error(`invalid fake-home name: ${name}`);
	}
	const home = path.join(parent, name);
	await fs.mkdir(path.join(home, ".config"), { recursive: true });
	await fs.mkdir(path.join(home, ".cache"), { recursive: true });
	await fs.mkdir(path.join(home, ".local", "state"), { recursive: true });
	await fs.mkdir(path.join(home, ".runtime"), { recursive: true, mode: 0o700 });
	await fs.mkdir(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
	return home;
}

/**
 * Real-user/engine/provider state that must never reach an isolated test
 * scope. Any env key listed here (or matching CHHOUND_/CHUNKHOUND_,
 * credential-shaped keys, or XDG roots) is dropped unless re-supplied via
 * `overrides`.
 */
export function isolatedEnv(options: {
	home: string;
	tmp?: string;
	overrides?: EnvSnapshot;
	base?: EnvSnapshot;
}): EnvSnapshot {
	const base: EnvSnapshot = options.base ?? snapshotEnv();
	const out: EnvSnapshot = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (isPrivateKey(key)) continue;
		out[key] = value;
	}
	out.HOME = options.home;
	out.XDG_CACHE_HOME = path.join(options.home, ".cache");
	out.XDG_STATE_HOME = path.join(options.home, ".local", "state");
	out.XDG_CONFIG_HOME = path.join(options.home, ".config");
	out.XDG_RUNTIME_DIR = path.join(options.home, ".runtime");
	out.GIT_CONFIG_NOSYSTEM = "1";
	const tmp = options.tmp ?? path.join(options.home, "tmp");
	out.TMPDIR = tmp;
	out.TMP = tmp;
	out.TEMP = tmp;
	for (const [key, value] of Object.entries(options.overrides ?? {})) {
		if (value === undefined) delete out[key];
		else out[key] = value;
	}
	return out;
}

const PRIVATE_PREFIX = /^(CHHOUND_|CHUNKHOUND_|GIT_)/;
const PRIVATE_SHAPE = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|KEY)(_|$)/i;
const PRIVATE_XDG = /^XDG_/;

function isPrivateKey(key: string): boolean {
	return PRIVATE_PREFIX.test(key) || PRIVATE_XDG.test(key) || PRIVATE_SHAPE.test(key);
}
