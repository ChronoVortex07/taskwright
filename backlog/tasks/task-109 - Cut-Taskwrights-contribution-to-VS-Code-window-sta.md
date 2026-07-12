---
id: TASK-109
title: Cut Taskwright's contribution to VS Code window startup time
status: In Progress
assignee: []
created_date: '2026-07-12 06:21'
updated_date: '2026-07-12 06:51'
labels:
  - performance
  - activation
milestone: Performance & Startup Cost
dependencies: []
priority: high
category: Core Board
claimed_by: '@agent/task-109-cut-taskwright-s-contribution-to-vs-code-window-startup-time'
worktree: task-109-cut-taskwright-s-contribution-to-vs-code-window-startup-time
claimed_at: '2026-07-12 14:43'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Opening a VS Code window on a Taskwright repo is noticeably slow, and Taskwright is a measurable contributor.

Evidence from the real extension-host log (`%APPDATA%/Code/logs/.../window1/exthost/exthost.log`):

```
15:40:29.920  Extension host started
15:40:31.47   ...other eager ('*') extensions activate
15:40:32.068  ChronoVortex07.taskwright, startup: true,
              activationEvent: 'workspaceContains:**/backlog/tasks/*.md,...'
15:40:32.510  Eager extensions activated
15:40:32.941  GitHub.copilot-chat  (onStartupFinished)
```

Taskwright is the LAST eager extension to activate and it gates the `Eager extensions activated` milestone, which in turn gates every `onStartupFinished` extension behind it.

It is NOT the board data. Measured against the live 98-task board:
- `parser.getTasks()` cold: 40ms; warm (mtime cache): 2ms
- `runBoardDoctor`: 1.5ms
- `resolveBoardRoot` (git worktree list): 25ms

Two actual costs:

1. **Glob activation events.** Every entry in `package.json` `activationEvents` is a glob (`workspaceContains:**/backlog/tasks/*.md`, etc). VS Code fast-paths a plain relative path into a single file `stat`, but a glob pattern must go through the workspace SEARCH service — it walks the workspace tree before it can even decide whether to activate. That search runs on every window open.

2. **A burst of work inside `activate()`** (~440ms, the gap from activation start to the eager milestone): a 769KB bundle load plus a run of git subprocesses — `syncWorktreeGuard`, `syncPostCheckoutWarn`, `syncBoardHooks`, `syncMergeConfig` + verify doctor, `publishSyncConfig`, `resolveCommonDir`, `resolvePrimaryWorktreeRoot`, `ensureBoardWorktree`, `foldPrimaryStrays` — and, in `git-auto` mode, `runBoardAutoSync`, which performs a network fetch and push on every window open.

Goal: Taskwright should stop being an eager, search-gated startup extension, and the git/sync burst should not run on the window-open critical path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `activationEvents` no longer forces a workspace glob SEARCH on every window open: the six recursive-wildcard globs are replaced by plain-path `workspaceContains:` entries (backlog/config.yml, backlog/config.yaml, .backlog/config.yml, .backlog/config.yaml, backlog.config.yml) which VS Code resolves with a single file stat. Guarded by `src/test/unit/activationEvents.test.ts`.
- [x] #2 The git/sync burst formerly run inline in `activate()` (worktree guard, post-checkout warn, board hooks, merge-config + verify doctor, sync-config publish, git-auto bootstrap/auto-sync, board doctor) now runs through `createDeferredRunner` ~2s after activation, off the window-open critical path. Ordering inside the bootstrap is preserved (housekeeping → status bar → ensure-worktree → fold-strays → first sync).
- [x] #3 In `git-auto` mode, the activation-time `runBoardAutoSync` network fetch/push no longer runs on the window-open critical path — it is inside the deferred bootstrap.
- [x] #4 Behavior preserved: the existing unit suites (gitAutoIntegration, boardDoctor, autoSync, syncConfig) still pass — 2065 tests green.
- [ ] #5 NOT YET VERIFIED END-TO-END: the before/after exthost activation timing requires this build to be INSTALLED in the user's VS Code and the window reloaded. Baseline is recorded (Taskwright last eager extension, activating 2.1s after exthost start and gating the `Eager extensions activated` milestone). The after-measurement is the reporter's to take on the rebuilt/installed extension.
- [x] #6 `bun run test`, `bun run lint`, `bun run typecheck` pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## File Structure

