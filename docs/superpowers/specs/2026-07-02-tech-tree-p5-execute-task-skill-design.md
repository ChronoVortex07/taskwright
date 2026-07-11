# Design: Tech-tree P5 — `/execute-task` skill

**Date:** 2026-07-02
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`
**Builds on:** P1 (claim/gating), P2 (Dispatch + Cancel UI triggers; §7 wording clarified here), and the
existing dispatch/merge infrastructure.

P5 formalizes _executing_ a task as a self-sufficient skill: enter the task's worktree, do the work
with the right superpowers execution skill, and close through the merge queue — while staying
subscription-safe and honoring worktree isolation. It also owns the **Cancel-dispatch** plumbing that
P2's popover triggers.

## 1. Problem & goal

Dispatch today hands a fresh session a paste-ready prompt (worktree + active-task + handoff, never
`claude -p`) and `request_merge` does the merge-back, but the _execution workflow_ itself is only
prose in the dispatch template. P5 turns it into a reusable `/execute-task` skill that picks the
right execution strategy, records progress, and integrates — identically whether it was dispatched or
run directly.

## 2. Decisions locked during brainstorming

- **Self-sufficient skill:** `/execute-task` ensures it is in the task's worktree (creates/enters if
  needed), installs deps, works, and closes with `request_merge`.
- **Adaptive execution:** plan attached → `superpowers:executing-plans`; independent subtasks →
  `subagent-driven-development`; otherwise `test-driven-development`.
- **`get_active_task` is init-only** (§3); the skill holds its task ID and never re-reads it.
- **Cancellation is task/worktree-scoped** (§6), never via the drifting active-task.
- **Subscription-safe:** never spawns `claude -p`; runs inside the session.
- **Parity/reuse:** reuses `WorktreeService`, `activeTask`, `handoff`, `ClaimService`,
  `finishTask`/`request_merge`; human equivalents already exist (P2 Request merge / Cancel dispatch).

## 3. Active-task semantics (clarification)

Active-task is an **ephemeral, human-focus pointer** (P2): whichever popover is open is "active," and
it clears/changes as the user clicks around. Therefore:

- **`get_active_task` is used exactly once**, at session start, to inject the **initial context** —
  the task the human was looking at / dispatched. The skill captures that **task ID** and works from
  it.
- Thereafter the skill operates only on that **fixed task ID** via task-scoped tools
  (`claim_task`, `edit_task`, `request_merge`). It never re-reads `get_active_task` for its identity
  or status, because active-task may by then point at an unrelated task.

This is why cancellation must be task-scoped (§6), not active-task-based.

## 4. The `/execute-task` skill

A `.claude/skills/execute-task/SKILL.md` (name, description, `allowed-tools`: the taskwright MCP
tools + `superpowers:executing-plans` / `subagent-driven-development` / `test-driven-development`).
Its loop:

1. **Load** — `get_active_task` once → capture the task ID + context (description, ACs, plan link).
2. **Own** — `claim_task`; **ensure the worktree**: if not already inside `.worktrees/<branch>`, create
   /enter it (`WorktreeService`); `bun install` once (git-ignored `node_modules`).
3. **Execute (adaptive):**
   - task has an attached **plan** → `superpowers:executing-plans` (checkpointed);
   - task has **independent subtasks** → `subagent-driven-development`;
   - else → `test-driven-development`.
4. **Record** — progress/decisions via `edit_task` (implementation notes; final summary).
5. **Integrate** — `request_merge` (rebase → verify → queue → review gate → ff-merge / PR → mark Done
   → remove worktree). Never commit/merge from the repo root (pre-commit guard enforces this).
6. **Cancellation checkpoints** — between steps, check the worktree-local cancel signal / own claim
   (§6) and abort cleanly if cancelled.

The skill relies on the committed `scripts/taskwright-mcp.cjs` so the `taskwright` MCP tools are live
in the worktree at session start (no per-worktree build).

## 5. Human dispatch trigger (refined)

The existing `dispatchActions`/`dispatchPrompt` flow is kept and refined:

- Prepares the worktree, seeds the worktree's active-task (initial context), writes the handoff, and
  copies a paste-ready prompt whose instruction is now _"run `/execute-task`"_.
- Subscription-safe: clipboard by default; optional terminal launch (still refuses `claude -p`).
- `/execute-task` is also **runnable directly** in the user's own session to work a task in isolation
  (it self-creates the worktree), giving humans the same one-command execution path.

> **P5 implementation deviation (2026-07-03):** the "runnable directly / self-creates the worktree" path (§5, last bullet) is descoped. The taskwright MCP server roots itself once at launch (`src/mcp/server.ts`) and `request_merge` aborts on the primary tree (`isPrimaryTree`), so a repo-root session cannot self-create a worktree and continue. `/execute-task` instead **verifies** it was launched inside `.worktrees/<branch>` (dispatch is the normal trigger) and stops with guidance otherwise. Also: the §6 "later prune succeeds / worktree reclaimed" note is corrected — `git worktree prune` only deregisters worktrees whose directory is already missing, and `cancelDispatch` fires once, so a Windows live-agent cancel **leaks** the worktree until a re-dispatch reuses it (with the stale marker cleared). See `.superpowers/tech-tree-run/p5-architecture-directives.md` (CENTRAL INVARIANT + GAP-2 + DEVIATIONS).

## 6. Cancel-dispatch plumbing (task-scoped)

Triggered by the P2 popover's **Cancel dispatch** on an agent-held task. The extension (which knows
the task's worktree path):

1. **Writes a cancellation marker** into that task's worktree `.taskwright/` (e.g.
   `.taskwright/cancelled`) — task/worktree-scoped, independent of active-task.
2. **Releases the claim** on the task.
3. **Removes the worktree** (`git worktree remove --force` + `git worktree prune`).
4. **Terminates the terminal** if we launched it.
5. Returns the task to **To Do**.

The skill detects cancellation at its checkpoints by reading the **worktree-local marker** (a plain
file read, no dependence on active-task) and/or finding it **no longer holds its claim**; and if the
worktree has been removed, any further file/git/`request_merge` operation fails loudly. On detection
the skill stops and cleans up. (Clipboard-dispatched agents can't be force-killed, so the marker +
worktree removal are the reliable signals; terminal kill is the clean path when we own the process.)

**P2 §7 wording is adjusted** so "the agent observes cancellation on its next check" refers to this
task-scoped signal, not `get_active_task`.

## 7. Parity, subscription-safety & testing

- **Parity:** everything the skill does has a human equivalent in the P2 UI (Claim, Request merge,
  Cancel dispatch); the skill just automates the sequence via the same tools/writers.
- **Subscription-safe:** no `claude -p`; the skill runs in the interactive session, and dispatch only
  ever hands off a prompt.
- **Testing:** unit tests for the cancel plumbing (marker write, claim release, worktree removal,
  terminal kill) and the refined dispatch prompt; scenario coverage for the adaptive strategy
  selection (plan / subtasks / neither) and for a mid-run cancellation aborting cleanly.

## 8. Scope boundary & dependencies

**In P5:** the `/execute-task` skill, the refined dispatch trigger, and the task-scoped
Cancel-dispatch plumbing.

**Depends on:** P1 (claim/gating), P2 (Dispatch/Cancel UI triggers), and the existing dispatch +
merge-queue infrastructure (`WorktreeService`, `finishTask`/`request_merge`, hook guard,
`scripts/taskwright-mcp.cjs`).

**Deferred:** codebase indexing (**P6**), which bootstraps an initial tree on an existing project and
reuses P4's create/traversal tools; executing those bootstrapped tasks is then P5's job.
