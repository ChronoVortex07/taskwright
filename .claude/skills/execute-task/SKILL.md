---
name: execute-task
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task". Works from ANY session: a dispatched worktree session, or a primary-rooted session that bootstraps its own worktree via start_task. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__start_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__attach_plan, mcp__taskwright__request_merge, mcp__taskwright__request_branch_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Skill(superpowers:writing-plans), Bash, Read, Grep, Glob
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

1. **Load once — fix your task ID.** Settle on exactly ONE task ID for the whole session and work from
   that fixed ID — **never re-read `get_active_task` for your identity or status**: the active task is
   an ephemeral human-focus pointer and may drift to an unrelated task while you work.
   - If the user named a task (e.g. `/execute-task TASK-7`), use that ID. Its **full context arrives
     with the bootstrap** — `start_task` (step 2) and `claim_task` (step 3) each return the task's
     description, acceptance criteria, plan + progress, and board file path. That is your context; you
     do not need a separate lookup.
   - Else call `get_active_task` **once**. A dispatched session gets its task from the marker
     (`source: "marker"`); a session that already started/claimed a task gets it back from its own
     session record (`source: "session"`).
   - Else (nothing named and no active task), **STOP and ask which task to work on**.
   - **Never hunt the file tree for the board.** Do not `ls backlog/tasks/`, glob for a task file, or
     grep the repo for your task ID — in `git-auto` mode the board is not even under the repo root.
     The task context comes from the MCP tools, and only from them. If `get_active_task` returns
     `candidates` (this session has several tasks in flight and MCP calls carry no working directory,
     so the server cannot tell which subagent is asking), do **not** guess: use the ID you were given
     and the context `start_task` / `claim_task` returned for it.

2. **Get into the task's worktree (dispatched, or bootstrap it).** The task runs inside its own
   `.worktrees/<branch>`. Two facts decide everything here, and they are not the same fact:
   - **The MCP root is fixed at launch.** The `taskwright` server roots itself at the directory the
     session launched in and an in-session `cd` does **not** re-root it. So the question that matters
     is not "where is my shell?" but **"did I have to bootstrap this worktree myself?"** — never probe
     `git rev-parse` from the shell to answer it; after a `cd` that probe reports the worktree while
     the MCP is still in the primary tree, and the mis-rooted close that follows aborts with
     `wrong_root`.
   - **A Taskwright worktree is a plain git worktree.** It is created by `git worktree add` under
     `.worktrees/` and is **not** managed by your agent harness. **Never use a harness worktree-switch
     tool** (Claude Code's `EnterWorktree`) to reach it: that tool only manages its own
     `.claude/worktrees/`, so it prompts for approval and then fails — and from a cwd-pinned subagent
     it can never succeed. Reach the worktree by launching in it, or with plain `cd` / `git -C`.

   Then take exactly one path:

   - **Dispatched (the session was launched inside the worktree).** The dispatch prompt named
     `.worktrees/<branch>` as your working directory. Confirm you are there, run `bun install` once if
     `node_modules` is absent (it is git-ignored, so a fresh worktree has none), and proceed. You close
     with a **bare `request_merge`** (step 7) — the MCP is rooted in the worktree.

   - **Not dispatched — bootstrap it yourself.** You already hold a task ID from step 1. Call
     **`start_task { taskId }`**. It creates (or reuses) `.worktrees/<branch>`, seeds the active task
     there, clears any stale cancellation marker, and returns
     `{ created, branch, worktree, worktreeAbs, relaunchHint, task }`. **`task` is your full context**
     (description, acceptance criteria, plan + progress, board file path) — capture it and work from
     it; there is nothing else to look up. Keep `worktree` (repo-root-relative, e.g.
     `.worktrees/task-7-add-login`). `cd` into `worktreeAbs` (Bash) and run **all** git / file / test
     commands there; `bun install` once if `node_modules` is absent. Because _you_ called `start_task`,
     this session's MCP is rooted in the **primary** tree no matter where the shell now is — so the
     active-task marker it seeded lives in the worktree you cannot read from here, and you close with
     **`request_merge { taskId, worktree }`** (step 7). Optionally you may instead surface
     `relaunchHint` and stop, letting the human relaunch a session inside `worktreeAbs` — but if you
     continue here, the `worktree` target is mandatory.

   - **Never** `git checkout`, `commit`, or `merge` in the repository root — it is shared with other
     agents and a managed pre-commit hook blocks it. All git / file / test commands run in the worktree.

3. **Claim.** Call `claim_task` with your task ID. This places the advisory claim AND
   automatically advances the task status from the board's first configured status (typically
   "To Do") to its second (typically "In Progress"), so the board immediately shows someone is
   working on it. If the task is already past the first status the status is left unchanged.
   A successful claim also returns **`task`** — the same full context `start_task` gives you, freshly
   read after the claim write. If you skipped `start_task` (a dispatched session), this is where your
   context comes from. On a synced board a claim may **surrender** if another session already holds it
   (`surrendered: true, heldBy`, and no context); if so, stop and pick a different task with the user.

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
   surprises) and, when done, a final summary. Finishing is `request_merge`'s job — it marks the
   task Done on the board and leaves it there, in `tasks/`, still visible.

