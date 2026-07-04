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

### [x] Task B — Route all board I/O through the single board root (DRAFT-16)

- **Deps:** A. **The heart of the live layer.**
- **Do:** make every board read/write — MCP (`src/mcp/handlers.ts`, `BacklogParser`/`BacklogWriter`)
  and extension host (`src/providers/TasksController.ts` create/edit/drag/reorder) — target
  `resolveBoardRoot()` instead of the worktree-local `backlog/`. Surgical atomic writes
  (write-temp-then-rename). **Subsumes** the old TASK-44 (UI-write gap) and TASK-34 (concurrent-write
  race): one physical board ⇒ nothing to bypass, nothing to race.
- **Accept:** a write from a `.worktrees/<branch>` worktree is immediately visible in the primary
  (integration test, two worktrees, no materialize); TasksController create/edit/drag survive (no
  rollback); a board write leaves every code tree's `git status` clean.
- **Handoff Notes:** Two independent fixes were needed, not one — `resolveBoardRoot()` (Task A)
  alone wasn't enough because the extension-host side gates on "does this folder have a local
  `backlog/` dir at all," which is false by construction in a fresh `.worktrees/<branch>` (git-ignored,
  never copied by `git worktree add`).
  **MCP side:** `src/mcp/server.ts` `main()` now computes `backlogPath` via a new
  `resolveWorkspaceBacklogRoot(root)` (added to `src/core/boardRoot.ts`, extending Task A's file)
  instead of `resolveBacklogDirectory(root)`; `deps.root` is untouched (stays worktree-local — it's
  session identity for `.taskwright/active-task.json` and merge-queue lookups, a different concern
  from the board path). Every MCP handler already consumed `deps.parser`/`deps.backlogPath` uniformly
  (confirmed via a full inventory pass), so this one call site fixes all of them — no handler-level
  changes needed. Left `makePrimaryBoard`/`gitFacts()` in `handlers.ts` (used only by
  `requestMergeHandler`) alone: it already resolves the real primary root via a _different_ but
  independently-correct mechanism (`git rev-parse --git-common-dir`), and touching the merge-queue
  path was out of scope.
  **Extension-host side:** the real fix is one level up from `BacklogParser`/`TasksController` (which
  already correctly target whatever `backlogPath` their injected parser has — no code in either needed
  to change). `BacklogWorkspaceManager.discover()`/`initialize()` are now `async` and call
  `resolveWorkspaceBacklogRoot(folder.uri.fsPath)` per workspace folder instead of
  `resolveBacklogDirectory(folder.uri.fsPath)` — this is the single choke point every provider's parser
  flows through (`extension.ts` `activate()`/`switchActiveBacklog`), so fixing it here means
  `switchActiveBacklog` needed **no changes at all**, it already just forwards `root.backlogPath`.
  `extension.ts`'s `activate()` is now `async` (VS Code supports this) to `await manager.initialize()`;
  `startWatching()`'s folder-change handler is now `async` too (tests capture and `await` it directly;
  VS Code itself still treats it as fire-and-forget, matching this codebase's existing tolerance for
  eventual-consistency background rescans like `syncMergeConfig`/`publishSyncConfig`).
  **`resolveWorkspaceBacklogRoot` design:** tries the primary via git first (`resolvePrimaryWorktreeRoot`,
  a new raw-path sibling to Task A's `boardRootFromPorcelain`/`resolveBoardRoot`, which now build on it —
  behavior-preserving refactor, same tests), then calls `resolveBacklogDirectory(primaryRoot)` for full
  fidelity (custom `backlog_directory` naming, `.backlog` fallback) rather than hardcoding `'backlog'`;
  falls back to local `resolveBacklogDirectory(workspaceFolderPath)` when git is unavailable or the
  primary itself has no backlog dir — so a plain non-git folder with a manually created `backlog/` still
  works. Covered by 8 new unit tests + `BacklogWorkspaceManager.test.ts` updated to mock this function
  (was mocking `resolveBacklogDirectory` directly) with all `discover()`/`initialize()` calls now
  `await`ed (21 tests, all updated).
  **Atomic writes:** added `atomicWriteFileSync()` (`src/core/atomicWrite.ts`, write-temp-then-rename,
  PID+random temp suffix so concurrent writers to the same destination never clobber each other's
  in-flight temp file — the final rename is still last-writer-wins, which is accepted; claims guard
  same-task concurrent edits, not this helper). Applied to all 12 content-rewrite `fs.writeFileSync`
  call sites in `BacklogWriter.ts` (tasks, milestones, docs, decisions) plus the four sibling
  "surgical" services that share its read-transform-write pattern: `ClaimService.ts`, `PlanService.ts`,
  `TreeFieldService.ts`, `milestoneReleaseChecklist.ts`. Deliberately did **not** touch the one
  `wx`-flagged exclusive-create write in `BacklogWriter.allocateAndWrite` (Task 0's ID-collision guard —
  converting it to write-temp-then-rename would silently overwrite via rename instead of failing
  `EEXIST` on an exact-filename collision, defeating that guard) or anything in `boardSyncEngine.ts`
  (dead code path with sync off, wholesale deletion is Task C).
  **Test fallout from the atomic-write change:** unit tests across `ClaimService.test.ts`,
  `PlanService.test.ts`, `TreeFieldService.test.ts`, and `mcpHandlers.test.ts` mock `fs.writeFileSync`
  as a no-op but didn't mock `fs.renameSync` — the real `renameSync` then threw `ENOENT` looking for a
  temp file that was never actually written to disk. Fixed by adding `renameSync: vi.fn()` to each
  file's `vi.mock('fs', ...)` block. Separately, two `BacklogWriter.test.ts` assertions
  (`createMilestone`) asserted `fs.writeFileSync` was called with the **exact final path** as arg 1 —
  broken because that arg is now the temp path. Fixed by splitting the assertion: content is still
  checked via the `writeFileSync` call, and the exact destination is now asserted via
  `expect(fs.renameSync).toHaveBeenCalledWith(expect.any(String), <exact path>)`. The other ~90
  `BacklogWriter.test.ts` assertions only read `mock.calls[0][1]` (content, not path) and needed no
  changes.
  **Two-worktree integration test:** added `src/test/unit/boardRootIntegration.test.ts` — a real git
  repo + real `git worktree add` linked worktree with **no local `backlog/` dir at all** (mirrors
  production exactly); resolves the board root from the worktree's cwd, writes through it, then
  independently re-resolves from the primary's cwd with a fresh, uncached `BacklogParser` and confirms
  the write is visible — directly exercises this task's first Accept bullet.
  **Scope note (matches Task 0's precedent):** `taskwright.init`'s "does a backlog already exist"
  check and `initializeBacklog()` still resolve against the literal opened folder, not the primary —
  initializing a _new_ board from a linked worktree is a pre-existing, separate gap (not board I/O for
  an existing board) and wasn't touched. Full suite (1527 tests), lint, typecheck, and `bun run build`
  (including the standalone `dist/mcp/server.js` worktrees actually run) all green.

### [x] Task D — Board-ref snapshot/materialize against the single board root (DRAFT-19)

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
- **Handoff Notes:** Added `snapshotBoardRoot()` / `materializeToBoardRoot()` to `src/core/boardRef.ts`
  (extending the file in place, per the task's "repurpose boardRef.ts" framing — no new module) as thin
  root-resolving wrappers: each takes a `cwd` (any worktree) instead of a `repoRoot`, resolves the
  primary via `resolvePrimaryWorktreeRoot()` (Task A/B's `boardRoot.ts`, imported into `boardRef.ts` —
  no cycle, `boardRoot.ts` has no reverse dependency), then delegates to the existing
  `snapshotBoardToRef`/`materializeRefToWorktree` unchanged — the git plumbing itself needed **zero**
  changes, confirming the design's framing that this is a resolution wrapper, not new plumbing.
  `indexFile` is optional on both wrappers, defaulting to `<resolvedPrimaryRoot>/.taskwright/board.index`
  when omitted — future callers (Task F's `push_board`/`pull_board`) won't need to resolve the primary
  themselves just to pick an index-file path, but tests still override it explicitly for isolation,
  matching the existing `backlogDir` optionality convention already in this file.
  **Milestones:** `BOARD_SUBDIRS` now includes `'milestones'` (was
  `['tasks','drafts','completed','archive']`) — `existingBoardPaths`/`listLocalBoardFiles`/the
  materialize non-board-path guard all derive from this constant already, so no other code in
  `boardRef.ts` needed to change; only the two doc-comments spelling out the four dirs literally
  were updated for accuracy. Verified round-trip (add/edit/prune) for a milestones file alongside
  tasks in the existing `snapshotBoardToRef`/`materializeRefToWorktree`/`boardRef round-trip` describe
  blocks (extended their shared fixtures rather than duplicating scenarios in new tests), plus a new
  describe block exercising the two new wrappers end-to-end against a real primary + linked
  `.worktrees/<branch>` worktree with **no local `backlog/` at all** (same fixture shape as Task B's
  `boardRootIntegration.test.ts`) — snapshot/materialize invoked with `cwd: worktreePath` correctly
  resolve and touch only the **primary's** `backlog/`, never attempt a (nonexistent) worktree-local one,
  and the non-board-path refusal guard still fires through the wrapper.
  **Scope note (matches Task 0/B's precedent):** `boardMigration.ts` has its own separate
  `SUBDIRS = ['tasks','drafts','completed','archive']` constant (for the `.gitignore` fenced block +
  `rm --cached` migration) that does **not** yet include `milestones` — this repo's own
  `backlog/milestones/*.md` files are in fact still git-tracked today (confirmed via `git ls-files`),
  so real milestones-as-board-ref round-tripping needs that migration too. Deliberately left untouched:
  Task D's explicit "Do" bullets only cover `boardRef.ts`'s `BOARD_SUBDIRS` (the snapshot/materialize
  _primitive's_ path list) and the wrappers; ignoring/untracking `backlog/milestones/` on code branches
  is Task I's territory ("repurposed `enableSync` migration... idempotently ensure the gitignore
  block"). Flagging here so Task I doesn't miss it. No fetch/push/merge added (Task F) and no live poll
  (Task C removes the old one) — matches the task's explicit non-goals.
  Full suite (1530 tests)/lint/typecheck/`bun run build` all green.

### [x] Task C — Retire live CAS/poll/materialize machinery + local-only cross-branch (DRAFT-17)

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
- **Handoff Notes:** Deleted wholesale: `src/core/boardSyncEngine.ts` (392 lines — the whole CAS loop:
  `applyBoardWriteSynced`/`claimTaskSynced`/`releaseTaskSynced`/`setStatusSynced`/`refreshBoard`/the
  `board.materialized` marker helpers), `src/providers/BoardSyncController.ts` (poll timer +
  compaction-poll trigger — nothing salvaged; Task G rebuilds a status bar from scratch against the
  push/pull backbone, not this), `src/core/CrossBranchTaskLoader.ts` (its only caller was
  `getTasksWithCrossBranch`, now inlined to `getTasks()`), and `scripts/setup-cross-branch-demo.sh` +
  its test (the demo workspace's entire premise — showing cross-branch merge behavior — is gone). Their
  four test files went with them (`boardSyncEngine.test.ts`, `BoardSyncController.test.ts`,
  `CrossBranchTaskLoader.test.ts`, `CrossBranchDemoSetupScript.test.ts`).
  **`SyncTarget` relocation:** `boardLifecycle.ts`'s `reconcileBoardRef` still needs the `SyncTarget`
  shape (repoRoot/ref/remote/indexFile/backlogDir) after `boardSyncEngine.ts` — its original home — is
  gone. Moved the interface to `boardRef.ts` (the "reused" git-plumbing module per the design spec) as a
  plain data shape; no new plumbing.
  **`boardLifecycle.ts` kept, trimmed:** `reconcileBoardRef` survives — its only remaining caller is
  `extension.ts`'s `runEnableSync` (`taskwright.enableSync` command), which is a **one-shot**,
  user-triggered heal/seed, not the live/poll usage this task's "Do" bullet targets (that was
  `BoardSyncController.start()`, deleted with the controller). Task I's own plan already intends to
  repoint `runEnableSync`'s ref-seeding to `snapshotBoardRoot` — touching it further here would be scope
  creep into Task I's territory, so it's untouched. `compactBoardRef` + `DEFAULT_COMPACT_THRESHOLD` **are**
  deleted — their only caller was the poll controller's `tick()`, and squashing was explicitly named in
  this task's scope ("compaction poll"); `LifecycleDeps`/`defaultLifecycleDeps` lost the three
  fields/deps (`revCount`/`commitTreeRoot`/`pushForceWithLease`) that existed solely to support it. The
  underlying git primitives (`revCount`/`commitTreeRoot`/`pushRefForceWithLease` in `boardRef.ts`) were
  left alone — they're generic, currently uncalled but harmless, and Task H's compaction-adjacent needs
  (if any) can reuse them later.
  **`BacklogParser.getTasksWithCrossBranch`:** collapsed to a one-line `return this.getTasks()` (kept as
  a distinct method, not inlined at call sites, so existing callers — `TaskDetailProvider`,
  `TaskPreviewViewProvider`, `TasksController` — are unaffected). Deleted the now-dead
  `resolveSyncConfigMode` private helper and its imports (`GitBranchService`, `readSyncConfig`,
  `syncConfigPath`, `DEFAULT_SYNC_CONFIG`, `nodeQueueFs`, `CrossBranchTaskLoader`) — none had another
  caller in this file.
  **`mcp/handlers.ts`:** removed the whole sync import block, `McpHandlerDeps`'s four sync-injection
  fields (`claimSynced`/`releaseSynced`/`syncConfigForRoot`/`boardWriteSynced`), `makeSyncedBoard`,
  `resolveSyncConfig`/`syncTargetFor`/`withSyncedBoardWrite`. `claimTaskHandler`/`releaseTaskHandler`
  now go straight to `deps.claimService` (the code that already lived in each handler's `else` branch).
  The ten `withSyncedBoardWrite(deps, message, apply)` wrapper calls (`attach_plan`, `create_task`,
  `complete_task`, `archive_task`, `restore_task`, `promote_draft`, `promote_drafts`, `demote_task`,
  `edit_task`, `create_subtask`) unwrap to their bare `apply()` bodies inlined directly in each handler.
  `requestMergeHandler`'s board selection collapses to `deps.board ?? makePrimaryBoard(facts.primaryRoot, exec)`
  unconditionally — the `syncCfg.mode !== 'off' ? makeSyncedBoard(...) : ...` ternary is gone.
  `readSyncConfig`/`syncConfigPath`/`DEFAULT_SYNC_CONFIG`/`SyncConfig` (from `syncConfig.ts`, which Task I
  still repurposes) had no remaining consumer in this file once `resolveSyncConfig` was deleted, so that
  import is gone too — `syncConfig.ts` itself is untouched.
  **`claimActions.ts`:** removed `resolveSyncTarget` and the `if (syncTarget)` branches in
  `claimTaskForCurrentUser`/`releaseTaskClaim` — both now go straight to the `ClaimService` path that
  already existed below. `GitBranchService`/`getCommonDir` are still imported/used by the surviving
  `currentBranch()` helper; only the sync-specific usage was removed.
  **TASK-35 root cause (blank Tree tab), found and fixed — not just "subsumed" by accident:** making
  `getTasksWithCrossBranch()` local-only doesn't by itself fix the blank Tree tab, because
  `TasksController.refresh()` has its **own** gate: `if (config.check_active_branches) { this.dataSourceMode
= 'cross-branch'; }` (now deleted), and while in that mode it **skips `loadTreeBoardFromParser`
  entirely** (`treeBoard` stays `undefined`) — that skip, not which parser method got called, is what
  actually blanked the Tree tab. Removing the config-driven activation in `TasksController.ts` fixes it at
  the source. The **second**, independent trigger of the same `dataSourceMode` field was
  `extension.ts`'s `checkCrossBranchConfig()`, called on activation and `switchActiveBacklog`, which did
  `tasksHosts.forEach((host) => host.setDataSourceMode('cross-branch'))` **and** showed a status bar
  reading "Backlog: Cross-Branch — Viewing tasks across all branches" — both had to go too, or the second
  path would silently re-trigger the exact same bug through the `TasksBoardSurface.setDataSourceMode` API
  instead of the config check. `checkCrossBranchConfig` now only logs a heads-up that the setting is inert
  (signature dropped `context`/`tasksHosts`, no longer needed); the now-permanently-unassigned
  `crossBranchStatusBarItem` global and its `deactivate()` dispose branch were removed outright (unlike
  the `boardRef.ts` primitives above, this one had no future reuse case — it only ever meant "cross-branch
  mode," which no longer exists). `setDataSourceMode`/`DataSourceMode`/`TasksBoardSurface` themselves are
  untouched (still real, harmless-if-unused API surface) — only the two call sites that drove them off
  `check_active_branches` are gone.
  **Left alone (adjacent, out of scope):** the `off`/`local`/`github` mode trichotomy in `syncConfig.ts`
  (Task I's territory); `BacklogCli.ts`'s CLI-availability status bar helpers (a different, pre-existing
  concept — external `backlog` binary detection, not board-sync — already had zero production callers for
  `showCrossbranchWarning` before this task); the `boardRef.test.ts` isolated-index primitive tests
  (unrelated, still exercise reused plumbing).
  **Tests:** added a `BacklogParser.test.ts` regression asserting `getTasksWithCrossBranch()` returns
  exactly `getTasks()` even with `check_active_branches: true`; added two TASK-35 regressions
  (`TasksController.test.ts`: tree layout still derives with `check_active_branches: true`;
  `TasksController.test.ts` + `TasksViewProvider.test.ts`: local-only loader stays selected). Deleted the
  `compactBoardRef` describe block from `boardLifecycle.test.ts`, the `makeSyncedBoard` describe block
  from `mcpMergeHandlers.test.ts`, the `synced claim routing` describe block from `mcpHandlers.test.ts`,
  and the two `synced-board write routing (TASK-28)` / `synced-board create -> claim race (TASK-28
integration)` describe blocks from `mcpWriteHandlers.test.ts` (plus a stale comment there that named
  `withSyncedBoardWrite` by name as the reason a regression test calls the writer directly — fixed to
  describe the real reason without referencing the deleted symbol). Full suite (1454 tests — down from
  1530 as expected, this is a removal PR), lint, typecheck, and `bun run build` all green.

### [x] Task E — Union-merge core (DRAFT-18)

- **Deps:** D.
- **Do:** pure `mergeBoards(base?, ours, theirs) → { merged, conflicts }` operating on in-memory
  file maps (unit-tested, no git). Rules: file on one side → keep; edited one side → keep; edited
  **both** → newer frontmatter `updated_date` wins + record conflict id; tie/unparseable → keep
  "theirs" + conflict; delete-vs-edit → keep the edit + conflict. Deterministic (no `Date.now()`).
- **Accept:** add/add, edit-one-side, edit-both (newer wins), tie, delete-vs-edit each unit-tested;
  conflict ids returned, not swallowed.
- **Handoff Notes:** Added `src/core/boardMerge.ts` — a fully pure module (no git, no fs, no
  `Date.now()`) operating on `BoardFileMap = Record<string, string>` (board-relative path → file
  content), the same shape `boardRef.ts`'s snapshot/materialize produce, so Task F can pass its
  file maps straight through with no adapter. Implemented as a per-path three-way classification
  rather than a literal transcription of the five bullet rules, because the rules as written don't
  fully specify every base/ours/theirs combination (e.g. "edited both" when `base` is `undefined`
  entirely — no prior version to diff against) — the classification below is a strict superset that
  reduces to the stated rules wherever they're unambiguous:
  for each path in `base ∪ ours ∪ theirs`: absent on both live sides → drop (covers delete-vs-delete,
  not explicitly required by Accept but included for completeness); identical content on both live
  sides → keep it, no conflict (covers the "add/add of different tasks... unions cleanly" case
  trivially, since two _different_ tasks never collide on the same path in the first place — same-path
  identical content only arises from a no-op double-materialize); present on exactly one live side →
  if no base or the missing side's last-known content differs from base, that's an edit surviving a
  deletion (**delete-vs-edit**, conflict, keep the edit) — if it equals base, the deletion is clean
  (no conflict); present on both live sides with different content → if one side still matches `base`
  exactly, take the other side's edit (**edit-one-side**, no conflict) — otherwise both sides diverged
  from base (or there was no base at all, i.e. two independent adds of the _same_ path with different
  content) and `resolveByUpdatedDate()` decides: parses each side's frontmatter `updated_date` via a
  targeted regex (not a full YAML parse — an unrelated unquoted `@`-prefixed `assignee` can make
  `yaml.load` throw on an otherwise-fine document, and this core only ever needs one field), later
  timestamp wins (**edited-both**), equal timestamps or either side unparseable both fall back to
  "theirs" (**tie** / **unparseable** respectively) — both are always conflict-recorded, never silently
  resolved. `MergeConflict.id` reuses the exact filename-id convention `BacklogParser` already uses
  (`/^([a-zA-Z]+-\d+(?:\.\d+)*)/i` against the basename, uppercased, falling back to the full
  filename) so conflict ids read as real task/draft ids (`TASK-1`, `DRAFT-7`) — duplicated inline
  rather than imported, since `BacklogParser.ts` doesn't export it standalone and this module is
  meant to stay dependency-free.
  **13 unit tests** in `src/test/unit/boardMerge.test.ts` cover: disjoint add/add (union, no
  conflict), edit-one-side in both directions, edited-both with newer-wins in both directions, tie,
  unparseable/missing `updated_date`, delete-vs-edit in both directions, a clean delete (other side
  unchanged from base, no conflict), delete-both (dropped, no conflict), identical content with no
  base at all (no conflict), and conflict-id derivation for a non-`TASK-` prefix (`DRAFT-7`). Full
  suite (1467 tests, up from 1454 — this task only adds, nothing removed), lint, typecheck, and
  `bun run build` all green.

### [x] Task I — Config remap (`off | git`) + repurposed `enableSync` migration (DRAFT-21)

- **Deps:** B, D.
- **Do:** replace `taskwright.sync.mode` trichotomy with `off` (local git-ignored files, no
  versioning) | `git` (versioning on). Migrate on read: `local → off`, `github → git`. Add
  `taskwright.sync.remote` (default `origin`), `taskwright.sync.installHooks` (opt-in, used by H).
  Repurpose `src/core/syncConfig.ts` and the `taskwright.enableSync` command to idempotently ensure
  the `boardMigration` gitignore block, remap the mode, and **seed** the `taskwright-board` ref via
  `snapshotBoardRoot` (Task D). Treat `check_active_branches` as effectively off.
- **Accept:** legacy `github` reads as `git`, `local` as `off` (unit-tested coercion); `enableSync`
  idempotent; `sync-config.json` round-trips and is MCP-readable.
- **Handoff Notes:** `src/core/syncConfig.ts`: `SyncMode` is now `'off' | 'git'`; `resolveSyncConfigFromSettings`
  gained a `coerceMode()` that remaps legacy persisted/settings values (`local → off`, `github → git`)
  as well as accepting the new values directly, so a stale `<commonDir>/taskwright/sync-config.json`
  or workspace setting from before this task migrates transparently on next read — no separate
  one-time migration step needed. `SyncConfig` dropped `pollSeconds` (dead: `BoardSyncController`'s poll
  loop, its only reader, was deleted in Task C) and gained `installHooks: boolean` (default `false`) for
  Task H to wire up later. `taskwright.sync.pollIntervalSeconds` removed from `package.json`; added
  `taskwright.sync.installHooks` (boolean, default `false`) alongside the existing `sync.ref`/`sync.remote`.
  `taskwright.sync.mode`'s manifest enum is now `["off","git"]`.
  **`enableSync` repurposed, not just remapped:** the old command asked the user to pick "GitHub
  sharing" vs "local only" (`SyncMode` had two "on" states pre-v2); v2 only has one "on" state, so the
  modal collapsed to a single "Enable" button — no more mode picker. Steps 1–2 (idempotent gitignore
  block + `rm --cached --ignore-unmatch` + commit) are unchanged. Step 3 sets `sync.mode` to `'git'`
  unconditionally and publishes the shared config as before. Step 4 (seeding the ref) is repointed from
  `boardLifecycle.ts`'s `reconcileBoardRef` (a fetch/adopt/push state machine built for the old
  always-on poll model, and which would attempt a network fetch/push against `sync.remote` — wrong for
  this step, since v2 deliberately separates "enable versioning locally" from "share it," per spec §8)
  to a direct `resolvePrimaryWorktreeRoot` + `refTip` + `snapshotBoardToRef` call: resolves the primary
  (works whether the command runs from the primary or a worktree, same as Task A/D), reads the ref's
  current tip as `parent` if it exists, then snapshots — so re-running the command chains a new commit
  onto the existing ref instead of creating a duplicate orphan root each time (idempotent in the sense
  that matters: safe to re-run, no errors, no history clobber). Deliberately does **not** push to
  `sync.remote` here — spec §8 only asks `enableSync` to "seed" the ref from the current board; pushing
  it to share is the future `push_board` action (Task F), kept as a separate explicit step so enabling
  sync never silently touches a remote or requires credentials.
  **`boardLifecycle.ts` deleted, not just orphaned:** repointing `enableSync` away from
  `reconcileBoardRef` left it with zero production callers (confirmed via a full-repo grep before
  deleting). Rather than leave dead code with Task C's "kept, trimmed" caveat now fully expired, deleted
  `src/core/boardLifecycle.ts` and its test outright. Its `SyncTarget` interface (which Task C had
  relocated into `boardRef.ts` specifically so `boardLifecycle.ts` could keep using it) also lost its
  last consumer, so it's deleted from `boardRef.ts` too — the one internal comment in `boardRef.ts` that
  named `reconcileBoardRef` as a use case for its snapshotted-listing-then-prune behavior now names
  `materializeToBoardRoot` instead (the real remaining caller with the same shape).
  **`BOARD_SUBDIRS` parity fix (flagged by Task D):** `boardMigration.ts`'s own `SUBDIRS` constant
  (separate from `boardRef.ts`'s `BOARD_SUBDIRS`, used only for the `.gitignore` block + `rm --cached`
  paths) was still `['tasks','drafts','completed','archive']` — missing `milestones`, which Task D's
  handoff notes explicitly flagged as this task's territory. Added `'milestones'`; this repo's own
  `backlog/milestones/*.md` files were confirmed still git-tracked (`git ls-files`) before this task, so
  a future `enableSync` re-run (or a fresh repo's first run) now actually untracks/ignores them too.
  **`check_active_branches`:** no code change needed — Task C already made
  `getTasksWithCrossBranch()` unconditionally local-only and removed the `dataSourceMode` gating that
  read this setting, so it was already "effectively off" structurally; this task's Do bullet is
  satisfied by that prior work, not new changes here.
  **Not touched (Task J's territory):** `CLAUDE.md`/`AGENTS.md`'s "Synced board" prose still describes
  the `off`/`local`/`github` trichotomy and the CAS engine — the runbook explicitly assigns the doc
  rewrite to Task J ("do last so docs match shipped behavior," deps C, F, I), so left as-is.
  Full suite (1463 tests — down from 1467: +6 new/updated `syncConfig.test.ts` cases, −7 deleted
  `boardLifecycle.test.ts` cases, ±1 renamed `boardMigration.test.ts`/`configDefaults.test.ts` cases),
  lint, typecheck, and `bun run build` all green.

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
- 2026-07-04 · Task B · `8184f0a` · Wired MCP server + extension host (via
  `BacklogWorkspaceManager`) through a new `resolveWorkspaceBacklogRoot()`; added
  `atomicWriteFileSync()` write-temp-then-rename and applied it across `BacklogWriter`/`ClaimService`/
  `PlanService`/`TreeFieldService`/`milestoneReleaseChecklist`; added a real two-worktree
  write-visibility integration test. Full suite (1527 tests)/lint/typecheck/build green.
- 2026-07-04 · Task D · `7a778d7` · Added `snapshotBoardRoot()`/`materializeToBoardRoot()` to
  `src/core/boardRef.ts` (root-resolving wrappers around the existing `snapshotBoardToRef`/
  `materializeRefToWorktree`, via `resolvePrimaryWorktreeRoot()`); added `milestones` to
  `BOARD_SUBDIRS` (fixes TASK-36 round-trip). Full suite (1530 tests)/lint/typecheck/build green.
- 2026-07-04 · Task C · `9455b34` · Deleted `boardSyncEngine.ts`/`BoardSyncController.ts`/
  `CrossBranchTaskLoader.ts`/the cross-branch demo script (+ their 4 test files); simplified
  `mcp/handlers.ts` claim/release/board-write to direct surgical writes (no CAS);
  `BacklogParser.getTasksWithCrossBranch` now unconditionally `getTasks()`; fixed TASK-35's actual root
  cause (`TasksController`'s config-driven `dataSourceMode` activation skipped tree derivation entirely)
  and retired the matching `extension.ts` trigger + its now-false "Cross-Branch" status bar. Full suite
  (1454 tests)/lint/typecheck/build green.
- 2026-07-04 · Task E · `f532930` · Added pure `mergeBoards(base?, ours, theirs)` union-merge
  core (`src/core/boardMerge.ts`) over in-memory `BoardFileMap`s: disjoint adds union, single-side
  edits keep the edit, both-side edits resolve by newer frontmatter `updated_date` (tie/unparseable
  → "theirs"), delete-vs-edit keeps the edit — every conflicting case records a `MergeConflict` with
  a filename-derived task/draft id. 13 new unit tests. Full suite (1467 tests)/lint/typecheck/build
  green.
- 2026-07-04 · Task I · `de76e4b` · `taskwright.sync.mode` collapsed to `off | git` with
  legacy `local → off` / `github → git` migration on read; `SyncConfig` dropped dead `pollSeconds`,
  gained `installHooks`; `enableSync` repointed its ref-seeding from `boardLifecycle`'s
  `reconcileBoardRef` to a direct `snapshotBoardToRef`/`refTip` call (idempotent, local-only — no
  remote push); deleted the now-dead `boardLifecycle.ts` + `SyncTarget`; added `milestones` to
  `boardMigration.ts`'s tracked-dirs list (Task D's flagged gap). Full suite (1463 tests)/lint/
  typecheck/build green.

---

## 5. Superseded board tasks (close when the subsuming task merges)

These older tasks are replaced by this rework. They currently live on the board and should be
**archived** (not completed — the work is superseded, not done) once the noted v2 task is merged.
**Their ids shifted during the sync incident — verify by title before archiving, not by number:**

- "Route extension-UI board writes (create/edit/drag) through sync snapshot+push" → subsumed by **Task B**
- "Rapid concurrent synced-board writes silently lose some edits" → subsumed by **Task B**
- "Tree tab silently renders empty when check_active_branches is true" → subsumed by **Task C**
- "backlog/milestones/ is missing from the sync engine's board paths" → fixed by **Task D**
