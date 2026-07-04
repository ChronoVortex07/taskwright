---
name: execute-task
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task" for a task the board dispatched to this session. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__request_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Bash, Read, Grep, Glob
---

# Execute task (Taskwright)

Execute exactly one Taskwright task from start to merge: load your assignment, confirm you are in
the task's isolated worktree, claim it, do the work with the right execution strategy, record what
you learn, and close through the merge queue with `request_merge`. Parity: every step here is one a
human can drive from the P2 board (Claim / Request merge / Cancel dispatch) — you are automating the
sequence, not bypassing it.

## When to use

- The user invokes `/execute-task`, or asks you to execute / work on / do / run a specific task.
- A dispatch handed this session a task (the dispatch prompt tells you to run `/execute-task`).
- Not for authoring or decomposing new work — that is `/create-task`. This skill *executes* an
  existing task.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any headless
agent. The sub-skills it invokes (`superpowers:executing-plans`, `superpowers:subagent-driven-development`,
`superpowers:test-driven-development`) run in-session and use the Task tool for any subagents — never
`claude -p`. Everything else is the `taskwright` MCP tools plus local Bash/Read/Grep/Glob.

## The loop

1. **Load once.** Call `get_active_task` a single time. Capture the returned **task ID** and its
   full context (description, acceptance criteria, plan link, subtasks). Work from that fixed ID for
   the rest of the session — **never re-read `get_active_task` for your identity or status**: the
   active task is an ephemeral human-focus pointer and may drift to an unrelated task while you work.
   - If `get_active_task` reports no active task, STOP and ask which task to work on (do not guess
     from the file tree).

2. **Verify the worktree, then install deps.** Your task must run inside its own `.worktrees/<branch>`,
   because the `taskwright` MCP server roots itself at the directory the session was launched in — an
   in-session `cd` does not move it. This step **verifies**; it does not create.
   - The cheap confirmation is that step 1 returned a task at all (⇒ the MCP is rooted in the
     worktree). Double-check with Bash: `git rev-parse --git-common-dir` and `git rev-parse --git-dir`
     should **differ** (a linked worktree), and the working directory should be under `.worktrees/`.
   - If you are **not** worktree-rooted (step 1 returned "no active task", or the two git dirs match =
     the primary tree), **STOP**. Do not create a worktree and continue — the already-spawned MCP
     server cannot be re-rooted this session. Tell the user to **Dispatch** the task from the board
     (or relaunch the session with its working directory set to `.worktrees/<branch>`) and re-run
     `/execute-task`.
   - A fresh worktree has no `node_modules` (git-ignored). If it is absent, run `bun install` once
     (Bash) before you build or test.
   - Never `git checkout`, `commit`, or `merge` in the repository root — it is shared with other
     agents and a managed pre-commit hook blocks it. All git/file/test commands run in the worktree.

3. **Claim.** Call `claim_task` with your task ID. This places the advisory claim AND
   automatically advances the task status from the board's first configured status (typically
   "To Do") to its second (typically "In Progress"), so the board immediately shows someone is
   working on it. If the task is already past the first status the status is left unchanged.
   On a synced board a claim may **surrender** if another session already holds it; if so, stop
   and pick a different task with the user.

4. **Execute (adaptive — ordered gate).** Choose the strategy by this precedence, first match wins:
   1. **Attached plan** — the task has a `plan` and its `planProgress.exists` is true ⇒ invoke
      `superpowers:executing-plans` and work the plan's checkboxes.
   2. **Independent subtasks** — the task has `subtasks` AND those subtask rows are mutually
      dependency-free ⇒ invoke `superpowers:subagent-driven-development`. Judge independence by
      fetching the subtask rows with `get_board` and checking that none lists another in-set subtask
      in its `dependencies` / `blockedBy` (if they chain, they are not independent — fall through).
   3. **Otherwise** ⇒ invoke `superpowers:test-driven-development` (write the failing test first,
      then implement).
   Precedence is **plan > independent-subtasks > TDD**.

5. **Record progress.** As you go, use `edit_task` to append implementation notes (decisions,
   surprises) and, when done, a final summary. Do **not** call `complete_task` — `request_merge`
   marks the task Done on the board and leaves it there.

6. **Cancellation checkpoint (mandatory before closing).** Before `request_merge` — and between major
   steps — run the cancellation check (below). If cancelled, **stop; do not `request_merge`**.

7. **Close.** When the work is committed and the worktree is clean, call `request_merge` from inside
   the worktree and wait for it to return. It rebases onto the base branch, runs the verify commands,
   waits for its turn in the merge queue (and, in manual-review mode, for the human's approval on the
   board), fast-forward-merges (or opens a PR), marks the task **Done**, and removes your worktree. Do
   not merge, commit, or push from the repository root yourself.

## Cancellation contract

A dispatch can be cancelled from the board while you work. Cancellation is **task/worktree-scoped**,
never signalled through the drifting active task. At each checkpoint treat **either** of these as
cancelled (both are first-class — neither is "primary"):

- **Marker present** — `test -f .taskwright/cancelled` in your worktree succeeds. Detection is
  **presence-only**: never read or parse the file's contents.
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", or `request_merge` aborting because it is now the
  primary tree). On POSIX the marker is deleted along with the worktree, so this is the reliable
  signal there; on Windows the marker may survive a busy removal.

On cancellation: **stop immediately, do NOT `request_merge`**, leave a short note via `edit_task` if
the task is still reachable, and exit (release your working directory). Do **not** remove the worktree
yourself — the extension owns teardown.

## Rules of thumb

- One session = one task; hold the task ID from step 1 and never re-derive it.
- Launch inside the worktree; if you are not worktree-rooted, stop and ask for a dispatch — do not
  self-create a worktree and continue.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close with `request_merge` from the worktree; never commit/merge from the repo root.
