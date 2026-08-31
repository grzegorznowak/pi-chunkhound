import { spawn } from "node:child_process";
import path from "node:path";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function runGit(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
}

/** Resolve the git repo root; throws when cwd is not inside a work tree. */
export async function requireGitRoot(cwd: string): Promise<string> {
	const r = await runGit(["rev-parse", "--show-toplevel"], { cwd });
	if (r.code !== 0) throw new Error(`Not inside a git work tree: ${r.stderr || r.stdout}`);
	return r.stdout;
}

export async function gitRootOrNull(cwd: string): Promise<string | undefined> {
	try {
		return await requireGitRoot(cwd);
	} catch {
		return undefined;
	}
}

/** Walk up from `from` to the nearest git repo root (or undefined). */
export async function findRepoRoot(from: string): Promise<string | undefined> {
	let dir = path.resolve(from);
	for (;;) {
		const r = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir });
		if (r.code === 0) return r.stdout;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export interface WorktreeAddOptions {
	cwd: string;
	path: string;
	/** Branch to create (-b <name>). */
	createBranch?: string;
	/** Existing branch to check out. */
	branch?: string;
	commitIsh?: string;
	detach?: boolean;
}

export async function gitWorktreeAdd(opts: WorktreeAddOptions): Promise<void> {
	const args = ["worktree", "add"];
	if (opts.createBranch) args.push("-b", opts.createBranch);
	else if (opts.detach) args.push("--detach");
	args.push(opts.path);
	if (opts.commitIsh) args.push(opts.commitIsh);
	const r = await runGit(args, { cwd: opts.cwd });
	if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
}

export async function gitWorktreeRemove(wtPath: string): Promise<void> {
	const r = await runGit(["worktree", "remove", "--force", wtPath]);
	if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr || r.stdout}`);
}

/**
 * Branches checked out in ANY worktree (incl. the main tree) → worktree path.
 * git refuses to check such a branch out into another worktree, so these are
 * not valid "existing branch to check out" choices.
 */
export async function checkedOutBranches(cwd: string): Promise<Map<string, string>> {
	const r = await runGit(["worktree", "list", "--porcelain"], { cwd });
	const out = new Map<string, string>();
	if (r.code !== 0) return out;
	let wtPath = "";
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
		else if (line.startsWith("branch refs/heads/")) out.set(line.slice("branch refs/heads/".length), wtPath);
	}
	return out;
}

/** Resolve the repo's default remote branch (e.g. "main") or undefined. */
export async function defaultRemoteBranch(cwd: string): Promise<string | undefined> {
	const r = await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (r.code !== 0) return undefined;
	return r.stdout.replace(/^origin\//, "");
}

export async function remoteOrigin(cwd: string): Promise<string | undefined> {
	const r = await runGit(["remote", "get-url", "origin"], { cwd });
	return r.code === 0 ? r.stdout : undefined;
}

export async function fetchRef(cwd: string, ref: string): Promise<void> {
	const r = await runGit(["fetch", "--quiet", "origin", ref], { cwd });
	if (r.code !== 0) throw new Error(r.stderr || r.stdout || `git fetch origin ${ref} failed`);
}

export async function currentBranch(cwd: string): Promise<string> {
	const r = await runGit(["branch", "--show-current"], { cwd });
	return r.code === 0 ? r.stdout : "(detached)";
}

export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
	const r = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
	return r.code === 0 ? r.stdout : undefined;
}

/** Absolute git dir for a work tree (main repo or linked worktree). */
export async function absoluteGitDir(cwd: string): Promise<string | undefined> {
	const r = await runGit(["rev-parse", "--absolute-git-dir"], { cwd });
	return r.code === 0 ? r.stdout : undefined;
}

/**
 * Path to the repo's info/exclude file (COMMON git dir — linked worktrees
 * share it; per-worktree .git/worktrees/<name>/info/exclude is NOT read).
 */
export async function repoExcludePath(cwd: string): Promise<string | undefined> {
	const r = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
	if (r.code !== 0) return undefined;
	return `${r.stdout}/info/exclude`;
}
