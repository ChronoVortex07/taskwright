---
id: TASK-109
title: Cut Taskwright's contribution to VS Code window startup time
status: To Do
assignee: []
created_date: '2026-07-12 06:21'
updated_date: '2026-07-12 06:21'
labels:
  - performance
  - activation
milestone: Performance & Startup Cost
dependencies: []
priority: high
category: 'Core Board'
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
- [ ] #1 `activationEvents` no longer forces a workspace glob SEARCH on every window open: at minimum a non-glob `workspaceContains:` path (fast stat) is used for the common layout, and/or the extension relies on the already-working lazy `onView:taskwright.kanban` trigger.
- [ ] #2 The git/sync burst currently run inline in `activate()` (worktree guard, post-checkout warn, board hooks, merge-config + verify doctor, sync-config publish, git-auto bootstrap/auto-sync) is deferred off the window-open critical path (e.g. behind `onStartupFinished` / idle) rather than awaited during activation.
- [ ] #3 In `git-auto` mode, the activation-time `runBoardAutoSync` network fetch/push no longer runs on the window-open critical path.
- [ ] #4 Behavior preserved: board still loads, doctor still runs, git-auto still bootstraps a fresh clone and heals strays, board sync still fires on its existing events — covered by the existing unit suites (`gitAutoIntegration`, `boardDoctor`, `autoSync`, `syncConfig`).
- [ ] #5 Measured improvement: with the change built and installed, the exthost log shows Taskwright no longer gating the `Eager extensions activated` milestone — before/after activation timings recorded in the task's implementation notes.
- [ ] #6 `bun run test`, `bun run lint`, `bun run typecheck` pass.
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
