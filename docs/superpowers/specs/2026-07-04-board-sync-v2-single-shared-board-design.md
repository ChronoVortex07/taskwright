# Board Sync v2 — Single Shared Board (design)

**Status:** Approved (brainstorm) · **Date:** 2026-07-04

Supersedes the GitHub-synced-board CAS architecture
(`docs/superpowers/specs/2026-07-01-github-synced-board-design.md` and its phase plans).

## 1. Problem

The v1 "synced board" moved the board off code branches onto a `taskwright-board` git ref and
kept every worktree in sync with a live **CAS engine** (fetch → materialize → check → snapshot →
ff-only push, on a poll). It works in the happy path but has produced, in practice:

- **Silent rollbacks** — extension-UI writes (`TasksController` create/edit/drag/reorder) never
  routed through the CAS engine; they landed only in the git-ignored _materialized copy_ and were
  then pruned/overwritten by the next materialize (the open TASK-44, and the concurrent-write race
  TASK-34).
- **File desyncs / random staleness** — the local `taskwright-board` ref is shared across all
  worktrees while the `board.materialized` marker is per-worktree; a sibling worktree advancing the
  shared ref leaves this worktree with a stale view. Several near-miss failure modes ("mass-reverted
  the root", "stale origin/main over the repo root", "frozen marker") are guarded reactively per
  symptom in `boardRef.ts`, not by one coherent model.
- **Milestones don't round-trip** — `backlog/milestones/` was never in the sync engine's board
  paths (TASK-36).
- **Blank Tree tab** — `check_active_branches: true` still triggers a cross-branch scan even with
  sync on (TASK-35).

Root cause: the architecture keeps **N copies of the board** (one materialized copy per worktree,
plus the ref) and a **live background loop** trying to reconcile them. Every symptom above is a
reconciliation gap between copies.

The three things the feature is actually _for_:

1. **Worktree ↔ main visibility** — an agent editing the board in `.worktrees/<branch>` shows up in
   the primary checkout.
2. **Board writes never block merges** — task edits must not dirty a code tree or abort an ff-merge.
3. **Team sharing** — different people can share the board — but this is the part that caused the
   headaches and is being **re-scoped**, not kept as-is.

## 2. Approach

**Collapse the N copies to one, and make sharing discrete instead of live.** Two layers with a hard
boundary between them.

### 2.1 Live layer — one board, no copies

There is exactly **one physical board**: the **primary** worktree's `backlog/` directory. A pure
helper `resolveBoardRoot()` resolves it from any worktree via `git worktree list --porcelain` (first
entry is the primary). Every board read and write — from the MCP server _and_ the extension host,
from any worktree — targets that one directory directly.

Consequences:

- **No per-worktree materialized copy, no CAS, no poll, no `board.materialized` marker.** The entire
  reconciliation-gap class is _structurally_ impossible: there is nothing to reconcile while working.
- Worktree ↔ main visibility (req 1) is automatic — main _is_ the primary, and it holds the one board.
- The board stays **git-ignored** on every code branch (the v1 `.gitignore` + `rm --cached`
  migration is reused), so board writes never enter a code tree's index ⇒ never block a merge (req 2).
- Concurrency between agents is handled by the **existing advisory claims** + surgical, atomic file
  writes (write-temp-then-rename). Two agents editing the _same_ task is the only collision surface,
  and claims already advise against it.

### 2.2 Versioning layer — discrete, git-native

Git versioning (req 3, re-scoped) happens **only at explicit push/pull boundaries**, never in a
background loop:

- **Push board:** snapshot the one board dir into the `taskwright-board` ref (isolated-index
  plumbing, reused from v1 `boardRef.ts`), then `git push origin taskwright-board`.
- **Pull board:** fetch the ref, merge it into the local board, materialize the result into the one
  board dir.

Because sync is user-initiated and synchronous, there is no race that can silently roll a live edit
back. A divergence is resolved **once**, predictably, by a union-merge (§2.3).

Triggers (from the brainstorm): **both** — reliable explicit backbone plus opt-in automation.

- **Backbone (always available):** `push_board` / `pull_board` MCP tools, `taskwright.pushBoard` /
  `taskwright.pullBoard` VS Code commands, and a status-bar button.
- **Opt-in automation:** Windows-safe `pre-push` / `post-merge` git hooks that shell out to a
  committed, dependency-free script and call the same backbone. Installed only on explicit opt-in.

### 2.3 Conflict model — union-merge, last-writer-wins, surfaced

The board is one file per task, so divergence resolves at **file granularity**:

- File present on only one side → keep it (add/add of different tasks unions cleanly).
- File edited on only one side → keep the edit.
- File edited on **both** sides → the version with the newer frontmatter `updated_date` wins; the
  conflicted task IDs are collected and **surfaced** to the user (notification + log), never silently
  dropped. Ties / unparseable dates → keep incoming ("theirs") and surface.
- Delete-vs-edit → keep the edit and surface (a deletion never silently wins over a live edit).

`backlog/milestones/` is included in the versioned paths (fixes TASK-36).

## 3. Components

| Unit                        | Responsibility                                                                              | Purity                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| `resolveBoardRoot()`        | Primary worktree's `backlog/` from `git worktree list --porcelain`                          | pure (git output → path)                                            |
| board I/O routing           | MCP handlers + `BacklogParser`/`BacklogWriter` + `TasksController` target the resolved root | wiring                                                              |
| `boardRef.ts` (reused)      | snapshot / materialize / fetch / push primitives + non-board-path guard                     | git plumbing                                                        |
| union-merge core            | merge two board trees by task file; return merged tree + conflict list                      | pure                                                                |
| `push_board` / `pull_board` | snapshot→(fetch+merge)→push · fetch→merge→materialize; surface conflicts                    | wiring                                                              |
| push/pull UX                | commands + status-bar button (state, last-sync, conflict count)                             | UI                                                                  |
| hooks installer             | committed dependency-free hook script + opt-in installer                                    | wiring                                                              |
| config + migration          | `sync.mode` remap (`off                                                                     | git`) + repurposed `enableSync` (reuse gitignore/untrack; seed ref) | wiring |

## 4. What is removed vs reused

**Removed:** `boardSyncEngine.ts` CAS loop; `BoardSyncController` poll timer; `board.materialized`
marker; `applyBoardWriteSynced` / `withSyncedBoardWrite` gating in `src/mcp/handlers.ts`;
`claimTaskSynced` / `releaseTaskSynced` (claims become direct surgical writes to the one board);
`boardLifecycle` live reconcile/poll usage; the `off` / `local` / `github` mode trichotomy.

**Reused:** `boardRef.ts` isolated-index primitives (incl. the "refuse non-board-path ref" guard and
byte-exact `core.autocrlf=false` / `core.eol=lf`); `boardMigration.ts` (gitignore block + `rm
--cached`); `syncConfig.ts` (repurposed to the new mode set); the existing advisory-claim writers.

## 5. Config surface

`taskwright.sync.mode`: `off` (board is local git-ignored working files, no versioning) | `git`
(versioning layer on: push/pull enabled, commands + optional hooks). `taskwright.sync.remote`
(default `origin`). `taskwright.sync.installHooks` (opt-in). Existing `local`/`github` settings
migrate: `local` → `off`, `github` → `git`. `check_active_branches` is treated as effectively off in
the single-board model (nothing to cross-scan) — fixes the blank Tree tab (TASK-35).

## 6. Testing

- **Unit (pure cores):** `resolveBoardRoot()` (primary from porcelain, worktree vs. primary,
  detached), union-merge (add/add, edit/edit newer-wins, delete/edit, tie, conflict list),
  snapshot/materialize round-trip incl. milestones, config remap/migration.
- **Integration (real temp git repo):** two-worktree write-visibility (agent write in worktree seen
  in primary with no materialize step), push→pull round-trip across two clones, union-merge across a
  real divergence, migration idempotence.
- **Windows note:** the ~22 upstream POSIX-path unit tests still fail on Windows by design; the hook
  script must be exercised for CRLF-safety (byte-exact blobs) explicitly.

## 7. Non-goals / boundaries

- **No live sync.** Sharing is only as fresh as the last explicit (or hooked) push/pull.
- **No automatic conflict _resolution_ beyond last-writer-wins.** Same-task concurrent edits surface;
  the human reconciles if the automatic pick is wrong.
- **Not a general multi-user real-time board.** Team sharing is git-native and asynchronous by design.

## 8. Migration for this repo

The v1 migration already ran (`.gitignore` block present, board untracked). v2 keeps the board
git-ignored, so no new untrack is needed; the `enableSync` command is repurposed to (idempotently)
ensure the gitignore block, remap the mode, and seed the `taskwright-board` ref from the current
board. The four v1 open tasks (TASK-34, TASK-35, TASK-36, TASK-44) are superseded by this rework.
