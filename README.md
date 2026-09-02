# pi-chhound

> **⚠ Status: early development.** Commands, flags, settings, and on-disk layout may
> change without notice. Nothing has been released — install from source; there is no
> stable API or versioning contract yet.

ChunkHound commands for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent):
git worktrees with their **own chunkhound index**, an MCP bridge into those indexes,
plus setup and status tooling.

Wraps the `chunkhound` CLI/datastore. Every worktree gets its own index, built from a
shared per-repo **baseline** (the mainline branch, regularly refreshed) plus an
incremental **top-up** at the worktree's branch point — the same mechanics the CURe
engine uses for PR sandboxes. PR sandboxes anchor the baseline at the PR's **base
branch**, so the top-up only indexes the PR's own diff. Baselines anchor to the
**local** branch the worktree branches from (`origin/<ref>` is only a fallback,
best-effort fetched, when no local branch of that name exists) — so top-ups stay
small even when local and remote drift.

## Requirements

- Node.js >= 22.19
- pi >= 0.84.1
- the `chunkhound` CLI on `PATH` (5.x)
- the GitHub CLI `gh` (authenticated) — only for PR sandboxes (base-branch
  resolution); branch worktrees don't need it

## Install

**As a pi package (git)** — add to `packages` in `~/.pi/agent/settings.json` (or project `.pi/settings.json`):

```json
"packages": ["git:github.com/grzegorznowak/pi-chunkhound@main"]
```

or `pi install git:github.com/grzegorznowak/pi-chunkhound@main` (try first with `pi -e …` — installs for one run only). Pi clones the repo, runs `npm install` for its dependencies, and loads it on startup. `pi update --extensions` reconciles the clone to the pinned ref.

**From source (development)** — symlink this folder into `~/.pi/agent/extensions/` (or `.pi/extensions/`), then `/reload`:

```
ln -s /path/to/pi-chhound ~/.pi/agent/extensions/pi-chhound
```

Don't use both install paths at once — the commands would register twice. Configure once with `/ch-setup` (embedding provider/model, LLM for research tools, baseline ref & max age, worktree library root).

## Commands

| Command | Purpose |
|---|---|
| `/chworktree [repo] [branch] [-b <name>] [--from <ref>] [--dest <dir>] [--config <file>] [--no-index] [--force-reindex] [--refresh-baseline]` | Create a git worktree with its own chunkhound index. A PR URL (`https://github.com/<owner>/<repo>/pull/<n>`) in the repo slot creates a pull-request sandbox (wizard: pick "a pull request" and paste the URL). |
| `/ch-mcp [<worktree\|storage-id> [--disconnect] [--no-daemon] [--read-only] [--prefix <pfx>]]` | Connect pi to a worktree's index over MCP. |
| `/ch-status [--prune]` | List worktrees, baselines, and live MCP connections. |
| `/ch-setup [flags]` | Configure embedding/LLM/baseline settings. |

### /chworktree — three ways to invoke

- **Wizard** — `/chworktree` with no other arguments: lets you pick the repo
  (current repo, repos from the index library, **a pull request**, or a typed
  path), then asks for the branch name (Enter = new branch `<repo>-wt`) and the
  worktree library root (Enter = the configured root). Picking the PR option
  prompts for the **full PR URL** as in the browser
  (`https://github.com/<owner>/<repo>/pull/<n>`) — it carries the repo identity,
  so the branch prompt is skipped and the sandbox is created as `pull/<n>`.
  With no argument at all it also lets you pick the repo. Path prompts support
  TAB completion with ↑/↓ navigation (TAB accepts, Enter confirms, Esc cancels).
- **One-go (agents)** — everything on one line, fully non-interactive:
  `/chworktree [repo] -b <branch> [--dest <dir>]`. The first argument is always
  the repo. A **PR URL in the repo slot** (`/chworktree https://github.com/<owner>/<repo>/pull/<n>`)
  creates a pull-request sandbox the same way the wizard's PR option does.
- **Remote branches** — the branch slot also accepts `<remote>/<branch>`
  (e.g. `origin/feature`): the remote branch is checked out **detached at its
  tip** (a remote-tracking ref can't be checked out as a branch; a missing
  tracking ref is best-effort fetched first). The baseline anchors at the
  remote ref itself.

In all modes the location must not overlap another chunkhound worktree or index —
the wizard re-prompts, one-go aborts. **Storage-anchored layout**: the checkout
lives inside its sandbox dir together with the materialized config (the
`/workspaces` pattern); the index db, its claim sidecar and the sandbox meta
live in a hidden sibling `.state/<name>` dir — OUTSIDE the indexed root, so no
engine/plugin artifact is ever indexed. The engine-pinned `.chunkhound/` daemon
dir sits inside the sandbox dir but is excluded from indexing. Nothing is ever
written into the checkout or the source repo — no `.chunkhound/`, no git-exclude
edits.
Long index runs stream a live progress widget above the editor
(`baseline index — embedding · db 5.1 MB +3.1 MB · 1:12`, with a 40-cell rail
`██████░░░░ … 45% · 636/1,412 files` — the rail tracks chunk generation first,
then embedding batches; a sweeping rail marks indeterminate stages).

**PR sandboxes** need the GitHub CLI (`gh`, authenticated) for the base-branch
resolution; the head commit comes from `refs/pull/<n>/head` (GitHub synthesizes it
for fork and draft PRs too, and it persists after merge). A PR of a repo with a
local checkout (the current repo or any library-known one) is cut from it and
reuses its cached baselines; otherwise the repo is **mirrored** as a bare clone
into the mirror cache root (`~/.cache/pi-chhound/repos/<owner>/<repo>`,
`CHHOUND_MIRROR_ROOT` / `settings.mirrorRoot` to override) — that mirror then
hosts the baseline for every later PR of the same repo. The only writes into the
host repo are routine fetches (`FETCH_HEAD`, remote-tracking refs); nothing is
pushed and no branch is created.

