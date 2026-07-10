---
name: orchestrate-board
description: Autonomously run the full Taskwright cycle for MANY ready tasks — either self-driven sequentially, or by dispatching parallel in-session subagents (one per independent ready task, each bootstrapping its own worktree and running /execute-task to Done). Use when the user says /orchestrate-board, or asks you to "work through the board", "clear the ready tasks", "run all the ready work", or "drive the board autonomously". Not for a single task (use /execute-task) or authoring new work (use /create-task). Subscription-safe: in-session subagents via the Task tool, never `claude -p`.
allowed-tools: mcp__taskwright__next_ready_tasks, mcp__taskwright__start_task, mcp__taskwright__claim_task, mcp__taskwright__release_task, mcp__taskwright__get_board, mcp__taskwright__get_active_task, mcp__taskwright__request_merge, Task, Skill(execute-task), Bash, Read, Grep, Glob
---

# Orchestrate board (Taskwright autonomous run)

Drive the whole Taskwright board, not one task: repeatedly pull the **ready** tasks, run each end
to end in its own isolated worktree (yourself sequentially, or via parallel in-session subagents),
and stop on a clear condition. Parity: every step is one a human can drive from the board (Dispatch
/ Claim / Request merge) — you are automating the _sequence across many tasks_, not bypassing review
or the merge queue. Each individual task is still executed by `/execute-task`; this skill is the loop
around it.

## When to use

- The user invokes `/orchestrate-board`, or asks you to work through / clear / drive / burn down the
  board's ready tasks.
- Best when several tasks are ready and independent and the user wants them all taken to Done.
- **Not** for a single task — use `/execute-task`. **Not** for authoring or decomposing new work —
  use `/create-task`. This skill only _runs existing ready tasks_.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any headless
agent. Parallelism is **in-session subagents** dispatched with the built-in `Task` tool; each subagent
invokes `/execute-task`, which also runs in-session. All other mechanism is the `taskwright` MCP tools
plus local Bash/Read/Grep/Glob.

## Key facts you rely on

- **The ready set is dependency-independent — but not necessarily FILE-independent.**
  `next_ready_tasks` returns only tasks whose _every_ dependency is Done, so two returned tasks can
  never depend on each other and are safe to run **concurrently** as far as _ordering_ goes. They can
  still edit the **same files**, which collides at merge time. So for the parallel batch, pull it with
  **`next_ready_tasks { parallelSafe: true, limit: cap }`** — it returns only tasks whose attached-plan
  file footprints are pairwise disjoint (a task with no plan / unknown footprint comes back solo). The
  orchestrator thereby AVOIDS most conflicts; any that still slip through (an under-declared footprint)
  are the dispatched agent's to resolve during `request_merge`'s rebase.
- **The merge queue serializes merges for you.** Each task's `/execute-task` closes with
  `request_merge`, which waits its turn in the shared merge queue and merges under right-of-way. You
  never order merges yourself — parallel workers do their _work_ concurrently and their _merges_
  serialize automatically.
- **Claims are advisory and are your anti-collision guard.** `next_ready_tasks` already excludes
  tasks a live session holds or that are active in the merge queue. Every worker still **claims before
  working**; a surrendered claim means another session took it — skip, do not do the work.

## Establish mode and budget (once, up front)

- **Mode.** Default **parallel** when a round has ≥ 2 ready tasks; **self-driven sequential** when a
  round has 1 task, or the user asked for one-at-a-time / conservative / low-resource. If unclear, ask.
- **Parallelism cap.** Default **3** subagents per round (each runs real builds/tests; the merge queue
  serializes merges anyway). Honor a user override ("up to N at a time", "one at a time").
- **Budget.** Note any user cap: max tasks, max rounds, "just what's ready now", or unbounded until the
  board drains. If none is given, run until a stop condition (below) fires.

## The loop

Repeat rounds until a stop condition fires:

1. **Pull ready tasks.** In **sequential** mode call `next_ready_tasks` (the full ordered ready set;
   pass `limit` from the budget if set). In **parallel** mode call
   `next_ready_tasks { parallelSafe: true, limit: cap }` — it returns a conflict-safe batch (tasks with
   pairwise-disjoint file footprints), already sized to the fan-out cap. Each row is a ready,
   unclaimed, unblocked, not-in-queue task, ordered by priority then ordinal.

2. **Check stop conditions.** If the ready set is **empty**, decide which stop applies:
   - Call `get_board`. If it shows **no** non-Done tasks → **Drained**: report Done and stop.
   - If non-Done tasks remain but are all `locked`/blocked by not-yet-Done dependencies and nothing is
     in flight → **All-blocked**: report the blocked frontier (which tasks, blocked by what) and stop.
     Otherwise (ready set non-empty) continue.

3. **Choose the batch.** In **parallel** mode, the `parallelSafe` call in step 1 already returned a
   conflict-safe, cap-sized batch — dispatch exactly those. In **sequential** mode take the single top
   task. Tasks left out of this round (overlapping footprints, or beyond the cap) refresh back into
   `next_ready_tasks` next round — once a batch member merges, the files it held are free.

4. **Run the batch.**
   - **Parallel:** issue one `Task` subagent per batch task **in a single response** (concurrent),
     each with the subagent prompt below (substitute `{{taskId}}` / `{{title}}`). Await all results.
   - **Sequential:** for the one task, do it inline — `start_task`, `cd` into its `worktreeAbs`,
     `bun install` if `node_modules` is absent, then invoke `/execute-task` for that task ID (which
     claims, does the work, and closes with `request_merge`). Do **not** commit/merge from the repo
     root yourself.

