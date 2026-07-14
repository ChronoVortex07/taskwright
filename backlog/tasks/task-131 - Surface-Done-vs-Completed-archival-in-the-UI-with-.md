---
id: TASK-131
title: >-
  Surface Done vs Completed (archival) in the UI with an explicit action and
  undo path
status: To Do
assignee: []
created_date: '2026-07-14 05:26'
updated_date: '2026-07-14 08:21'
labels:
  - friction
  - ux
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
priority: low
category: Core Board
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The original "task just disappeared after merge" confusion (Done vs Completed/archival semantics) was fixed for agents by hard-coding rules into AGENTS.md, but the human UI still has no affordance explaining that complete_task files a task away into backlog/completed/ and removes it from the board (friction report 2026-07-14, item 8). A human who archives (or whose agent mistakenly archives) still experiences a silent disappearance.

Fix direction: label the action explicitly in the UI (e.g. "Archive to completed/ — removes from board"), show a confirmation that names the destination, and provide a discoverable undo (restore_task already exists — surface it, e.g. a "Recently completed" section or a toast with Undo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Any UI action that moves a task to completed/ is labeled as archival and states it removes the task from the board
- [ ] #2 After archiving, an undo path is discoverable in the UI (toast with Undo and/or a recently-completed list wired to restore_task)
- [ ] #3 Board webview copy distinguishes Done (stays on board) from Completed (archived) wherever both statuses can appear
- [ ] #4 Lucide icons, all themes supported; Playwright coverage for the confirm + undo flow
<!-- AC:END -->