### /ch-mcp

Dynamically connects pi to a worktree's chunkhound index over MCP — no pre-registered
servers needed. With no argument it opens an interactive picker of all worktrees.
`--prefix` namespaces the exposed tools, `--read-only` restricts them,
`--no-daemon` attaches to an already-running chunkhound daemon.

**Auto-reconnect.** Connections are recorded in the session log (`pi.appendEntry`,
same mechanism as the notebook plugin's pages). When a session starts — resume,
restart, or `/reload` — the recorded connections are restored automatically and
the `chh_*` tools come back without a manual `/ch-mcp`; when a session ends, the
connections close and the chunkhound daemon stops itself (its designed behavior
once the last client detaches). Records are branch-scoped like notebook pages:
a resumed session sees exactly the connections it had. `--disconnect` forgets a
connection (a tombstone record is appended). Read-only and `--no-daemon`
connections are never recorded (single-process stdio — two of them on one
database would clash on the file lock); API keys never enter the log. Toggle the
auto-restore via `/ch-setup --auto-reconnect on|off` (default on).

**Footer indicator.** Live dynamic connections show in pi's footer as
`🔌 ch-mcp: N connected` (the separate `🔌 MCP: …` segment is pi-mcp-adapter's,
for `mcp.json` servers) and disappear when nothing is connected. If a worktree's
daemon dies (crash/kill), the connection drops out of the footer and `/ch-status`
immediately; the session log still records it as connected, so the next
session's auto-restore retries it — a crash recovers automatically, while an
explicit `--disconnect` does not.

### /ch-status

Shows chunkhound's version, worktree/baseline library roots, embedding and LLM
config, API-key status, every worktree (alive?, repo/branch, base commit, index
size, claimed index root), every baseline (shown as `<repo>/<ref> @ <commit>`), and
live MCP connections. PR sandboxes show as `add/pull/29 · head recovery/pr27-pr-b @ 0c645ce`.
`--prune` removes storage for gone worktrees and
garbage baselines (incomplete from a crashed prime, source repo deleted, or a
superseded duplicate). The same baseline GC also runs automatically after each
baseline prime — the cache is self-healing, no manual cleanup needed.

### /ch-setup

Interactive wizard in the TUI (defaults prefill the fields, TAB skips already
answered questions) or fully flag-driven: `--provider --model --rerank-model
--output-dims --llm-provider --llm-model --llm-api-key --baseline-ref
--baseline-max-age --sandbox-root --api-key --auto-reconnect --verify --project
--reset`.
`--config <file>` adopts an existing `chunkhound.json`; `--sandbox-root` sets the
worktree library root for `/chworktree` (`--worktree-base` is a legacy alias).

## Where things live

```
~/.cache/pi-chhound/bases/<repo>-<hash>/<ref>/           # baselines (per repo + base ref)
~/.cache/pi-chhound/repos/github.com/<owner>/<repo>/     # bare mirrors (PR host repos when no local checkout exists)
~/.local/state/pi-chhound/sandboxes/<repo>-<branch>-<hash>/  # sandbox dir (project dir =
                                                          #   indexed root): config +
                                                          #   worktree checkout + .chunkhound/
~/.local/state/pi-chhound/sandboxes/.state/<name>/        # operational state, OUTSIDE the
                                                          #   indexed root: index db (+ claim
                                                          #   sidecar/wal) + meta.json
```

- Both roots overridable via `CHHOUND_BASE_ROOT` / `CHHOUND_SANDBOX_ROOT` / `CHHOUND_MIRROR_ROOT` env or settings.
- Settings: global `~/.pi/agent/pi-chhound/settings.json`, project
  `<repo>/.pi/pi-chhound/settings.json` (project shadows global). Versioned JSON.

## Security

- The embedding API key is stored in `settings.json` and in every materialized
  `.chunkhound.json` (sandbox + baseline) — files are chmod 0600 and never inside a
  git repo. Prefer env-only: export `CHUNKHOUND_EMBEDDING__API_KEY` and skip the key
  in `/ch-setup` — materialized configs then carry no key.
- Slash-command arguments never reach the LLM (command dispatch happens before any
  message is built; nothing is written to session files).

## Completion UX (no pi patches)

All completion UX is plugin-side and works on a **pristine pi install** — nothing
under the global pi installation is ever modified:

- Natural typing after `/chworktree ` shows the directory picker (dirs only,
  trailing `/`, drill-down), then the branch picker (leading with a
  **new-branch** item), flags, `--config` files, `--from`/`-b` refs.
- `TAB` accepts a completion and re-opens the picker for the next slot;
  `--flag=value` equals forms, quoted paths with spaces, and `--` separators are
  all handled. `TAB` after the command name (no space) completes the command itself.
- In the wizard's path prompts, ↑/↓ move a wrapping selection, TAB fills the field,
  Enter submits the selected item (or the typed value), Esc cancels.
- Note: `Enter` on a `/`-prefixed completion may submit the prompt (pi behavior) —
  use `TAB` to accept a completion instead.

## Development

```
npm install
npm run typecheck          # tsc --noEmit
npm run smoke              # end-to-end mechanics test (real chunkhound CLI, --no-embeddings)
npm run verify:completions # completion behavior against pristine pi-tui's public provider API
```

Typecheck requires the matching `@earendil-works/pi-coding-agent` types; the smoke
and completion suites are headless and need no terminal.
