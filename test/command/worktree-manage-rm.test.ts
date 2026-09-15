import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import { runGit } from "../../chhound/git.js";
import { writeSandboxMeta } from "../../chhound/sandbox.js";
import { extensionCheckout } from "../../worktree/manage.js";
import { check } from "../lib/checks.js";
import { applyEnv, isolatedEnv, makeFakeHome, makeFixtureRoot, snapshotEnv } from "../lib/isolation.js";

// Command-layer pins for /ch-worktree rm (review V1-08): the registered
// command handler is driven through REAL dispatch, arg parsing and notices —
// never runWorktreeRemove directly (it is not exported). The engine paths
// (removeWorktreeEntry hard edges) are pinned in test/fs/worktree-manage.test.ts;
// this file pins the surface the operator actually sees:
//   - arg grammar + unknown-flag guards,
//   - headless no-target usage (V2-04: the unreachable-hint regression),
//   - the interactive picker + confirm preview/cancel,
//   - the extension-source guard both ways, the locked-worktree refusal (A2),
//   - the "<remote>/<branch> slots are never deleted" guarantee at message level,
//   - verb dispatch (rm/remove only).
//
// Fixtures are self-owned throwaway roots under os.tmpdir with a fake HOME and
// CHHOUND_SANDBOX_ROOT; git only ever runs in the fixture repo. The
// extension-source sandbox points meta.worktree at the REAL loaded checkout:
// the engine refuses without --force, and on --force `git worktree remove`
// runs in the FIXTURE repo where that path is not a registered worktree (git
// refuses: "is not a working tree"), so storage removal stays inside the
// fixture root and the real checkout is never touched (asserted).

type Notice = { msg: string; type?: "info" | "warning" | "error" };
type NoticeLog = Notice[];
type CmdHandler = (args: string, ctx: unknown) => Promise<void>;

interface SandboxFixture {
	id: string;
	dir: string;
	stateDir: string;
}

const themeStub = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => text };

function noticeText(notices: NoticeLog): string {
	return notices.map((n) => n.msg).join("\n---\n");
}

/** Register the real command and capture its handler (fresh closure each call). */
async function rmHandler(): Promise<CmdHandler> {
	const { registerWorktreeCommand } = await import("../../worktree/command.js");
	let handler: CmdHandler | undefined;
	const pi = {
		registerCommand(_name: string, def: { handler: CmdHandler }) {
			handler = def.handler;
		},
	};
	registerWorktreeCommand(pi as never, {} as never);
	if (!handler) throw new Error("registerWorktreeCommand did not register a handler");
	return handler;
}

/** Headless host shape: print mode with no-op select/confirm stubs. */
function headlessCtx(cwd: string, notices: NoticeLog): unknown {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {
			notify: (msg: string, type?: Notice["type"]) => notices.push({ msg, type }),
			select: async () => undefined,
			confirm: async () => false,
		},
	};
}

