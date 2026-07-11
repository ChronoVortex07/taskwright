---
id: TASK-35
title: >-
  Tree tab silently renders empty when check_active_branches is true, even with
  sync mode on
type: bug
status: To Do
assignee: []
created_date: '2026-07-04 01:01'
updated_date: '2026-07-04 09:36'
labels: []
dependencies: []
priority: high
caused_by: TASK-18
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found live on this repo 2026-07-04, right after the /index-codebase tree bootstrap: the Tree tab showed zero nodes while Kanban/List correctly showed all tasks/drafts.

Root cause: `TasksController.ts:234-236` sets `this.dataSourceMode = 'cross-branch'` whenever `config.check_active_branches` is true — unconditionally, with no regard for sync mode. Then `TasksController.ts:283-290`:
```
if (this.dataSourceMode !== 'cross-branch') {
  try { treeBoard = await loadTreeBoardFromParser(this.parser); } catch { treeBoard = undefined; }
}
```
skips tree derivation entirely in cross-branch mode (per the comment at line 261-268, this is deliberate: "cross-branch mode skips tree derivation... so there is nothing to render"). So `treeBoard` stays `undefined`, the canvas has zero laid-out nodes, and nothing signals to the user why — the tree just looks empty, no error, no banner. Kanban/List are unaffected because they read `tasks` directly (fetched earlier, independent of this gate).

This repo had `check_active_branches: true` in backlog/config.yml from before sync mode was ever turned on, and nothing auto-disabled it when sync was enabled — even though CLAUDE.md's own synced-board design says cross-branch scanning is moot once the board lives on the `taskwright-board` ref ("nothing to cross-scan"). Worked around here by manually setting `check_active_branches: false`, which is the objectively-correct config once sync is on, but nothing enforces or suggests that.

This exact interaction was never covered by tests: the tree e2e/CDP fixture (`src/test/e2e/fixtures/test-workspace/backlog/config.yml`) hardcodes `check_active_branches: false`, so cross-branch-mode-plus-tree-tab has never been exercised.

Two independent fixes worth considering: (1) `taskwright.enableSync` / `reconcileBoardRef` could auto-disable `check_active_branches` when turning sync on (matching the stated design intent), and/or (2) the tree tab should never render as silently, indistinguishably empty — either derive tree state locally regardless of dataSourceMode (BacklogParser.getTasksWithCrossBranch already goes local-only under sync per existing CLAUDE.md notes) or show an explicit "tree unavailable in cross-branch mode" banner instead of a blank canvas.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
