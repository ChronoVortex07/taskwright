---
id: TASK-64
title: Add task list with click-to-jump in the Tree Navigator sidebar
status: Done
assignee: []
created_date: '2026-07-04 12:13'
updated_date: '2026-07-04 12:39'
labels: []
dependencies: []
priority: medium
category: Tree
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Tree Navigator sidebar (`src/webview/components/navigator/TreeNavigator.svelte`) currently only shows lane toggles, age-jump buttons, and a minimap. It does not list individual tasks. The user wants:

1. **A task list** — show tasks in the sidebar, filterable by status. At minimum, "In Progress" tasks should be visible so the user can see what's actively being worked on.
2. **Click-to-jump** — clicking a task in the sidebar should pan/zoom the tree canvas to center on that task's node, similar to how the existing band-jump (`navigatorJump`) scrolls to a milestone band.

**What to do:**
- Add a "Tasks" section to the TreeNavigator that lists tasks matching the current filters (search text, priority, lane visibility).
- Each task entry shows: task ID, title (truncated), status badge, and lane.
- Add a status filter (checkboxes or chips: "To Do", "In Progress", "Done") — by default, show "In Progress" and "To Do".
- Clicking a task entry posts a new `navigatorJumpToTask` message with the task ID.
- In `TechTreeCanvas.svelte`, handle `navigatorJumpToTask` by computing the target node's world position from the geometry and animating/scrolling the viewport to center on it (similar to the existing band-jump logic at lines 166-174).
- The `TreeNavigatorProvider` (`src/providers/TreeNavigatorProvider.ts`) needs to include task data in `navigatorData` — currently it only sends lanes, bands, and priorities. Add a `tasks` field with compact task info (id, title, status, lane, band).
- The navigator refresh already has access to the full board via `loadTreeBoardFromParser` — extend it to also serialize task summaries.

**Acceptance criteria:**
- The navigator sidebar shows a list of tasks (at minimum In Progress ones).
- Status filter controls which tasks appear in the list.
- Clicking a task in the navigator pans the tree canvas to center on that task's node.
- The task list respects the existing search text and priority filters.
- Tests pass: `bun run test && bun run lint && bun run typecheck`.
- Visual proof: screenshot showing the navigator with task list and the canvas centered on the clicked task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Implementation notes

### Types (src/core/types.ts)
- Added `NavigatorTask` interface with id, title, status, priority, lane, band
- Added `navigatorJumpToTask` to both `WebviewMessage` and `ExtensionMessage`
- Added `tasks: NavigatorTask[]` to `navigatorData` in `ExtensionMessage`
- Exported `NavigatorTask` from webview lib types

### Provider (src/providers/TreeNavigatorProvider.ts)
- `refresh()` now fetches tasks+drafts and serializes compact `NavigatorTask` summaries
- Task lane comes from `category` (taskwright field), falling back to `laneOf()` helper
- `navigatorJumpToTask` added to relay conditions in `onDidReceiveMessage`

### Navigator component (src/webview/components/navigator/TreeNavigator.svelte)
- Task list state from `navigatorData` message
- Status filter chips (from available statuses in task data)
- Filtered task list: combines status filter + search text + priority + lane visibility
- Each task entry shows: task ID (monospace), title (truncated), status badge, lane label
- Click posts `navigatorJumpToTask` with task ID

### Canvas (src/webview/components/tree/TechTreeCanvas.svelte)
- Added `jumpTaskId`/`jumpTaskNonce` props
- Effect on `jumpTaskNonce` change: computes target node box from geometry, centers viewport

### Board (src/webview/components/tasks/Tasks.svelte)
- Handles `navigatorJumpToTask` message → sets `jumpTaskId`/`jumpTaskNonce` props

### Tests
- 4 unit tests for TreeNavigatorProvider (task serialization, fallback lane, relay)
- 5 new Playwright test cases for navigator task list
- All existing tests pass
<!-- SECTION:NOTES:END -->