async function until(ready: () => boolean, ms = 5_000): Promise<void> {
	const start = Date.now();
	while (!ready()) {
		if (Date.now() - start > ms) throw new Error("timed out waiting for the interactive picker to mount");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Run git in a fixture repo; throws so a broken fixture fails loudly. */
async function git(args: string[], cwd: string): Promise<string> {
	const r = await runGit(args, { cwd });
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
	return r.stdout;
}

async function makeRepo(dir: string): Promise<string> {
	fs.mkdirSync(dir, { recursive: true });
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.name", "cmd-rm"], dir);
	await git(["config", "user.email", "cmd-rm@test"], dir);
	fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
	await git(["add", "seed.txt"], dir);
	await git(["commit", "-m", "seed"], dir);
	return (await git(["rev-parse", "HEAD"], dir)).trim();
}

/** Write one discoverable sandbox (dir + .state/<id> + meta.json) under the fixture library. */
function writeSandbox(
	sandboxRoot: string,
	spec: { id: string; worktree: string; repoRoot: string; branch: string; baseRef: string; baseCommit: string },
): SandboxFixture {
	const dir = path.join(sandboxRoot, spec.id);
	const stateDir = path.join(sandboxRoot, ".state", spec.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "checkout-marker.txt"), `${spec.id}\n`);
	writeSandboxMeta(stateDir, {
		version: 1,
		worktree: spec.worktree,
		repoRoot: spec.repoRoot,
		branch: spec.branch,
		baseRef: spec.baseRef,
		baseCommit: spec.baseCommit,
		chhoundVersion: "test-fixture",
		createdAt: "2026-09-15T00:00:00.000Z",
		copiedFrom: "",
		dbPath: path.join(stateDir, "db"),
	});
	return { id: spec.id, dir, stateDir };
}

describe("worktree rm command surface", () => {
	test("rm argument grammar errors are reported before any removal", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-grammar-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const handler = await rmHandler();
			const cases: readonly [string, RegExp][] = [
				["rm a b", /at most one/],
				["rm --search x", /--search belongs to ls/],
				["rm --dest x", /--dest is a creation option/],
				["rm --force=yes", /--force takes no value/],
			];
			for (const [args, pattern] of cases) {
				const notices: NoticeLog = [];
				await handler(args, headlessCtx(root, notices));
				const notice = notices[notices.length - 1];
				await check(
					t,
					`${args} → usage error`,
					notices.length === 1 && notice !== undefined && notice.type === "error" && pattern.test(notice.msg),
					JSON.stringify(notices),
				);
			}
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("headless rm without a target reaches the usage hint (V2-04 regression)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-headless-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const handler = await rmHandler();
			const notices: NoticeLog = [];
			// The no-op UI shape that used to swallow the usage path: select and
			// confirm exist but resolve undefined/false without ever prompting.
			await handler("rm", headlessCtx(root, notices));
			const text = noticeText(notices);
			await check(t, "the usage hint is reported", text.includes("rm needs a target when no interactive picker is available"), text);
			await check(t, "the headless path never reports a silent cancellation", !text.includes("Cancelled."), text);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("interactive pick + confirm removes the picked sandbox; a decline cancels", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-interactive-");
		try {
			const home = await makeFakeHome(root);
			const sandboxRoot = path.join(root, "sandboxes");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: sandboxRoot } }));
			const handler = await rmHandler();
			const repo = path.join(root, "repo");
			const baseCommit = await makeRepo(repo);

			const mount = (confirmResult: boolean, notices: NoticeLog) => {
				let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
				const confirmCalls: { title: string; message: string }[] = [];
				const ui = {
					notify: (msg: string, type?: Notice["type"]) => notices.push({ msg, type }),
					confirm: async (title: string, message: string) => {
						confirmCalls.push({ title, message });
						return confirmResult;
					},
					custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => typeof component) =>
						await new Promise<unknown>((resolve) => {
							component = factory({ requestRender() {} }, themeStub, getKeybindings(), resolve);
						}),
				};
				const ctx = { cwd: root, hasUI: true, mode: "tui", ui };
				const pending = handler("rm", ctx);
				return { component: () => component, pending, confirmCalls };
			};

			// ── confirm=true: the picked sandbox is really removed ──
			const wtOne = path.join(root, "wt-one");
			await git(["worktree", "add", "-b", "rm-one", wtOne, "main"], repo);
			const one = writeSandbox(sandboxRoot, { id: "sb-rm-one-0001", worktree: wtOne, repoRoot: repo, branch: "rm-one", baseRef: "rm-one", baseCommit });
			const noticesOne: NoticeLog = [];
			const first = mount(true, noticesOne);
			await until(() => first.component() !== undefined);
			const frame = first.component()!.render(80).join("\n");
			await check(t, "the picker renders the sandbox row", frame.includes("sb-rm-one-0001"), frame);
			first.component()!.handleInput("\n");
			await first.pending;
			const textOne = noticeText(noticesOne);
			await check(t, "the confirm dialog carries the impact preview", first.confirmCalls.length === 1 && first.confirmCalls[0]!.message.includes("NOT touched"), JSON.stringify(first.confirmCalls));
			await check(t, "confirmed removal reports the storage steps", textOne.includes("✓ Removed sb-rm-one-0001") && textOne.includes("storage: state dir removed · sandbox dir removed"), textOne);
			await check(t, "both storage halves are really gone", !fs.existsSync(one.dir) && !fs.existsSync(one.stateDir), JSON.stringify({ dir: fs.existsSync(one.dir), state: fs.existsSync(one.stateDir) }));

			// ── confirm=false: nothing is deleted ──
			const wtTwo = path.join(root, "wt-two");
			await git(["worktree", "add", "-b", "rm-keep", wtTwo, "main"], repo);
			const two = writeSandbox(sandboxRoot, { id: "sb-rm-keep-0002", worktree: wtTwo, repoRoot: repo, branch: "rm-keep", baseRef: "rm-keep", baseCommit });
			const noticesTwo: NoticeLog = [];
			const second = mount(false, noticesTwo);
			await until(() => second.component() !== undefined);
			second.component()!.handleInput("\n");
			await second.pending;
			const textTwo = noticeText(noticesTwo);
			await check(t, "a declined confirm cancels explicitly", textTwo.includes("Cancelled — nothing was removed."), textTwo);
			await check(t, "the declined sandbox keeps its storage and checkout", fs.existsSync(two.dir) && fs.existsSync(two.stateDir) && fs.existsSync(wtTwo), JSON.stringify({ dir: fs.existsSync(two.dir), state: fs.existsSync(two.stateDir), wt: fs.existsSync(wtTwo) }));
			await check(t, "the declined run never reports a removal", !textTwo.includes("✓ Removed"), textTwo);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("extension-source sandbox refuses without --force and removes with it", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-extsource-");
		try {
			const home = await makeFakeHome(root);
			const sandboxRoot = path.join(root, "sandboxes");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: sandboxRoot } }));
			const handler = await rmHandler();
			const repo = path.join(root, "repo");
			const baseCommit = await makeRepo(repo);
			const extCheckout = extensionCheckout();
			if (!extCheckout) throw new Error("the loaded extension checkout could not be resolved");
			const extMarker = path.join(extCheckout, "worktree", "manage.ts");
			const entry = writeSandbox(sandboxRoot, { id: "sb-ext-src-0003", worktree: extCheckout, repoRoot: repo, branch: "ext-src", baseRef: "ext-src", baseCommit });

			const refused: NoticeLog = [];
			await handler("rm sb-ext-src-0003", headlessCtx(root, refused));
			const refusedText = noticeText(refused);
			await check(t, "one-go rm of the extension source is refused", refusedText.includes("runs THIS extension (the loaded code lives in its checkout)"), refusedText);
			await check(t, "the refusal points at --force", refusedText.includes("--force"), refusedText);
			await check(t, "the refused sandbox keeps both storage halves", fs.existsSync(entry.dir) && fs.existsSync(entry.stateDir), JSON.stringify({ dir: fs.existsSync(entry.dir), state: fs.existsSync(entry.stateDir) }));
			await check(t, "the real extension checkout is untouched by the refusal", fs.existsSync(extMarker), extCheckout);

			const forced: NoticeLog = [];
			await handler("rm sb-ext-src-0003 --force", headlessCtx(root, forced));
			const forcedText = noticeText(forced);
			await check(t, "forced removal proceeds and reports the storage steps", forcedText.includes("✓ Removed sb-ext-src-0003") && forcedText.includes("storage:"), forcedText);
			await check(t, "the fixture sandbox halves are gone", !fs.existsSync(entry.dir) && !fs.existsSync(entry.stateDir), JSON.stringify({ dir: fs.existsSync(entry.dir), state: fs.existsSync(entry.stateDir) }));
			await check(t, "the real extension checkout is still fully intact", fs.existsSync(extMarker) && fs.existsSync(path.join(extCheckout, "package.json")), extCheckout);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("locked worktree refuses at the command layer with the unlock hint (A2)", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-locked-");
		try {
			const home = await makeFakeHome(root);
			const sandboxRoot = path.join(root, "sandboxes");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: sandboxRoot } }));
			const handler = await rmHandler();
			const repo = path.join(root, "repo");
			const baseCommit = await makeRepo(repo);
			const wt = path.join(root, "locked-wt");
			await git(["worktree", "add", "-b", "locked-branch", wt, "main"], repo);
			await git(["worktree", "lock", wt], repo);
			const entry = writeSandbox(sandboxRoot, { id: "sb-locked-0004", worktree: wt, repoRoot: repo, branch: "locked-branch", baseRef: "main", baseCommit });

			const notices: NoticeLog = [];
			await handler("rm sb-locked-0004", headlessCtx(root, notices));
			const text = noticeText(notices);
			await check(t, "the locked worktree is refused, not force-removed", text.includes("Removal refused") && text.includes("locked"), text);
			await check(t, "the refusal names the unlock hint", text.includes(`git worktree unlock ${wt}`), text);
			await check(t, "no storage half was deleted", fs.existsSync(entry.dir) && fs.existsSync(entry.stateDir), JSON.stringify({ dir: fs.existsSync(entry.dir), state: fs.existsSync(entry.stateDir) }));
			await check(t, "the checkout and its registration survive", fs.existsSync(wt) && (await git(["worktree", "list", "--porcelain"], repo)).includes(wt), wt);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("remote/<branch> sandbox never claims a branch delete and keeps the ref", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-remote-");
		try {
			const home = await makeFakeHome(root);
			const sandboxRoot = path.join(root, "sandboxes");
			applyEnv(isolatedEnv({ home, overrides: { CHHOUND_SANDBOX_ROOT: sandboxRoot } }));
			const handler = await rmHandler();
			const repo = path.join(root, "repo");
			const baseCommit = await makeRepo(repo);
			await git(["update-ref", "refs/remotes/origin/main", baseCommit], repo);
			const wt = path.join(root, "remote-wt");
			await git(["worktree", "add", "--detach", wt, "origin/main"], repo);
			const entry = writeSandbox(sandboxRoot, { id: "sb-remote-0005", worktree: wt, repoRoot: repo, branch: "origin/main", baseRef: "origin/main", baseCommit });

			const notices: NoticeLog = [];
			await handler("rm sb-remote-0005", headlessCtx(root, notices));
			const text = noticeText(notices);
			await check(t, "the remote slot is removed with its storage", text.includes("✓ Removed sb-remote-0005") && text.includes("storage:"), text);
			await check(t, "no branch delete or keep claim is made", !/branch:/.test(text), text);
			await check(t, "refs/remotes/origin/main still exists", (await runGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repo })).code === 0, "");
			await check(t, "the remote ref still points at the base commit", (await git(["rev-parse", "refs/remotes/origin/main"], repo)).trim() === baseCommit, "");
			await check(t, "both storage halves are gone", !fs.existsSync(entry.dir) && !fs.existsSync(entry.stateDir), JSON.stringify({ dir: fs.existsSync(entry.dir), state: fs.existsSync(entry.stateDir) }));
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("only rm/remove dispatch the removal verb", async (t) => {
		const env = snapshotEnv();
		const root = await makeFixtureRoot("pi-chhound-cmd-rm-dispatch-");
		try {
			const home = await makeFakeHome(root);
			applyEnv(isolatedEnv({ home }));
			const handler = await rmHandler();

			// "rmx" is not a verb: it falls through to creation grammar (the
			// positional is treated as a repo arg) instead of reaching rm.
			const rmx: NoticeLog = [];
			await handler("rmx", headlessCtx(root, rmx));
			const rmxText = noticeText(rmx);
			await check(t, "rmx falls through to the creation grammar", rmxText.includes("does not resolve to a git repo"), rmxText);
			await check(t, "rmx never reaches the rm usage path", !rmxText.includes("rm needs a target"), rmxText);

			// The full verb name dispatches to the same rm flow.
			const remove: NoticeLog = [];
			await handler("remove", headlessCtx(root, remove));
			const removeText = noticeText(remove);
			await check(t, "the remove verb dispatches to rm", removeText.includes("rm needs a target when no interactive picker is available"), removeText);
		} finally {
			applyEnv(env);
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
