---
id: TASK-129
title: >-
  Return full task context from start_task/claim_task and give get_active_task a
  session-claim fallback
status: In Progress
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 10:06'
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
plan: docs/superpowers/specs/2026-07-14-session-task-context-design.md
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause is structural, not a bug: `start_task` seeds the active-task marker INSIDE the new worktree (where a relaunched session would read it), while the calling session's MCP server stays rooted in the primary tree (it binds `TASKWRIGHT_ROOT || cwd` once at launch; an in-session `cd` does not move it). So the session that just bootstrapped a worktree was precisely the one that could not see its own active task — and it went hunting for the board on disk, which in git-auto mode isn't even under the repo root.

Fix:
(a) `start_task` and `claim_task` now return the task's full context (`task`: the same TaskSummary `get_active_task` returns — description, ACs, DoD, plan + planProgress, tree fields, board filePath). `claim_task` hydrates AFTER the claim write, so the echoed status is the post-claim "In Progress", not a stale "To Do". A surrendered/locked claim returns no context. Extracted `hydrateTaskSummary` + `queuePositionFor` so all three tools share one code path.

(b) New `src/core/sessionTasks.ts` — a local, git-ignored session-task ledger at `<root>/.taskwright/session-tasks.json` recording tasks THIS session started/claimed. `get_active_task` resolves: marker → session → none, and reports `source`. `release_task` and a terminal `request_merge` forget the entry; a read-time liveness filter drops entries that are missing, Done, or past the 12h staleness window.

Key design call — the ambiguity guard: the ledger is a LIST, and with >1 live entry `get_active_task` returns `active:false` + `candidates` rather than a guess. One orchestrator session shares ONE MCP server and root across all its in-session subagents, and MCP calls carry no working directory, so the server genuinely cannot tell which subagent is asking. Returning "most recent" would have handed 10 of 11 subagents someone else's task — silently working the wrong task is far worse than active:false. That is why (a) is the real fix and the fallback is a safety net.

Surfaces (AC4): tool descriptions, MCP instructions (kept the critical loop inside the 512-char truncation budget — mcpInstructions.test.ts enforces it), and the execute-task / orchestrate-board skills now say the context arrives WITH start_task/claim_task and forbid a filesystem hunt for the board by name. Codex `.agents/skills/` packages are installed from `dist/skills/` (bundled from `.claude/skills/`), so they inherit the update — no second copy to edit.

Tightened one pre-existing test: `mcpHandlers.test.ts` asserted a self re-claim triggers NO `fs.writeFileSync` at all, as a proxy for "no board churn". The ledger refresh is a write to a different, git-ignored file, so the assertion is now scoped to board task-file writes — and a new test pins that the self re-claim DOES refresh the ledger (that is the session-restart case that makes the fallback work).

Verified end-to-end by driving the BUILT dist/mcp/server.js over stdio JSON-RPC in a scratch repo, replaying the exact friction sequence: start_task and claim_task return full context; get_active_task (the call that returned {"active": false} for 9 of 11 subagents) now returns active:true / source:"session"; two tasks in flight yield active:false + candidates.
<!-- SECTION:NOTES:END -->
