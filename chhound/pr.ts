/**
 * GitHub PR resolution for /chworktree (PR sandboxes).
 *
 * A PR is identified by its browser URL — https://github.com/<owner>/<repo>/
 * pull/<n> — which carries the full identity (repo + number). Resolution:
 *
 *   1. gh CLI: `gh pr view` → base branch, head branch, head commit (the
 *      baseline anchors at the PR's BASE branch so the top-up only indexes
 *      the PR delta; the head commit is checked out detached).
 *   2. Host repo for the worktree: a LOCAL checkout of <owner>/<repo> when
 *      one exists (cwd repo or a repo known to the library — its cached
 *      baseline is reused), else a BARE MIRROR clone under the mirror cache
 *      root (refspec pinned so plain fetches keep local heads current; the
 *      mirror hosts the baseline for every later PR of the same repo).
 *   3. `git fetch origin refs/pull/<n>/head` → the head commit's objects.
 *
 * The source repo is never modified beyond routine fetches (FETCH_HEAD /
 * remote-tracking refs). Never prints API keys; gh needs no token on disk
 * beyond its own auth.
 */
import * as fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { listBaselines } from "./baseline.js";
import { fetchRef, remoteOrigin, revParse, runGit } from "./git.js";
import { mirrorRoot } from "./paths.js";
import { listSandboxes } from "./sandbox.js";
import type { ChhoundSettings } from "./types.js";

export interface PrRef {
	owner: string;
	repo: string;
	number: number;
}

