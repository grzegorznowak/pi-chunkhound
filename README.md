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
npm run typecheck    # tsc --noEmit
npm run smoke        # end-to-end mechanics test (real chunkhound CLI, --no-embeddings)
```

Dev install: symlink this folder into `~/.pi/agent/extensions/` (or `.pi/extensions/`)
and run `/reload` in pi. Typecheck requires the matching `@earendil-works/pi-coding-agent` types.

### pi-tui patch (recommended)

Two surgical patches to the running pi install's pi-tui so command-argument
completion feels native:
1. TAB-accepting a command name opens the argument picker immediately
   (`/chworktree` + TAB + TAB → directory tree) — but only for commands that
   define argument completions, so arg-less commands like `/reload` accept
   cleanly and submit on Enter.
2. Commands without argument completions fall through to the file picker on
   natural typing (typing a space after `/read` shows files).
3. Accepting a directory item auto-drills to its contents; Enter only submits
   for command-name completions (never for paths).
4. The picker shows a keys hint when open in command context:
   `↑/↓ move · TAB accept · Esc close`.

Apply (re-run after every pi update):

```
bash scripts/patch-pi-tui.sh
```

Then **restart pi** — the TUI is loaded at startup, `/reload` is not enough.
