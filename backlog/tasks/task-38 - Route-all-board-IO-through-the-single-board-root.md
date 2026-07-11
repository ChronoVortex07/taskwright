---
id: TASK-38
title: Route all board I/O through the single board root
status: Done
assignee: []
created_date: '2026-07-04 04:35'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-37
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The heart of Board Sync v2's live layer (spec §2.1). Make every board read and write — from the MCP server AND the extension host, from any worktree — target the ONE physical board dir returned by resolveBoardRoot() (task A). No per-worktree copy is read or written.

Scope:
- MCP: route BacklogParser/BacklogWriter and all handlers to the resolved board root instead of TASKWRIGHT_ROOT/worktree-local backlog/.
- Extension host: TasksController create/edit/drag/reorder and the parser/writer it uses target the resolved root. This is where the v1 UI-write gap lived.
- Ensure surgical, atomic writes (write-temp-then-rename) so concurrent agents can't tear a file.

Subsumes TASK-44 (UI writes bypassed snapshot+push) and TASK-34 (concurrent synced-write race) — with one physical board there is no copy to bypass and no CAS to race. Close both as superseded on promotion.

Acceptance:
- A write issued from a `.worktrees/<branch>` worktree is immediately visible in the primary checkout's board (integration test with two worktrees, no materialize step).
- TasksController create/edit/drag writes land in the one board and survive (no silent rollback).
- Board dirs stay git-ignored; a board write leaves every code tree's `git status` clean.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
