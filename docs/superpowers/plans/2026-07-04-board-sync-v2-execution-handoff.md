# Board Sync v2 — Sequential Execution Handoff (relay runbook)

> **You are ONE agent in a sequential relay.** Read this whole document first.
> Find the **first unchecked task** in §3 Execution Order. Do **only that one task**
> (it is one PR-sized unit). When it's green, check its box, fill in its **Handoff
> Notes**, commit, append to §4 Progress Log, and **STOP** — the next session takes
> over from the next unchecked task. Do not batch multiple tasks in one session.
>
> **Design spec (authoritative):** [`docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md`](../specs/2026-07-04-board-sync-v2-single-shared-board-design.md)
> This runbook is the execution order; the spec is the _why_ and the detailed design. Read both.

---

## 0. READ FIRST — guardrails (do not skip; these are why the board kept eating itself)

This rework is being built **on the very board it fixes**, so the old sync bugs can corrupt your
work mid-task. The following are non-negotiable for the duration:

1. **Sync stays OFF.** `taskwright.sync.mode` is `off` (workspace `.vscode/settings.json` **and**
   `.git/taskwright/sync-config.json`). **Do not** set it to `local`/`github`. The 20-second
   `github` poll is what silently materialized stale ref state over the working copy and deleted
   ~25 tasks live. Turning it back on before v2 ships re-arms that. If the status bar shows any
   board-sync activity, stop and re-disable + reload the window.
2. **VS Code setting scope gotcha:** the **workspace** `.vscode/settings.json` value overrides the
   User-scope setting. Changing sync mode in the Settings _UI_ (User tab) will be silently
   overridden by the workspace file. Edit the workspace file to be sure.