5. **Reconcile results.** For each runner's returned status:
   - `done` → count it; its dependents may now be ready.
   - `pending` → the task's `request_merge` hit its `waitMinutes` bound while parked in the merge
     queue (usually awaiting human approval in manual-review mode). **Not a failure**: the work is
     committed and verified, and the queue entry is kept. Do NOT `release_task` and do NOT
     re-dispatch. Park it on a pending list (task ID + `ticket` + worktree) and on later rounds — or
     at the end of the run — resume it from this session with
     `request_merge { taskId, worktree, ticket, waitMinutes }`: the resume is idempotent (no
     re-enqueue; verify is skipped when the base has not moved). A `sent_back` on resume means a
     reviewer sent it back while parked — surface it like a failure (the board already reset it to
     In Progress). Pending tasks count as **in flight** for the stop conditions, not blocked.
   - `surrendered` → another session held it; skip (not a failure).
   - `cancelled` → a human cancelled the dispatch; note it and do not retry (the extension already
     tore the worktree down and released the claim).
   - `failed` (or a crash with no status) → **surface** the task ID and reason to the user, then call
     `release_task` for it defensively so it returns to the ready pool. **Do not auto-retry** unless
     the user opted into retries.

6. **Progress guard.** If this round produced **zero** `done` and the ready set is unchanged
   (everything failed/surrendered), **stop** and report the stuck frontier — do not loop forever.

7. **Budget + refresh.** Decrement the budget; if exhausted, stop and report what is still ready.
   Otherwise loop to step 1 — merged tasks have unlocked their dependents, so the next ready set may
   be larger.

Finish with a summary: tasks taken to **Done**, tasks **failed/surfaced** (with reasons), the
**blocked frontier** if any, and remaining budget.

## Subagent prompt template (parallel mode)

Dispatch one `Task` subagent per batch task with **exactly** this prompt (self-contained — the
subagent inherits none of your context). Substitute `{{taskId}}` and `{{title}}`:

```
You are an autonomous Taskwright task runner. Execute EXACTLY ONE task end to end, in its own
isolated git worktree, then report back. You share the repository with other agents: never touch
another task, and never git checkout / commit / merge in the repository root (a pre-commit hook
blocks it). Subscription safety: run entirely in-session — NEVER spawn `claude -p` or any headless
agent.

TASK: {{taskId}} — {{title}}

Do this, in order:
1. Bootstrap the worktree. Call the taskwright MCP tool `start_task` with { "taskId": "{{taskId}}" }.
   It returns { worktree, worktreeAbs, branch } and seeds this task as the worktree's active task.
   `cd` into `worktreeAbs` (Bash). If `node_modules` is absent there, run `bun install` once.
2. Claim it. Call `claim_task` with { "taskId": "{{taskId}}" }. If the result has
   `surrendered: true`, STOP immediately and report {"status":"surrendered","taskId":"{{taskId}}"}
   — another session already holds it; do NOT do the work.
3. Execute. Invoke the `/execute-task` skill for {{taskId}}. It picks the right strategy (attached
   plan / independent subtasks / TDD), does the work in this worktree, records progress with
   `edit_task`, and closes by calling `request_merge` from inside the worktree — which rebases, runs
   the verify gate, waits its turn in the shared merge queue, fast-forward-merges, marks the task
   Done, and removes the worktree.
4. If `/execute-task` stops for cancellation (the worktree's `.taskwright/cancelled` marker is
   present, or the worktree vanished), do NOT `request_merge`; report
   {"status":"cancelled","taskId":"{{taskId}}"}.
5. On any unrecoverable failure (a verify gate you cannot make pass, an unresolvable rebase conflict,
   a crash), call `release_task` with { "taskId": "{{taskId}}" } so the task returns to the ready
   pool, and report {"status":"failed","taskId":"{{taskId}}","reason":"<one line>"}.
6. If `request_merge` returns {"status":"pending", ...} (a bounded wait expired while parked in the
   merge queue), that is NOT a failure: do NOT `release_task`, do NOT retry the work. Report
   {"status":"pending","taskId":"{{taskId}}","ticket":"<ticket>","worktree":"<worktree>"} so the
   orchestrator can resume the merge later.

Return ONLY a compact JSON object:
{"status":"done"|"failed"|"surrendered"|"cancelled"|"pending","taskId":"{{taskId}}","summary":"<1-2 sentences>"}
```

In **self-driven sequential** mode you perform these same five steps inline for the one task, instead
of handing them to a subagent.

## Rules of thumb

- One round = pull ready → run a batch → reconcile → refresh; loop until a stop condition.
- The ready set is dependency-independent; for the parallel batch use `next_ready_tasks { parallelSafe:
true, limit: cap }` so co-dispatched tasks are also FILE-disjoint (avoid merge conflicts). Cap the
  fan-out (default 3), don't swarm. Any conflict that still slips through is the agent's to rebase away.
- Claim before work; a surrendered claim means skip, never double-execute.
- Let `request_merge` (inside `/execute-task`) serialize merges — never order merges yourself.
- Failures: surface + `release_task` + move on; no auto-retry unless the user asks.
- `pending` is not a failure: keep the ticket, never release/re-dispatch, resume the merge later with
  `request_merge { taskId, worktree, ticket }`.
- Stop on drained / all-blocked / user budget / no-progress — and always report what remains.
- Subscription-safe: parallelism is `Task` subagents in-session; never `claude -p`.
