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
engine uses for PR sandboxes.

## Requirements

- Node.js >= 22.19
- pi >= 0.84.1
- the `chunkhound` CLI on `PATH` (5.x)

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

Don't use both install paths at once — the commands would register twice. Configure once with `/ch-setup` (embedding provider/model, LLM for research tools, baseline ref & max age, worktree base folder).

## Commands

| Command | Purpose |
|---|---|
| `/chworktree [repo] [branch] [-b <name>] [--from <ref>] [--dest <dir>] [--config <file>] [--no-index] [--force-reindex] [--refresh-baseline]` | Create a git worktree with its own chunkhound index. |
| `/ch-mcp [<worktree\|sandbox> [--disconnect] [--no-daemon] [--read-only] [--prefix <pfx>]]` | Connect pi to a worktree's index over MCP. |
| `/ch-status [--prune]` | List sandboxes, baselines, and live MCP connections. |
| `/ch-setup [flags]` | Configure embedding/LLM/baseline settings. |

### /chworktree — two ways to invoke

- **Wizard** — `/chworktree [repo]` with no other arguments: asks for the branch
  name (Enter = new branch `<repo>-wt`) and the destination folder (Enter = the
  repo's parent). With no argument at all it also lets you pick the repo (current
  repo, repos from the index library, or a typed path). Path prompts support TAB
  completion with ↑/↓ navigation (TAB accepts, Enter confirms, Esc cancels).
- **One-go (agents)** — everything on one line, fully non-interactive:
  `/chworktree [repo] -b <branch> --dest <dir>`. With `--dest` the folder is named
  after the branch (`<repo>-wt` when no branch is given, `-2` suffix on collision);
  without `--dest` the first positional is the worktree location itself.

In all modes, the final location must not already be part of another chunkhound
index — the wizard re-prompts, one-go aborts. Indexes live in the sandbox library,
**outside** the worktree; the repo only sees a git-excluded `.chhound/daemon.log`.
Long index runs stream live progress to the footer (`embedding · batch 3/12 · db 5.8 MB …`).

### /ch-mcp

Dynamically connects pi to a sandbox's chunkhound index over MCP — no pre-registered
servers needed. With no argument it opens an interactive picker of all sandboxes.
`--prefix` namespaces the exposed tools, `--read-only` restricts them,
`--no-daemon` attaches to an already-running chunkhound daemon.

### /ch-status

Shows chunkhound's version, sandbox/baseline roots, embedding and LLM config,
API-key status, every sandbox (worktree alive?, branch, base commit, db size,
claimed index root), every baseline, and live MCP connections. `--prune` removes
sandboxes whose worktree is gone.

### /ch-setup

Interactive wizard in the TUI (defaults prefill the fields, TAB skips already
answered questions) or fully flag-driven: `--provider --model --rerank-model
--output-dims --llm-provider --llm-model --llm-api-key --baseline-ref
--baseline-max-age --worktree-base --api-key --verify --project --reset`.
`--config <file>` adopts an existing `chunkhound.json`; `--worktree-base` sets the
default destination for `/chworktree`.

## Where things live

```
~/.cache/pi-chhound/bases/<repo>-<hash>/<ref>/           # baselines (per repo + base ref)
~/.local/state/pi-chhound/sandboxes/<repo>-<wt>-<hash>/  # one dir per worktree index
```

- Both roots overridable via `CHHOUND_BASE_ROOT` / `CHHOUND_SANDBOX_ROOT` env or settings.
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