3. **Work in the PRIMARY checkout, on branch `board-sync-v2`.** No dispatch, no `.worktrees/<branch>`.
   The worktree/dispatch flow invokes the buggy materialize-into-worktree path. `git rev-parse
--git-common-dir` must print `.git` (you're in the primary).
4. **The board is git-ignored → back it up.** `backlog/{tasks,drafts,completed,archive}` are
   git-ignored; your normal commits do **not** protect them. Before you start a task:
   `cp -r backlog "$TMP/board-backup-<stamp>"`. The committed `taskwright-board` ref is also a safety
   net (`git log taskwright-board`).
5. **Sequential MCP writes only; verify every write.** Never fire parallel `create_task`/`edit_task`
   calls — the ID allocator races and silently clobbers a file (that's Task 0). After any board
   write, **confirm it landed on disk** (`grep` the file) before trusting it — during this project a
   tool returned success while the change never persisted. Do not run parallel agent sessions against
   this repo.
6. **TDD.** Failing test first (the repo has deep Vitest coverage). Before checking a task off, run
   `bun run test && bun run lint && bun run typecheck` and confirm green. On Windows ~22 upstream
   POSIX-path unit tests fail by design — don't "fix" the code to match them; confirm they're the
   only failures.
7. **Commit per task**, message referencing the task label + draft id, e.g.
   `Board Sync v2 — Task A: resolveBoardRoot() core (DRAFT-15)`.

---

## 1. Goal

Replace the board-sync feature with a design that **cannot** silently roll back, desync, or go stale.

- **Live layer:** exactly one physical board (the primary checkout's `backlog/`), read/written
  directly by every worktree — no per-worktree copy, no CAS, no poll. Desync becomes structurally
  impossible.
- **Versioning layer:** discrete, git-native **push/pull** of a `taskwright-board` ref with a
  union-merge (last-writer-wins per task file, conflicts surfaced) — team sharing without the live
  loop that caused the headaches.
- The `github` live-CAS multi-user mode is **removed**.

## 2. Dependency graph

```
Task 0 (allocator bug) ── independent, do FIRST (safety)

A ──▶ B ──▶ C ─────────────┐
 │                          │
 └──▶ D ──▶ E ──▶ F ──▶ G   │
      │          │   └─▶ H  │
      └──▶ I ◀── B          │
           │                │
           └────▶ J ◀── C, F┘   (J needs C, F, I)
```

Legend: `X ──▶ Y` = Y depends on X (do X first).

## 3. Execution order (the relay)

> Each card: **[ ]** = not started. Fill **Handoff Notes** when you finish. `(DRAFT-NN)` is the
> current board draft; it may be promoted to a `TASK-NN` later — the **label + title** is the stable
> identity, not the id.

### [x] Task 0 — Concurrent `create_task` ID clobber (DRAFT-25) · _bug, independent, do first_

- **Deps:** none. **Why first:** it causes silent data loss on concurrent task creation; fixing it
  protects all later authoring.
- **Do:** make task/draft ID allocation atomic under concurrency. Root: `getNextTaskId` /
  `getNextDraftId` in `src/core/BacklogWriter.ts` compute `max(active)+1` from a (possibly cached)
  dir scan; concurrent creates read a stale max and collide, and the writer replaces a file sharing
  the computed `draft-N`/`TASK-N` prefix. Shared by `src/core/createTaskCore.ts` (MCP + UI).
- **Fix directions:** serialize allocate+write behind a lock/mutex, OR allocate-then-write `O_EXCL`
  with retry, OR allocate-verify-unique-retry; invalidate the parser cache between max-scan and
  write; never overwrite a task/draft file whose id differs from the one being written.
- **Accept:** a regression test fires N concurrent `create_task` calls and asserts N distinct ids and
  N files (no clobber); no create silently deletes a pre-existing task/draft.
- **Handoff Notes:** Added `BacklogWriter.allocateAndWrite()` (private helper) and routed
  `createTask`/`createDraft` through it. It's the "allocate-then-write with retry" direction: an
  exclusive lock **directory** keyed only by the numeric id (`fs.mkdirSync(lockDir)`, no
  `recursive`, throws `EEXIST` if taken — atomic at the OS level, cross-platform incl. Windows) is
  what actually prevents two different titles from landing on the same id; the real file is then
  written with `{flag: 'wx'}` as a second guard against an exact-filename collision. Either `EEXIST`
  bumps the candidate id and retries. The lock dir is removed (best-effort) after a successful real
  write; a crash mid-claim just permanently retires that one id number, which is harmless.
  **Gotcha #1 (root-cause asymmetry):** only `createDraft` actually raced — its scan
  (`getNextDraftId`) ran _before_ its one `await parser.getConfig()`, so two concurrent calls could
  both scan a stale (pre-write) directory state before either wrote. `createTask`'s await already
  happened _before_ its scan with no further await before the write, which — by JS's run-microtask-
  to-completion semantics — already made it accidentally race-free. Fixed both anyway (uniform,
  don't rely on statement-order fragility) but only `createDraft`'s regression test fails on the
  pre-fix code; the `createTask` test is defense-in-depth and passes either way. Verified this with a
  throwaway `Promise.all` script directly against `BacklogWriter` before and after.
  **Gotcha #2 (test placement):** a regression test that calls the MCP `createTaskHandler` (i.e.
  goes through `withSyncedBoardWrite` → `resolveSyncConfig` → a real `git rev-parse` subprocess per
  call) does **not** reliably reproduce the race — the subprocess latency jitter staggers the 8
  concurrent calls just enough to avoid the collision window most of the time, even on unfixed code.
  The regression tests in `src/test/unit/mcpWriteHandlers.test.ts` (new `describe` block, "DRAFT-25
  regression") call `writer.createDraft`/`writer.createTask` **directly** (with a real
  `BacklogParser`, matching what the MCP handler always passes) instead, which reproduces
  deterministically. If a future task adds a handler-level concurrency test, don't trust it alone.
  **Not touched (scope note):** `promoteDraft`/`demoteTask` (lines ~358–466) share the same
  `getNextTaskId`/`getNextDraftId` scan pattern, but their await happens before their scan with no
  further await before the (rename-based) write — same structurally-safe shape as `createTask` was.
  Left them alone to keep this PR scoped to the stated Accept criteria (`create_task` concurrency);
  flag for a follow-up bug/audit if someone wants full consistency across all four call sites.

### [x] Task A — Board-root resolution core `resolveBoardRoot()` (DRAFT-15)

- **Deps:** none. **Foundation.**
- **Do:** new pure core (`src/core/boardRoot.ts`) `resolveBoardRoot(...)` → the **primary** worktree's
  `backlog/`, parsed from `git worktree list --porcelain` (first `worktree ` entry). Handle: run from
  primary, from a `.worktrees/<branch>` worktree, and a plain non-worktree repo. Keep the git call
  thin/injectable so parsing is unit-tested against captured porcelain output (no live git in the
  unit test). Ship helper + tests only; wiring is Task B.
- **Accept:** from a worktree returns the primary's backlog path (not the worktree's); single-repo
  returns its own; cross-platform (`path.*`), tests pass on Linux/CI.
- **Handoff Notes:** Added `src/core/boardRoot.ts`, split pure-from-I/O the same way
  `scripts/taskwright-mcp.cjs`'s `resolveMainServerPath` is: `parseWorktreeListPorcelain()` extracts
  every `worktree <path>` line in order (ignores `HEAD`/`branch`/`detached`/`bare`/`prunable ...`/blank
  lines), `boardRootFromPorcelain()` is the pure `porcelain → primary backlog path` core (throws if no
  `worktree ` entry at all — should be unreachable since `git worktree list` always emits at least the
  main one), and `resolveBoardRoot(cwd, { exec })` is the thin wiring that runs `git worktree list
--porcelain` (injectable `exec`, defaulting to the same promisified-`execFile` pattern as
  `WorktreeService`/`GitBranchService`) and feeds it through. Primary is always porcelain's _first_
  `worktree` entry regardless of which worktree ran the command — verified against a real captured
  multi-worktree porcelain dump from this repo (including a stale `prunable gitdir file points to
non-existent location` trailing line) — so no cwd-based branching was needed for the three required
  cases (primary / linked `.worktrees/<branch>` / plain non-worktree repo, which all emit the same
  shape, just with one vs. more entries). Tests in `src/test/unit/boardRoot.test.ts` (10, all against
  captured porcelain text, no live git) normalize `\`→`/` before asserting (matching the existing
  `taskwrightMcpLauncher.test.ts` convention) so they pass identically on Windows and Linux/CI.
  **Scope note:** this task is helper + tests only, per the runbook — nothing calls `resolveBoardRoot()`
  yet; wiring every MCP/extension board read-write through it is Task B.

### [ ] Task B — Route all board I/O through the single board root (DRAFT-16)

- **Deps:** A. **The heart of the live layer.**
- **Do:** make every board read/write — MCP (`src/mcp/handlers.ts`, `BacklogParser`/`BacklogWriter`)
  and extension host (`src/providers/TasksController.ts` create/edit/drag/reorder) — target
  `resolveBoardRoot()` instead of the worktree-local `backlog/`. Surgical atomic writes
  (write-temp-then-rename). **Subsumes** the old TASK-44 (UI-write gap) and TASK-34 (concurrent-write
  race): one physical board ⇒ nothing to bypass, nothing to race.
- **Accept:** a write from a `.worktrees/<branch>` worktree is immediately visible in the primary
  (integration test, two worktrees, no materialize); TasksController create/edit/drag survive (no
  rollback); a board write leaves every code tree's `git status` clean.
- **Handoff Notes:** _(…)_

### [ ] Task D — Board-ref snapshot/materialize against the single board root (DRAFT-19)

- **Deps:** A. (Can run in parallel-in-time with B, but this is a **sequential relay** — just do
  whichever is the first unchecked.)
- **Do:** repurpose `src/core/boardRef.ts` isolated-index primitives to snapshot FROM / materialize
  INTO the one board root. `snapshotBoardRoot()` (git add --force, byte-exact `core.autocrlf=false`/
  `core.eol=lf`, commit onto `taskwright-board`). `materializeToBoardRoot()` (checkout-index --force;
  **keep** the "refuse non-board-path ref" guard). Add `backlog/milestones/` to `BOARD_SUBDIRS`
  (**fixes** TASK-36). No fetch/push/merge (Task F); no live poll (removed in Task C).
- **Accept:** snapshot→materialize round-trips tasks/drafts/completed/archive **and** milestones
  byte-for-byte; materialize refuses a non-board-path ref; the user's real HEAD/index/branch are
  untouched (isolated index), asserted in tests.
- **Handoff Notes:** _(…)_

### [ ] Task C — Retire live CAS/poll/materialize machinery + local-only cross-branch (DRAFT-17)

- **Deps:** B. **Removal PR — only after B routes all writes to the one board.**
- **Do:** delete `boardSyncEngine.ts` CAS loop (`applyBoardWriteSynced`, `claim/release/setStatusSynced`,
  `refreshBoard`); `BoardSyncController` poll/compaction timers (keep only what Task G's status bar
  needs, or delete); the `board.materialized` marker; `src/mcp/handlers.ts` synced-write gating
  (`withSyncedBoardWrite`/`makeSyncedBoard`/synced claim routing → claim/release become direct
  surgical writes via `ClaimService`); `boardLifecycle` live reconcile/poll usage. Make
  `BacklogParser.getTasksWithCrossBranch` local-only unconditionally (single off-branch board ⇒
  nothing to cross-scan). **Subsumes** TASK-35 (blank Tree tab).
- **Accept:** full suite green after removal (no dangling refs to deleted symbols); claim/release work
  with no CAS; Tree/Kanban/List render with `check_active_branches` true OR false, no ghost cards.
- **Handoff Notes:** _(…)_

### [ ] Task E — Union-merge core (DRAFT-18)

- **Deps:** D.
- **Do:** pure `mergeBoards(base?, ours, theirs) → { merged, conflicts }` operating on in-memory
  file maps (unit-tested, no git). Rules: file on one side → keep; edited one side → keep; edited
  **both** → newer frontmatter `updated_date` wins + record conflict id; tie/unparseable → keep
  "theirs" + conflict; delete-vs-edit → keep the edit + conflict. Deterministic (no `Date.now()`).
- **Accept:** add/add, edit-one-side, edit-both (newer wins), tie, delete-vs-edit each unit-tested;
  conflict ids returned, not swallowed.
- **Handoff Notes:** _(…)_

### [ ] Task I — Config remap (`off | git`) + repurposed `enableSync` migration (DRAFT-21)

- **Deps:** B, D.
- **Do:** replace `taskwright.sync.mode` trichotomy with `off` (local git-ignored files, no
  versioning) | `git` (versioning on). Migrate on read: `local → off`, `github → git`. Add
  `taskwright.sync.remote` (default `origin`), `taskwright.sync.installHooks` (opt-in, used by H).
  Repurpose `src/core/syncConfig.ts` and the `taskwright.enableSync` command to idempotently ensure
  the `boardMigration` gitignore block, remap the mode, and **seed** the `taskwright-board` ref via
  `snapshotBoardRoot` (Task D). Treat `check_active_branches` as effectively off.
- **Accept:** legacy `github` reads as `git`, `local` as `off` (unit-tested coercion); `enableSync`
  idempotent; `sync-config.json` round-trips and is MCP-readable.
- **Handoff Notes:** _(…)_

### [ ] Task F — Board push & pull: `push_board`/`pull_board` MCP tools + commands (DRAFT-20)

- **Deps:** D, E. **Versioning backbone.**
- **Do:** `push_board` = `snapshotBoardRoot` → fetch remote ref → `mergeBoards` (union) → commit →
  `git push --no-verify origin taskwright-board`, return conflicts. `pull_board` = fetch → union-merge
  into local → `materializeToBoardRoot`, return conflicts. Expose both as MCP tools **and** VS Code
  commands `taskwright.pushBoard`/`taskwright.pullBoard` over one shared core (agent/human parity).
  Subscription-safe (pure git + plumbing; no `claude -p`).
- **Accept:** two-clone round-trip (push A → pull B, B reflects A); concurrent disjoint adds union
  cleanly, same-task edit surfaces a conflict (newer wins); a board push never dirties/blocks a code
  merge.
- **Handoff Notes:** _(…)_

### [ ] Task G — Push/Pull board UX: status bar + command palette (DRAFT-22)

- **Deps:** F.
- **Do:** status-bar item (mode, last push/pull, conflict count; click → push/pull quick-pick);
  command-palette `taskwright.pushBoard`/`pullBoard` gated to a backlog workspace; on conflict, a
  notification listing the conflicted task ids with an open action (never silent). Lucide inline SVG,
  theme-aware, no emojis.
- **Accept:** status bar reflects mode + updates after sync; pull conflicts surfaced with ids;
  commands appear only for a backlog workspace; run the same core as the MCP tools.
- **Handoff Notes:** _(…)_

### [ ] Task H — Opt-in Windows-safe git hooks (pre-push / post-merge) (DRAFT-23)

- **Deps:** F.
- **Do:** committed, dependency-free hook script (pattern of `scripts/taskwright-mcp.cjs`) that
  resolves the primary checkout and calls the **same** push/pull core as F. `pre-push → push_board`,
  `post-merge → pull_board`. Installed **only** on opt-in (`taskwright.sync.installHooks` or a
  `taskwright.installBoardHooks` command); never auto-installed. Windows-safe: byte-exact
  (`core.autocrlf=false`/`core.eol=lf`), `--no-verify` to avoid recursion, degrade gracefully (log,
  never abort the git op). Document caveats + manual fallback.
- **Accept:** with hooks, `git push` also pushes the board ref and `git pull` materializes updates; a
  hook failure logs and does not abort/corrupt the git op; uninstall removes them cleanly.
- **Handoff Notes:** _(…)_

### [ ] Task J — Docs: rewrite CLAUDE.md/AGENTS.md sync sections + retire old specs (DRAFT-24)

- **Deps:** C, F, I. **Do last** so docs match shipped behavior.
- **Do:** rewrite the "Synced board" sections of `CLAUDE.md`/`AGENTS.md` to the v2 model (one physical
  board; no CAS/poll; discrete push/pull + union-merge; `off|git` config; opt-in hooks). Remove v1
  CAS/mode-trichotomy prose. Add a superseded-by banner to
  `docs/superpowers/specs/2026-07-01-github-synced-board-design.md` and the 2026-07-01 synced-board
  phase plans, pointing at the v2 spec.
- **Accept:** docs describe only v2, no dangling refs to `boardSyncEngine` CAS / off-local-github
  modes; v1 specs carry a superseded-by pointer; a reader can enable sync, push, and pull without
  hitting removed features.
- **Handoff Notes:** _(…)_

---

## 4. Progress log

_(Append one line per completed task: `YYYY-MM-DD · Task X · <commit sha> · <one-line outcome>`.)_

- 2026-07-04 · Task 0 · `0dbbd65` · Atomic id allocation for `createTask`/`createDraft`
  (lock-dir + `wx` write, retry on `EEXIST`); regression tests added directly against `BacklogWriter`
  in `mcpWriteHandlers.test.ts` (handler-level concurrency tests don't reliably reproduce the race —
  see Handoff Notes). Full suite/lint/typecheck green.
- 2026-07-04 · Task A · `ff2d805` · `resolveBoardRoot()` pure core added
  (`src/core/boardRoot.ts` + 10 unit tests, no wiring yet). Full suite/lint/typecheck green.

---

## 5. Superseded board tasks (close when the subsuming task merges)

These older tasks are replaced by this rework. They currently live on the board and should be
**archived** (not completed — the work is superseded, not done) once the noted v2 task is merged.
**Their ids shifted during the sync incident — verify by title before archiving, not by number:**

- "Route extension-UI board writes (create/edit/drag) through sync snapshot+push" → subsumed by **Task B**
- "Rapid concurrent synced-board writes silently lose some edits" → subsumed by **Task B**
- "Tree tab silently renders empty when check_active_branches is true" → subsumed by **Task C**
- "backlog/milestones/ is missing from the sync engine's board paths" → fixed by **Task D**
