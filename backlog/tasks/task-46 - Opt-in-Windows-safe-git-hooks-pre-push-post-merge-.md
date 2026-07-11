---
id: TASK-46
title: Opt-in Windows-safe git hooks (pre-push / post-merge) for board push/pull
status: Done
assignee: []
created_date: '2026-07-04 04:38'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-43
priority: medium
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The opt-in automation on top of the explicit backbone (spec §2.2). Full "store on push / retrieve on pull" for those who want it, without making it the fragile default.

Scope:
- A committed, dependency-free hook script (pattern of scripts/taskwright-mcp.cjs) that resolves the primary checkout and invokes the SAME push/pull board core as task F (no duplicate logic).
- pre-push hook → push_board (snapshot+push the board ref alongside the code push). post-merge hook → pull_board (materialize after a pull). post-checkout optional/skipped if flaky.
- Installed ONLY on opt-in (taskwright.sync.installHooks from task I, or a taskwright.installBoardHooks command). Never auto-installed.
- Windows-safe: byte-exact via core.autocrlf=false/core.eol=lf (see the repo's documented autocrlf hook corruption); use --no-verify where needed to avoid recursive hook invocation; degrade gracefully (log, don't block the git op) if the board sync fails.
- Document the caveats + the manual command fallback.

Acceptance:
- With hooks installed, a `git push` also pushes the board ref; a `git pull` materializes board updates.
- A hook failure logs and does NOT abort or corrupt the user's git operation.
- Uninstall/opt-out cleanly removes the hooks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
