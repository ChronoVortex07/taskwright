---
id: TASK-137
title: >-
  get_active_task session-ledger fallback can hand one session another session's
  task (TASK-134 audit)
type: bug
status: To Do
assignee: []
created_date: '2026-07-15 01:20'
updated_date: '2026-07-15 01:32'
labels: []
milestone: Workflow Friction Hardening
dependencies: []
references:
  - docs/audits/2026-07-15-workflow-friction-hardening-audit.md
priority: medium
category: Orchestration
caused_by: TASK-129
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Independent audit TASK-134 (reviewer: codex-terra / GPT-5.6), grounding-confirmed against the code.

The session-tasks ledger that backs `get_active_task`'s `source: "session"` fallback is keyed only by `deps.root` (src/mcp/handlers.ts:1119-1122, `readSessionTasks(deps.root)`), with staleness filtered by time only — not by session identity. Two independent primary-rooted MCP server processes at the same primary root share the same ledger file, and it survives a server restart.

Failure scenario: session A starts TASK-1 (writes the ledger entry). A fresh, unrelated session B at the same primary root (a second Claude Code / editor window, or a restarted server) calls `get_active_task` with no marker and no task of its own. `liveSessionTasks` returns A's still-live TASK-1, so B is handed `{ source: "session", task: TASK-1 }` — a wrong-task handoff, exactly the failure TASK-129 set out to prevent (an MCP call carries no cwd, and the fallback assumes one session per root).

This is a design gap, not a crash: it only bites when two sessions genuinely share a primary root concurrently (common in this project — multiple agent windows). Consider scoping the ledger entry to a per-session identity (e.g. a session nonce established at server start, or the worktree/branch identity already used for claims) and only returning entries this session wrote; or, when the single live entry was not written by the asking session, return `source: "none"` / candidates rather than guessing. Add a regression test with two sessions sharing a root.

Reference: docs/audits/2026-07-15-workflow-friction-hardening-audit.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The get_active_task session fallback never returns a task that a DIFFERENT session started/claimed: when the only live ledger entry was not written by the asking session, it returns source: none (or candidates), not that entry.
- [ ] #2 Ledger entries are scoped to a per-session identity (nonce or worktree/branch identity), not just deps.root, so two sessions sharing a primary root do not cross-read.
- [ ] #3 The legitimate single-session case (a session that started/claimed its own task) still resolves via source: session unchanged.
- [ ] #4 Regression test reproduces two sessions at one primary root and asserts B is not handed A's task.
<!-- AC:END -->
