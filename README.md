# pi-chhound

ChunkHound worktree, setup, and status commands for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Wraps the `chunkhound` CLI/datastore: every git worktree gets its own index, spun up
by low-level copy of a per-repo **baseline** index (the mainline branch, regularly
refreshed) plus an incremental **top-up** at the worktree's branch point — the same
mechanics the CURe engine uses for PR sandboxes.

## Commands

| Command | Purpose |
|---|---|
| `/chworktree <path> [branch] [-b <new-branch>] [--from <commit-ish>] [--no-index] [--config <file>] [--force-reindex] [--refresh-baseline]` | Create a git worktree with its own chunkhound index (baseline copy + top-up), streamed live to the session. |
| `/ch-setup [--config <chunkhound.json>] [--provider P] [--model M] [--rerank-model R] [--baseline-ref <ref>] [--baseline-max-age <days>] [--api-key <key>] [--verify] [--project] [--reset]` | Configure pi-chhound. Interactive wizard in the TUI; flag-driven headlessly. |
| `/ch-status [--prune]` | List the sandbox library and baselines; prune sandboxes whose worktree is gone. |

## Layout

```
~/.cache/pi-chhound/bases/<repo>-<hash>/<ref>/     # baselines (per repo + base ref)
    chhound.json  db/.chhound.db/  meta.json
~/.local/state/pi-chhound/sandboxes/<repo>-<wt>-<hash>/   # one dir per worktree index
    chhound.json  .chhound.db/  meta.json
```

- Both roots overridable via `CHHOUND_BASE_ROOT` / `CHHOUND_SANDBOX_ROOT` env or settings.
- Indexes live **outside** the worktree; the repo only ever sees `.chhound/daemon.log`
  (git-excluded repo-wide via `info/exclude`).
- Configs never contain secrets; the duckdb path is pinned absolute per sandbox.

## Security

- **v1 stores the embedding API key** in `settings.json` and in every materialized
  `chhound.json` (sandbox + baseline) — files are chmod 0600. Treat them as secrets;
  the sandbox/baseline dirs are not part of any git repo.
- Prefer env-only if you want the key off disk: export `CHHOUND_EMBEDDING__API_KEY`
  and skip the key in `/ch-setup` — materialized configs then carry no key.
- Slash-command args never reach the LLM (command dispatch happens before any
  message is built; nothing is written to session files).

## Settings

Versioned JSON, project shadows global:
- global: `~/.pi/agent/pi-chhound/settings.json`
- project: `<repo>/.pi/pi-chhound/settings.json`

## Development

```
npm install
npm run typecheck          # tsc --noEmit
npm run smoke              # end-to-end mechanics test (real chunkhound CLI, --no-embeddings)
npm run verify:completions # completion behavior against pristine pi-tui's public provider API
```

Dev install: symlink this folder into `~/.pi/agent/extensions/` (or `.pi/extensions/`)
and run `/reload` in pi. Typecheck requires the matching `@earendil-works/pi-coding-agent` types.

### Completion UX (no pi patches)

All completion UX is plugin-side and works on a **pristine pi install** — nothing
under the global pi installation is ever modified:

- Natural typing after `/chworktree ` shows the directory picker (dirs only,
  trailing `/`), then branches, flags, `--config` files, `--from`/`-b` refs.
- `TAB` accepts a completion (pi's built-in behavior — a `TAB` after the command
  name re-triggers the argument picker; commands without argument completions
  accept cleanly and submit on `Enter`).
- After a space, pi's built-in file picker is available (e.g. `/chworktree /abs`).
- `Enter` on a `/`-prefixed completion may submit the prompt (pi behavior) —
  use `TAB` to accept a completion instead.
