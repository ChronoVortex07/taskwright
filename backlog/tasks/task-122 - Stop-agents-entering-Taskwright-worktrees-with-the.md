---
id: TASK-122
title: >-
  Stop agents entering Taskwright worktrees with the harness worktree tool; fix
  mis-rooted request_merge close
type: bug
status: In Progress
assignee: []
created_date: '2026-07-12 16:47'
updated_date: '2026-07-12 16:58'
labels:
  - bug
  - orchestration
dependencies: []
priority: high
category: Agent skills
claimed_by: '@agent/task-122-stop-agents-entering-taskwright-worktrees-with-the-harness-worktree-tool-fix-mis-rooted-request-merge-close'
worktree: task-122-stop-agents-entering-taskwright-worktrees-with-the-harness-worktree-tool-fix-mis-rooted-request-merge-close
claimed_at: '2026-07-13 00:48'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`/orchestrate-board` cannot run autonomously: every task pauses for a permission prompt to enter a worktree, and approving it still fails with `Cannot enter worktree: the current working directory <repo root> is the repository root, not an isolated worktree — switching is only available to sessions whose working directory is inside a worktree of this repository.`

Root cause (diagnosed 2026-07-13, repro repo: asterra-game): that string is NOT Taskwright's. It comes from Claude Code's built-in `EnterWorktree` tool, whose own description says to use it when "CLAUDE.md or memory instructions direct you to work in a worktree for the current task" — which is exactly what Taskwright's AGENTS.md convention says ("Stay in your worktree ... `cd` there first"). So agents reach for the harness tool. It can never work for a Taskwright worktree:

- the harness manages its OWN worktrees under `.claude/worktrees/`; Taskwright's are plain `git worktree add` dirs under `.worktrees/` created by `start_task`;
- an orchestrate-board fan-out runs in `Task` subagents whose cwd is pinned at launch, so the call is treated as a *switch*, which the harness only permits into `.claude/worktrees/` of the same repo.

Allowlisting the permission does not help — the prompt is not the bug, the tool call is. The skills say WHERE to work but never say which mechanism NOT to use. The correct mechanism is Bash `cd` / `git -C`.

Second, coupled defect (silent work loss). The orchestrate-board subagent template has the agent `cd` into the worktree and THEN invoke `/execute-task`, whose step 2 probes `git rev-parse --git-dir` vs `--git-common-dir` from the Bash cwd and concludes "linked / worktree-rooted" — but the MCP server is still rooted in the primary tree (it cannot re-root mid-session). The agent then closes with a bare `request_merge`, which aborts at src/mcp/handlers.ts:466 ("request_merge must be called from inside your .worktrees/<branch>, not the primary tree"). `/execute-task`'s cancellation contract explicitly lists that primary-tree abort as a *cancellation* signal, so the subagent reports {"status":"cancelled"} and orchestrate-board deliberately does not retry — finished work is dropped.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The execute-task and orchestrate-board SKILL.md files, the AGENTS.md convention block (src/core/agentConvention.ts) and both dispatch templates (src/core/dispatchProfiles.ts) explicitly forbid the harness worktree-switch tool (EnterWorktree) and state that Taskwright worktrees are plain git worktrees under .worktrees/ entered with Bash cd / git -C.
- [x] #2 The rootedness decision no longer depends on the Bash cwd probe: an agent that called start_task in this session ALWAYS closes with request_merge { taskId, worktree }, because the MCP is primary-rooted regardless of where Bash cd'd.
- [x] #3 The orchestrate-board subagent prompt template tells the subagent to close with request_merge { taskId, worktree }.
- [x] #4 The primary-tree abort carries its own machine-readable abort code (wrong_root), distinct from cancellation, and /execute-task's cancellation contract no longer lists it as a cancellation signal.
- [x] #5 A unit test (src/test/unit/worktreeEntryContract.test.ts) fails the build if the skill/convention/template text loses the prohibition or the request_merge { worktree } contract.
- [x] #6 bun run test && bun run lint && bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause was NOT in Taskwright code — the "Cannot enter worktree" string is Claude Code's own `EnterWorktree` tool. Its documented trigger is "CLAUDE.md or memory instructions direct you to work in a worktree", which is exactly what every Taskwright instruction surface said, so agents reached for it. It can never open a Taskwright worktree (it manages `.claude/worktrees/`; ours are plain `git worktree add` dirs under `.worktrees/`), and from a cwd-pinned `Task` subagent — how /orchestrate-board fans out — the harness only permits switching within `.claude/worktrees/`. Allowlisting the permission would not have helped: the prompt was not the bug, the tool call was.

Fix is therefore in the instruction surfaces plus one abort code:
- All five surfaces (execute-task + orchestrate-board SKILL.md, TASKWRIGHT_AGENTS_CONVENTION, both dispatch templates) now forbid the harness worktree-switch tool BY NAME and state the working mechanism (`cd` / `git -C`). The Codex template says it agent-neutrally (an existing test forbids the word "Claude" there).
- Dropped /execute-task's `git rev-parse --git-dir` rootedness probe: after a `cd` it reports "linked" while the MCP is still primary-rooted. Rootedness now follows from a fact the shell cannot lie about — did THIS session call `start_task`?
- New `wrong_root` MergeAbortCode on the primary-tree abort (finishTask.ts + handlers.ts). This closed a silent-work-loss path: /execute-task's cancellation contract listed the primary-tree abort as a "worktree vanished ⇒ cancelled" signal, so a subagent that cd'd in and closed bare would report {"status":"cancelled"}, which /orchestrate-board deliberately never retries.
- src/test/unit/worktreeEntryContract.test.ts fails the build if any surface loses the prohibition or the `request_merge { taskId, worktree }` close.

Dogfooded: this task was executed from a primary-rooted session that bootstrapped its own worktree via start_task, entered it with plain `cd`, and closed with request_merge { taskId, worktree }.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Autonomous /orchestrate-board runs no longer stop for a worktree-entry approval that could not have succeeded anyway. Every instruction surface now names the harness worktree-switch tool as forbidden and `cd`/`git -C` as the mechanism; the lying cwd probe is gone; and a mis-rooted close returns `wrong_root` instead of masquerading as a cancellation that dropped finished work. Verified: 2090 unit tests, typecheck and lint all green.
<!-- SECTION:FINAL_SUMMARY:END -->