6. **Cancellation checkpoint (mandatory before closing).** Before `request_merge` — and between major
   steps — run the cancellation check (below). If cancelled, **stop; do not `request_merge`**.

7. **Close.** When the work is committed and the worktree is clean, close through the merge queue:
   - If you were **dispatched** (the session launched inside the worktree), call `request_merge` from
     inside the worktree.
   - If **you** called `start_task` in this session, call **`request_merge { taskId, worktree }`**,
     passing the repo-root-relative `worktree` that `start_task` returned (e.g.
     `.worktrees/task-7-add-login`). The `worktree` target tells `request_merge` which linked worktree
     to rebase/verify/merge — without it the call aborts with **`wrong_root`**, because the MCP is
     rooted in the primary tree however far the shell has `cd`'d. A `wrong_root` abort is a **misuse,
     not a cancellation**: re-issue the same call _with_ the `worktree` target; never abandon the work
     over it.
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

   **Side work with no task? `request_branch_merge`, never a manual merge.** If a branch you need to
   land has no board task — a dev/scratch worktree you spun up, a multi-phase branch that predates the
   board — do **not** `git merge` it in the repository root (that skips verify, skips the queue's
   right-of-way, and trips the merge-without-review guardrail). Call
   **`request_branch_merge { worktree }`**: the identical pipeline (rebase → verify → the same merge
   queue → manual-review gate → ff-merge) with the same abort codes, but no board writes, and your
   worktree and branch survive the merge unless you pass `removeWorktree: true`. Your own task still
   closes with `request_merge` — this is for the work the board never knew about.

## Cancellation contract

A dispatch can be cancelled from the board while you work. Cancellation is **task/worktree-scoped**,
never signalled through the drifting active task. At each checkpoint treat **either** of these as
cancelled (both are first-class — neither is "primary"):

- **Marker present** — `test -f .taskwright/cancelled` in your worktree succeeds. Detection is
  **presence-only**: never read or parse the file's contents.
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", or `request_merge { worktree }` aborting because the
  target worktree is no longer listed). On POSIX the marker is deleted along with the worktree, so this
  is the reliable signal there; on Windows the marker may survive a busy removal.

A **`wrong_root`** abort is NOT cancellation — it means you called `request_merge` bare from a
primary-rooted session. The worktree is fine and the work is intact: re-issue the call with the
`worktree` target (step 7).

On cancellation: **stop immediately, do NOT `request_merge`**, leave a short note via `edit_task` if
the task is still reachable, and exit (release your working directory). Do **not** remove the worktree
yourself — the extension owns teardown.

## Rules of thumb

- One session = one task; hold the task ID from step 1 and never re-derive it.
- Your task context comes from `start_task` / `claim_task` (or one `get_active_task`) — **never** from
  the file tree. No `ls backlog/tasks/`, no globbing for the task file: in `git-auto` mode the board
  does not live under the repo root at all.
- Get into the worktree before doing work — with `cd` / `git -C`, **never** a harness worktree-switch
  tool (`EnterWorktree`): dispatched ⇒ you are already there; otherwise ⇒ `start_task`, `cd` in, and
  close with `request_merge { taskId, worktree }`.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close through the merge queue from the worktree; never commit/merge from the repo root. A branch
  with no board task closes the same way, through `request_branch_merge { worktree }`.
