---
id: TASK-129
title: >-
  Return full task context from start_task/claim_task and give get_active_task a
  session-claim fallback
status: In Progress
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 08:21'
labels:
  - friction
  - mcp
  - orchestration
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - src/mcp/handlers.ts
  - .claude/skills/orchestrate-board/
  - .claude/skills/execute-task/
priority: medium
category: Orchestration
claimed_by: '@agent/task-129-return-full-task-context-from-start-task-claim-task-and-give-get-active-task-a-session-claim-fallback'
worktree: task-129-return-full-task-context-from-start-task-claim-task-and-give-get-active-task-a-session-claim-fallback
claimed_at: '2026-07-14 17:45'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
In the Jul 13 /orchestrate-board run, 9 of 11 self-bootstrapping subagents called get_active_task right after their own start_task/claim_task and got {"active": false} every time — the ephemeral active-task marker is only set by the board popover or an external dispatch, never by a session's own start_task. Each agent then rediscovered its task file by trial and error, made worse by git-auto mode (`ls backlog/tasks/` fails at the repo root; the board lives at .taskwright/board/backlog/tasks/): ~5 wasted tool calls per subagent before real work (friction report 2026-07-14, item 5).

Fix direction: (a) make start_task and claim_task return the task's full context (description, ACs, plan, file path) in their result so no follow-up lookup is needed; (b) make get_active_task fall back to "the task this session most recently claimed/started" when no external active-task marker is set; (c) update the orchestrate-board/execute-task skill docs to stop recommending get_active_task in self-bootstrapped flows (or note it now works).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 start_task and claim_task responses include the task's full context (frontmatter summary, description, acceptance criteria, plan, board file path)
- [ ] #2 get_active_task falls back to the session's own claimed/started task when the ephemeral marker is unset, and says which source it used
- [ ] #3 Externally-dispatched sessions see no behavior change (marker still wins over fallback)
- [ ] #4 orchestrate-board and execute-task skills reflect the new contract; no skill step instructs a directory hunt for the board
- [ ] #5 Unit tests cover marker-set, fallback, and no-claim (still active:false) cases
<!-- AC:END -->
