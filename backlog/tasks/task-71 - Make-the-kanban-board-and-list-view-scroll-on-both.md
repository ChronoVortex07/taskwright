---
id: TASK-71
title: Make the kanban board and list view scroll on both axes
type: bug
status: Done
assignee: []
created_date: '2026-07-08 05:24'
updated_date: '2026-07-08 06:09'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Core Board
plan: docs/superpowers/plans/2026-07-08-kanban-list-scroll-both-axes.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On a narrow VS Code sidebar the kanban board can't be scrolled vertically — tall columns get clipped and can't be reached.

Root cause: `.kanban-board` sets `overflow-x: auto` but no `overflow-y`, and `body.tasks-page` sets `overflow: hidden`, so content taller than the viewport is clipped with no scrollbar (src/webview/styles.css:305-311). `#kanban-app` (Tasks.svelte:752) has no CSS rule, and neither `.kanban-column` (styles.css:363-375) nor `.task-list` (styles.css:442-449) sets overflow. The list view has the same exposure — `.task-list-container` (styles.css:899-901) has no overflow.

Add a scroll container that scrolls on BOTH axes so the whole board is reachable at any panel size, without breaking the existing horizontal scroll or the milestone-grouped variant (styles.css:319-324 sets overflow-x: visible and delegates horizontal scroll to nested boards at styles.css:330-335).

Acceptance criteria:
- Kanban board scrolls vertically AND horizontally when content exceeds a narrow sidebar panel.
- Milestone-grouped and label-grouped variants still scroll correctly (nested boards keep horizontal scroll).
- List view content is reachable when it exceeds the viewport height.
- No regression to card drag-and-drop or column layout.
- Verify visually at a small viewport via the agent-browser / visual-proof fixture.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek-pro worker per plan. Made #kanban-app the single both-axes scroll container (flex:1; min-height:0; overflow:auto), #kanban-view/#list-view/#archived-view flex columns, .kanban-board min-height calc(100vh-85px)→100%, and #kanban-app>.kanban-board overflow-x:visible so nested/grouped boards keep their own horizontal scroll. Verified: 1607 vitest pass (no regression), lint/typecheck clean, 108 playwright pass incl. 2 new both-axes scroll tests + existing horizontal-scroll tests. Merged to orchestration-ux-polish (integration branch).
<!-- SECTION:FINAL_SUMMARY:END -->
