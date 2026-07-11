---
id: TASK-33
title: >-
  Milestone resolution collapses task milestone NAME to its ID, breaking
  list_milestones/get_board grouping
type: bug
status: Done
assignee: []
created_date: '2026-07-04 00:53'
updated_date: '2026-07-04 12:11'
labels: []
dependencies: []
priority: high
caused_by: TASK-27
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the 2026-07-04 /index-codebase tree bootstrap, immediately after creating this repo's first 8 real milestones and assigning ~35 tasks to them.

Root cause (src/core/BacklogParser.ts:241, inside getTasksFromFolder): `task.milestone = this.resolveMilestoneValue(task.milestone, milestones)` overwrites the in-memory Task's milestone field. `resolveMilestoneValue` (BacklogParser.ts:957-974) is documented to "resolve a raw milestone input (ID, title, or partial match) to a canonical milestone ID" — so when a task's frontmatter holds a valid milestone NAME (e.g. "Foundation & Rebrand"), it gets rewritten in-memory to the milestone's ID ("m-0") via the unique-title-match branch (line 970-972: `return titleMatches[0].id`).

But downstream consumers expect a NAME, not an ID: `deriveTreeLayout`'s band matching (src/core/treeLayout.ts:60-82) compares `t.milestone` against `opts.milestoneOrder`, a list of milestone NAMES from `parser.getMilestones()`. Since "m-0" never matches "foundation & rebrand", every task with a resolvable milestone gets misrouted into a spurious "discovered" band literally named after its own milestone ID, instead of joining the real declared band. Symptoms: `list_milestones` shows the declared bands with taskCount:0 doneCount:0, plus a parallel set of bogus bands literally named "m-0".."m-7" holding the real counts; `get_board({milestone: "<real name>"})` returns an empty array even when tasks are correctly assigned. The task FILES on disk are unaffected (frontmatter correctly stores the display name) — this is purely a read-path bug. Dead code before this session (no milestones existed yet, so the title-match branch never fired).

Likely also affects the extension-host UI (TasksController) if it shares deriveTreeLayout/BacklogParser.getTasks() the same way, though not directly verified here — the canvas's own layout.band field is keyed by ID by design (a separate, seemingly-correct mechanism), so the visible tree may render fine while the MCP list_milestones/get_board query tools remain unreliable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause: BacklogParser.resolveMilestoneValue (src/core/BacklogParser.ts:897-914) returned the milestone ID when matching by either ID or name. This overwrote task.milestone in-memory (line 237) from the display name to the internal ID (e.g., "Foundation & Rebrand" → "m-0"). Downstream consumers like deriveTreeLayout compare task.milestone against milestone NAMES from getMilestones(), so every task landed in a spurious discovered band named after its own ID.

Fix: Changed resolveMilestoneValue to return the milestone NAME (milestone.name) instead of the ID (milestone.id) in both the ID-match and unique-title-match branches. This ensures task.milestone always holds the display name, so band grouping works correctly.

Files changed:
- src/core/BacklogParser.ts: resolveMilestoneValue returns milestone.name instead of milestone.id; updated JSDoc
- src/webview/components/tree/CreateTaskForm.svelte: updated comment explaining why form submits ID
- src/test/unit/BacklogParser.test.ts: renamed test + added ID→name resolution test
- src/test/unit/mcpReadHandlers.test.ts: added integration test with real milestone files (ID≠name)
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed a read-path bug where resolveMilestoneValue collapsed task milestone names to their internal IDs (m-0, m-1, etc.), causing deriveTreeLayout to create spurious discovered bands and breaking list_milestones/get_board grouping. The fix changes resolveMilestoneValue to return the canonical milestone NAME instead of the ID, so downstream band matching works correctly regardless of whether the task file stores the name or the ID. All 1507 tests pass, plus 3 new tests covering: title→name resolution, ID→name resolution, and end-to-end band grouping with real milestone files.
<!-- SECTION:FINAL_SUMMARY:END -->
