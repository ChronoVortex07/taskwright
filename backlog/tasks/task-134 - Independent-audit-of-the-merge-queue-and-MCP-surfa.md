---
id: TASK-134
title: Independent audit of the merge-queue and MCP-surface wave (c76f7a2..3f97a3d)
status: In Progress
assignee: []
created_date: '2026-07-14 16:51'
updated_date: '2026-07-15 01:24'
labels: []
milestone: Workflow Friction Hardening
dependencies: []
references:
  - 9d4fb43
  - 0bbf569
  - e1397c4
  - 3758b29
  - 17a2137
  - dbba301
  - 3f97a3d
priority: medium
category: Worktrees & Merge
claimed_by: '@agent/.worktrees/task-134-independent-audit-of-the-merge-queue-and-mcp-surface-wave-c76f7a2-3f97a3d'
worktree: .worktrees/task-134-independent-audit-of-the-merge-queue-and-mcp-surface-wave-c76f7a2-3f97a3d
claimed_at: '2026-07-15 09:24'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Workflow Friction Hardening wave landed seven commits on main in one orchestrated drain (2026-07-14/15), touching two of the riskiest surfaces in the codebase: **shared cross-process concurrency** and the **agent-facing MCP tool contract**. Each task passed its own gate (2400+ tests, lint, typecheck) and several were mutation-checked — but every one of those gates was written by the same agent that wrote the code. This task is the independent second read.

**Why it is worth doing rather than assuming green means correct:** TASK-130 was only supposed to *add tests* to existing merge paths, and in doing so it uncovered a genuine latent bug in `isSamePath` — it resolved with the ambient `path.resolve`, so its `winLike` flag switched the case rule but not the path *flavor*, meaning each CI leg could only ever exercise its own rule. A wave that yields a real bug the moment someone looks closely deserves someone looking closely at the rest of it.

**This was dispatched once and REFUSED, not failed.** `ch worker --profile codex-sol` aborted because Codex's Windows sandbox helper (`codex-windows-sandbox-setup.exe`) is missing from both the standalone install (`~/.codex/packages/standalone/current/bin`) and the OpenAI Codex app build. The harness refused deliberately: a review through that binary runs **blind** — every file read silently fails while Codex still reports success — and a fake clean audit is worse than no audit. So this task is **blocked on the Codex install being repaired** (an environment prerequisite, not Taskwright code). Any genuinely independent, non-Claude reviewer satisfies it; codex-sol was merely the intended one.

**The range is pinned deliberately.** Audit `c76f7a2..3f97a3d` — do not re-derive it from "recent commits", which will drift as new work lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 An independent, non-Claude reviewer has audited the full `c76f7a2..3f97a3d` range against the five targets in the implementation plan.
- [x] #2 Every reported defect is triaged: either fixed (in this task or a new one, referenced by ID), or explicitly dismissed with a written reason. No finding is left silently unactioned.
- [x] #3 If the audit comes back clean, that is recorded in the final summary along with which reviewer ran it — a clean audit is only worth anything if we know it wasn't blind.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The reviewer actually read the files — confirm the sandbox/tooling was working, since the known failure mode here is a reviewer that silently reads nothing and reports success.
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Audit targets, in priority order (this is the brief the refused dispatch carried — reuse it):

1. **TASK-126 — the cross-process verify slot** (`9d4fb43`). An O_EXCL lock in the git common dir, stolen on dead pid / expired lease / torn write, released before the merge-queue wait. Hunt for: deadlock, lost wakeups, stale-steal races, any path where two verifies still overlap, and any path where the slot leaks and is never released.
2. **TASK-127 — `request_branch_merge`** (`3758b29`). Confirm the board genuinely cannot be written when the queue key is `branch:<name>` (the invariant is derived in the merge core rather than trusted to callers — verify that derivation holds), and that worktree/branch teardown cannot destroy something it should not.
3. **TASK-130 — the `isSamePath` flavor fix** (`3f97a3d`). Confirm production behavior is truly unchanged on both real platforms, and that the worktree-target validation gate cannot be bypassed by a crafted path.
4. **TASK-129 — session-tasks ledger + `get_active_task` fallback** (`dbba301`). Check for any path where one orchestrator session's subagents are handed the wrong task (MCP calls carry no cwd, and one session shares one server across all its subagents).
5. **TASK-133 — the `complete_task` dewire** (`0bbf569`). Confirm no reachable caller survives.

Report concrete defects with file:line and a failure scenario. Skip style and formatting nits.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Independent audit run by **codex-terra (GPT-5.6, non-Claude)** over `c76f7a2..3f97a3d`, read-only via `ch worker --profile codex-terra --review-base c76f7a2 --review-commit 3f97a3d`. **Confirmed non-blind (DoD):** the reviewer named the files it read (`verifySlot.ts`, `handlers.ts`, `sessionTasks.ts`, `mergeQueue.ts`, `finishTask.ts`, `server.ts`, `TasksController.ts`, `types.ts`) and cited real line ranges; the orchestrating session grounding-checked every finding against the actual code.

**6 defects found (5 P1, 1 P2), all real** — triaged into follow-up drafts (referenced by ID; nothing left unactioned, AC2):
- TASK-135 — verify-slot lock protocol, 4 findings: non-atomic publish (177-179), unguarded stale-steal (184-190), unpersisted lease (215-220), swallowed non-contention create errors (177-182). All can reintroduce verify overlap or wedge merges.
- TASK-136 — request_branch_merge misroutes slash-containing branch names as paths (handlers.ts:434-437).
- TASK-137 — get_active_task session-ledger fallback keyed only by deps.root leaks tasks across sessions sharing a root (handlers.ts:1119-1122).

**Clean (AC3), reviewer named above:** isSamePath flavor fix (TASK-130), complete_task dewire (TASK-133 — no reachable caller), request_branch_merge board-neutralisation invariant (TASK-127 — correctly derived in the merge core).

Full report committed at docs/audits/2026-07-15-workflow-friction-hardening-audit.md. The findings are latent (narrow timing windows / multi-session preconditions), so they do not block shipping the wave, but the follow-ups should be visible in the release notes.

Note: the intended reviewer codex-sol was refused (missing Codex Windows sandbox helper → blind reads); codex-terra was the accepted independent substitute and, unlike codex-sol, ran non-blind.
<!-- SECTION:FINAL_SUMMARY:END -->
