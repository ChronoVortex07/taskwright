---
id: TASK-12
title: 'Active tasks should be determined by focused task, not a specific button'
status: To Do
assignee: []
created_date: '2026-06-30 12:55'
updated_date: '2026-07-04 00:43'
labels: []
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The active task should be determined by which task is open on the details section, instead of needing to navigate so many panels to set the active task. If possible, it should also be attached as active context when selected, just like how having an active file in the editor will automatically attach it as context to send with the prompt, this should do the same.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Superseded by TASK-19 (Tech-tree P2b — interaction shell), landed 2026-07-02. TASK-19 shipped exactly this: the active task is now ephemeral, determined by which tree-node popover is open/focused (popoverActiveChanged), not a dedicated "Set active" button — the old backlog.setActiveTask/clearActiveTask commands remain only as a secondary path. The "auto-attach as context" half is served functionally by get_active_task, which every session calls first per AGENTS.md's mandated workflow. Archived during the 2026-07-04 /index-codebase tree bootstrap as a duplicate of already-shipped work.
<!-- SECTION:NOTES:END -->