- `package.json` — `activationEvents` (drop/replace the `**/` globs; keep a fast non-glob stat path).
- `src/extension.ts` — `activate()`: move the git/sync burst (`syncWorktreeGuard`, `syncPostCheckoutWarn`, `syncBoardHooks`, `syncMergeConfig` + `runVerifyDoctorCheck`, `publishSyncConfig`, the git-auto bootstrap IIFE with `ensureBoardWorktree` / `foldPrimaryStrays` / `runBoardAutoSync`, and the activation `runBoardDoctorFlow`) off the critical path.
- `src/test/unit/gitAutoIntegration.test.ts`, `boardDoctor.test.ts`, `autoSync.test.ts` — confirm the deferred wiring still fires.

## Steps

1. Record the "before" activation timing from the exthost log as the baseline.
2. Replace the glob `activationEvents` with a non-glob fast path plus the existing lazy view trigger; confirm the extension still activates on a real Taskwright repo AND still activates for a nested/unusual backlog layout (or document the deliberate narrowing).
3. Extract the git/sync burst into a single deferred bootstrap that runs after the window is up (idle / `onStartupFinished`), keeping the exact same ordering guarantees the git-auto engine relies on (ensure-worktree before fold-strays before first sync).
4. Confirm the git-auto fresh-clone bootstrap and stray-heal still work (existing integration tests).
5. Re-measure activation from the exthost log and record before/after in the implementation notes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Two changes, one goal: stop being an eager, search-gated startup extension

### 1. Glob activation events → plain-path stats

VS Code resolves a `workspaceContains:` pattern one of two ways: a pattern with **no glob
metacharacters** becomes a direct file `stat`; a pattern **with** them goes through the workspace
**search service**, which walks the tree before it can even decide whether to activate us. All six of
Taskwright's patterns were recursive-wildcard globs, so every window open paid for a workspace search.

Now:

```
workspaceContains:backlog/config.yml
workspaceContains:backlog/config.yaml
workspaceContains:.backlog/config.yml
workspaceContains:.backlog/config.yaml
workspaceContains:backlog.config.yml
```

**Deliberate narrowing:** a backlog root nested somewhere below the workspace root (e.g.
`packages/foo/backlog/`) no longer *eager*-activates. It still activates the moment the board view is
opened — VS Code synthesizes `onView:taskwright.kanban` from the contributed webview view, which the
exthost log confirms already works. `src/test/unit/activationEvents.test.ts` guards against a glob
creeping back in.

### 2. The git burst moved off the critical path

`activate()` fired a pile of git subprocesses while the window was still coming up: worktree guard,
post-checkout warn, board hooks, merge-config publish + verify doctor, sync-config publish, the
board-sync status bar (resolves the git common dir), the git-auto bootstrap (ensure-worktree,
fold-strays) and its **network fetch and push**, plus the board doctor. Un-awaited is not the same as
free — it all competed with startup.

New pure core `src/core/deferredBootstrap.ts` (`createDeferredRunner`): runs the work **once**, ~2s
after activation, cancellable on dispose, pull-forward-able via `runNow()`, and it never rejects into
its caller (a failing bootstrap must not take activation down). Activation now just schedules it.
Ordering inside is preserved, because the git-auto engine depends on it: housekeeping → status bar →
ensure-worktree → fold-strays → first sync.

I did **not** invent an `onDidResolve` hook on the board surfaces to pull the bootstrap forward when
the board opens: nothing the board renders depends on this work (it reads the parser), so the timer
alone is correct and the smaller change is the right one.

## Verification, and what is still open

- `bun run test` 2065 passed / 144 files (11 new); `bun run lint`, `bun run typecheck` clean; `bun run build` succeeds.
- The **end-to-end** proof — Taskwright no longer gating `Eager extensions activated` — cannot be taken
  from this worktree: it needs the built extension INSTALLED in the user's VS Code and the window
  reloaded. The baseline is on record (exthost log: Taskwright last eager extension, 2.1s after exthost
  start, gating the milestone, with Copilot Chat's `onStartupFinished` queued behind it). AC #5 is left
  UNCHECKED for that reason rather than claimed.
<!-- SECTION:NOTES:END -->
