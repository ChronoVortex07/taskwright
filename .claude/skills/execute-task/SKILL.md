---
name: execute-task
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task". Works from ANY session: a dispatched worktree session, or a primary-rooted session that bootstraps its own worktree via start_task. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__start_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__attach_plan, mcp__taskwright__request_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Skill(superpowers:writing-plans), Bash, Read, Grep, Glob
---

# Execute task (Taskwright)

Execute exactly one Taskwright task from start to merge: load your assignment, get into the task's
isolated worktree (already there when a dispatch launched you; otherwise bootstrap one with
`start_task`), claim it, do the work with the right execution strategy, record what you learn, and
close through the merge queue with `request_merge`. Parity: every step here is one a human can drive
from the P2 board (Claim / Request merge / Cancel dispatch) — you are automating the sequence, not
bypassing it.

## When to use

- The user invokes `/execute-task`, or asks you to execute / work on / do / run a specific task.
- A dispatch handed this session a task (the dispatch prompt tells you to run `/execute-task`).
- **From any session — no board Dispatch required.** Run `/execute-task` from a primary-rooted
  session (optionally naming a task, e.g. `/execute-task TASK-7`) and this skill bootstraps the task's
  isolated worktree for you via `start_task`, then runs the same loop.
- Not for authoring or decomposing new work — that is `/create-task`. This skill _executes_ an
  existing task.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any headless
agent. The sub-skills it invokes (`superpowers:executing-plans`, `superpowers:subagent-driven-development`,
`superpowers:test-driven-development`) run in-session and use the Task tool for any subagents — never
`claude -p`. Everything else is the `taskwright` MCP tools plus local Bash/Read/Grep/Glob.

## The loop

1. **Load once — fix your task ID.** Call `get_active_task` a single time, then settle on exactly ONE
   task ID for the whole session and work from that fixed ID — **never re-read `get_active_task` for
   your identity or status**: the active task is an ephemeral human-focus pointer and may drift to an
   unrelated task while you work.
   - If `get_active_task` returns a task, use its **task ID** and capture its full context
     (description, acceptance criteria, plan link, subtasks).
   - Else if the user named a task (e.g. `/execute-task TASK-7`), use that ID and load its context
     with `get_board` (find the row) so you have the same fields.
   - Else (no active task and none named), **STOP and ask which task to work on** — do not guess from
     the file tree.

2. **Get into the task's worktree (verify, or bootstrap).** The task runs inside its own
   `.worktrees/<branch>`. The `taskwright` MCP server roots itself at the directory the session was
   launched in and an in-session `cd` does **not** re-root it — so how you proceed depends on where
   the MCP is rooted. Determine that with Bash:

   ```bash
   # "linked" = a per-task worktree (--git-dir differs from the common dir); "primary" = the main checkout.
   [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] && echo linked || echo primary
   ```

   - **`linked` — already worktree-rooted (the dispatched path, unchanged).** Confirm the working
     directory is under `.worktrees/`. A fresh worktree has no `node_modules` (git-ignored) — if it is
     absent, run `bun install` once (Bash) before you build or test. Proceed; you will close with a
     bare `request_merge` (step 7).

   - **`primary` — primary-rooted, so bootstrap the worktree yourself.** You already hold a task ID
     from step 1. Call **`start_task { taskId }`**. It creates (or reuses) `.worktrees/<branch>`, seeds
     the active task there, clears any stale cancellation marker, and returns
     `{ created, branch, worktree, worktreeAbs, relaunchHint }`. Keep `worktree` (repo-root-relative,
     e.g. `.worktrees/task-7-add-login`) and `worktreeAbs`. Then pick ONE path:
     - **Relaunch (preferred — full MCP isolation).** Surface `relaunchHint` to the user: open a new
       session whose working directory is `worktreeAbs` and run `/execute-task` there, then **STOP this
       session**. The relaunched session is worktree-rooted, so it takes the `linked` path above and
       closes with a bare `request_merge`.
     - **Single session (continue here).** You cannot re-root the MCP, but Bash / file / test work is
       not bound to it: `cd` into `worktreeAbs` and run **all** git / file / test commands there. If
       `node_modules` is absent, `bun install` once. Do the work, then close with the worktree-targeted
       form **`request_merge { taskId, worktree }`** (step 7) — a bare `request_merge` would abort
       because the MCP is still rooted in the primary tree.

   - **Never** `git checkout`, `commit`, or `merge` in the repository root — it is shared with other
     agents and a managed pre-commit hook blocks it. All git / file / test commands run in the worktree.

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

   **Attach any plan you author.** If the task had no plan but you write a spec or plan during
   execution (e.g. via `superpowers:writing-plans` for a large/ambiguous task), link it to the
   task with **`attach_plan`** — its checkbox progress then surfaces on the board and survives a
   handoff. The same applies to a plan produced while orchestrating: a plan that outlives the
   session belongs on the task, not just in your context.