/** Canonical id string (owner/repo, lowercase) — the comparison key. */
export function prRepoId(owner: string, repo: string): string {
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Parse a pull-request reference. Only the browser-URL form is accepted —
 * it carries the repo identity unambiguously:
 *   https://github.com/<owner>/<repo>/pull/<n>[/][?query][#fragment]
 * Bare github.com/<owner>/<repo>/pull/<n> also works; anything else is not a
 * PR reference (plain branch names stay branch names).
 */
export function parsePrUrl(raw: string): PrRef | undefined {
	let u = raw.trim();
	u = u.split(/[?#]/, 1)[0]!;
	if (u.endsWith("/")) u = u.slice(0, -1);
	const m = u.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
	if (!m) return undefined;
	const owner = m[1]!.toLowerCase();
	const repo = m[2]!.toLowerCase();
	const number = Number(m[3]);
	if (!owner || !repo || !Number.isInteger(number) || number <= 0) return undefined;
	return { owner, repo, number };
}

/** Canonical fetch URL for the mirror clone. */
export function canonicalGitUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}.git`;
}

/** Parse a git remote URL into {owner, repo} when it is a github.com URL. */
export function ownerRepoFromRemoteUrl(remoteUrl: string): { owner: string; repo: string } | undefined {
	const u = remoteUrl.trim().replace(/\.git$/, "");
	const m = u.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/]+)$/);
	if (!m) return undefined;
	return { owner: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase() };
}

export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function runGh(args: string[]): Promise<GhResult> {
	return new Promise((resolve) => {
		const child = spawn("gh", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
}

export interface PrInfo {
	number: number;
	/** Branch the PR merges into (baseline anchor). */
	baseRefName: string;
	/** Branch the PR is from (display). */
	headRefName: string;
	/** Head commit — must match `git fetch refs/pull/<n>/head`. */
	headRefOid: string;
	state: string;
	title?: string;
}

const GH_JSON_FIELDS = "number,baseRefName,headRefName,headRefOid,state,title";

/** `gh pr view` — throws with a hint on gh absence/auth/404. */
export async function ghPrView(owner: string, repo: string, number: number): Promise<PrInfo> {
	const r = await runGh(["pr", "view", String(number), "-R", `${owner}/${repo}`, "--json", GH_JSON_FIELDS]);
	if (r.code === -1) {
		throw new Error(
			`gh CLI is not available (${r.stderr}). PR sandboxes resolve the base branch through GitHub — install the GitHub CLI and authenticate: gh auth login`,
		);
	}
	if (r.code !== 0) {
		throw new Error(
			`gh pr view ${number} -R ${owner}/${repo} failed (${r.code}): ${r.stderr || r.stdout || "unknown error"} — check the PR URL and gh auth status`,
		);
	}
	let info: PrInfo;
	try {
		const parsed = JSON.parse(r.stdout) as Partial<PrInfo>;
		if (
			!parsed ||
			typeof parsed.baseRefName !== "string" ||
			typeof parsed.headRefName !== "string" ||
			typeof parsed.headRefOid !== "string" ||
			typeof parsed.state !== "string"
		) {
			throw new Error("unexpected gh output shape");
		}
		info = {
			number: typeof parsed.number === "number" ? parsed.number : number,
			baseRefName: parsed.baseRefName,
			headRefName: parsed.headRefName,
			headRefOid: parsed.headRefOid,
			state: parsed.state,
			...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
		};
	} catch (err) {
		throw new Error(`gh pr view returned unparseable output: ${r.stdout.slice(0, 200)}`);
	}
	return info;
}

/** Local mirror dir for a repo: <mirrorRoot>/github.com/<owner>/<repo>. */
export function mirrorDir(settings: ChhoundSettings, owner: string, repo: string): string {
	return path.join(mirrorRoot(settings), "github.com", owner.toLowerCase(), repo.toLowerCase());
}

/** Bare-repo marker: bare repos have a HEAD file and never a `.git` entry (dir in clones, file in worktrees). */
function looksBare(dir: string): boolean {
	return fs.existsSync(path.join(dir, "HEAD")) && !fs.existsSync(path.join(dir, ".git"));
}

/**
 * Ensure the bare mirror of <owner>/<repo> exists and is fresh. Bare clones
 * from LOCAL paths carry no fetch refspec (refs are copied at clone time), so
 * the refspec is pinned explicitly — after that a plain `git fetch origin`
 * keeps every refs/heads/* local head at the remote tip, which is what the
 * baseline's local-first anchoring needs (the mirror has no user work — its
 * local heads ARE the remote tips). Returns the mirror dir.
 */
export async function ensureMirror(settings: ChhoundSettings, owner: string, repo: string): Promise<string> {
	const dir = mirrorDir(settings, owner, repo);
	if (!looksBare(dir)) {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		const c = await runGit(["clone", "--bare", "--quiet", canonicalGitUrl(owner, repo), dir], { cwd: path.dirname(dir) });
		if (c.code !== 0) {
			// Clean up a partial clone so the next attempt starts fresh.
			fs.rmSync(dir, { recursive: true, force: true });
			throw new Error(`could not mirror ${owner}/${repo} (${c.stderr || c.stdout || `git clone failed with ${c.code}`}) — PR sandboxes need network access to github.com`);
		}
	}
	const cfg = await runGit(["--git-dir", dir, "config", "--get-all", "remote.origin.fetch"], { cwd: dir });
	if (cfg.code !== 0 || !cfg.stdout.includes("refs/heads/")) {
		await runGit(["--git-dir", dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], { cwd: dir });
	}
	// Best-effort refresh — local heads follow the remote tip (baseline anchor).
	const f = await runGit(["fetch", "--quiet", "origin"], { cwd: dir });
	if (f.code !== 0) {
		throw new Error(`could not refresh mirror ${dir}: ${f.stderr || f.stdout || "git fetch failed"}`);
	}
	return dir;
}

/**
 * Find a LOCAL checkout of <owner>/<repo> to host the PR worktree — preferred
 * over a mirror because its cached baseline (keyed on the checkout path) is
 * then reused. Order: explicit preference roots first (the cwd repo when
 * inside one), then repos known to the library (baselines, then sandboxes,
 * most recent first). Origin URL comparison is normalized (case, .git).
 */
export async function findLocalRepo(
	settings: ChhoundSettings,
	owner: string,
	repo: string,
	preferRoots: string[] = [],
): Promise<string | undefined> {
	const want = prRepoId(owner, repo);
	const seen = new Set<string>();
	const ordered: string[] = [...preferRoots];
	for (const b of listBaselines(settings)) if (typeof b.meta?.repoRoot === "string") ordered.push(b.meta.repoRoot);
	for (const s of listSandboxes(settings)) if (typeof s.meta.repoRoot === "string") ordered.push(s.meta.repoRoot);
	for (const root of ordered) {
		if (!root || seen.has(root) || !fs.existsSync(root)) continue;
		seen.add(root);
		try {
			const origin = await remoteOrigin(root);
			const id = origin ? ownerRepoFromRemoteUrl(origin) : undefined;
			if (id && prRepoId(id.owner, id.repo) === want) return root;
		} catch {
			// not a git repo (anymore) — skip
		}
	}
	return undefined;
}

/**
 * Fetch the PR head into the host repo and return its commit. Uses the
 * synthesized `refs/pull/<n>/head` ref (works for fork and draft PRs too; the
 * ref persists after merge). Only FETCH_HEAD + objects are written.
 */
export async function fetchPrHead(repoRoot: string, number: number): Promise<string> {
	await fetchRef(repoRoot, `refs/pull/${number}/head`);
	const sha = await revParse(repoRoot, "FETCH_HEAD");
	if (!sha) throw new Error(`refs/pull/${number}/head did not resolve to a commit after fetching`);
	return sha;
}
