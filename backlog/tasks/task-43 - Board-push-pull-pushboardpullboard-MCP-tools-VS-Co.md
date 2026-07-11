---
id: TASK-43
title: Board push & pull — push_board/pull_board MCP tools + VS Code commands
status: Done
assignee: []
created_date: '2026-07-04 04:37'
updated_date: '2026-07-04 09:36'
labels: []
milestone: Board Sync v2 — Single Shared Board
dependencies:
  - TASK-40
  - TASK-41
priority: high
category: Sync
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The versioning-layer backbone (spec §2.2). Discrete, user-initiated snapshot/materialize across a remote — the ONLY thing that shares the board between people, with no live loop.

Scope:
- push_board: snapshotBoardRoot (D=DRAFT-19) → fetch the remote `taskwright-board` ref → union-merge (E=DRAFT-18) local vs remote → commit merged → `git push --no-verify origin taskwright-board`. Return the surfaced conflict list.
- pull_board: fetch the ref → union-merge into the local board → materializeToBoardRoot into the one board root → return conflicts.
- Expose BOTH as MCP tools (push_board / pull_board) AND VS Code commands (taskwright.pushBoard / taskwright.pullBoard). Same shared core — parity between agent and human.
- Remote is configurable (taskwright.sync.remote, default origin — settle final wiring with task I).
- Subscription-safe: no `claude -p`; pure git + the reused plumbing.

Acceptance:
- Two-clone round-trip: push from clone A, pull in clone B, B's board reflects A's tasks.
- Concurrent divergence (both clones add different tasks) unions cleanly; same-task edit surfaces a conflict, newer updated_date wins.
- A board push never dirties or blocks a code-branch merge.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