5. **Record progress.** As you go, use `edit_task` to append implementation notes (decisions,
   surprises) and, when done, a final summary. Do **not** call `complete_task` — `request_merge`
   marks the task Done on the board and leaves it there.

6. **Cancellation checkpoint (mandatory before closing).** Before `request_merge` — and between major
   steps — run the cancellation check (below). If cancelled, **stop; do not `request_merge`**.

7. **Close.** When the work is committed and the worktree is clean, close through the merge queue:
   - If you are **worktree-rooted** (dispatched, or relaunched into the worktree), call
     `request_merge` from inside the worktree.
   - If you bootstrapped in this same primary-rooted session, call **`request_merge { taskId, worktree }`**,
     passing the repo-root-relative `worktree` that `start_task` returned (e.g.
     `.worktrees/task-7-add-login`). The `worktree` target tells `request_merge` which linked worktree
     to rebase/verify/merge — without it, `request_merge` aborts because the MCP is rooted in the
     primary tree.
     Wait for it to return. It rebases onto the base branch, runs the verify commands, waits for its
     turn in the merge queue (and, in manual-review mode, for the human's approval on the board),
     fast-forward-merges (or opens a PR), marks the task **Done**, and removes your worktree. Do not
     merge, commit, or push from the repository root yourself.

   **Bounded wait (`waitMinutes`) and the `pending` status.** By default the call blocks until the
   merge resolves. If a long park is likely (manual-review with a slow human, a deep queue) you may
   pass `waitMinutes` to bound the wait. On expiry the call returns
   `{ status: "pending", queuePosition, ticket }` — this is **not** a failure: your work is verified,
   the queue entry and board status are kept, and nothing needs re-doing. Handle it by **polling or
   parking**:
   - **Poll**: run the cancellation check, then call `request_merge` again with the same `taskId`
     (+ the returned `ticket`, and `waitMinutes` again if you want to stay bounded). The resume is
     idempotent — no re-enqueue, and verify is skipped when the base branch has not moved.
   - **Park**: if your session must end, report the task as pending (include the ticket) so a later
     session — or the human approving on the board — completes the merge; a later `request_merge`
     with the ticket resumes it, and a `sent_back` return on resume means a reviewer sent the task
     back while you were parked.
     Never treat `pending` as an error, and never fall back to merging from the repo root because of it.

## Cancellation contract

A dispatch can be cancelled from the board while you work. Cancellation is **task/worktree-scoped**,
never signalled through the drifting active task. At each checkpoint treat **either** of these as
cancelled (both are first-class — neither is "primary"):

- **Marker present** — `test -f .taskwright/cancelled` in your worktree succeeds. Detection is
  **presence-only**: never read or parse the file's contents.
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", `request_merge { worktree }` aborting because the
  target worktree is no longer listed, or — from the primary tree with no `worktree` target — the
  primary-tree abort). On POSIX the marker is deleted along with the worktree, so this is the reliable
  signal there; on Windows the marker may survive a busy removal.

On cancellation: **stop immediately, do NOT `request_merge`**, leave a short note via `edit_task` if
the task is still reachable, and exit (release your working directory). Do **not** remove the worktree
yourself — the extension owns teardown.

## Rules of thumb

- One session = one task; hold the task ID from step 1 and never re-derive it.
- Get into the worktree before doing work: worktree-rooted ⇒ proceed; primary-rooted ⇒ `start_task`,
  then relaunch into it or continue single-session and close with `request_merge { worktree }`.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close through the merge queue from the worktree; never commit/merge from the repo root.
