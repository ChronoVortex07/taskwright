# `/orchestrate-board` Skill (self-driven or parallel subagents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author a `/orchestrate-board` skill so any Claude session can autonomously run the full Taskwright cycle for **many** ready tasks — either self-driven sequentially, or by dispatching parallel **in-session** subagents (one per independent ready task, each bootstrapping its own worktree and running `/execute-task` to Done) — honoring advisory claims, letting the shared merge queue serialize actual merges, and stopping on a clear set of conditions.

**Architecture.** This is a **skill-authoring** deliverable: one prose skill (`.claude/skills/orchestrate-board/SKILL.md`) that composes tools shipped by earlier drafts (`next_ready_tasks`, `start_task`, `/execute-task`, `request_merge { worktree }`) plus `claim_task` / `get_board` / `get_active_task` and the built-in **Task** tool (in-session subagents — subscription-safe, never `claude -p`). No new source core or MCP tool is added — the only runtime mechanism the skill needs already exists in the locked cross-task contracts, and the orchestration decisions (parallelism degree, failure reconciliation, stop conditions) are policy the LLM follows from the skill's prose, not code. The skill matches the house format of `.claude/skills/{create-task,execute-task,index-codebase}/SKILL.md` (YAML frontmatter, "When to use", "Subscription safety", "The loop", "Rules of thumb").

**Tech Stack:** Markdown skill file (`.claude/skills/orchestrate-board/SKILL.md`) with YAML frontmatter; composes the `taskwright` MCP tools + the `execute-task` skill + the built-in `Task` tool. Regression-gated by the repo's existing Bun toolchain (Vitest / ESLint / tsc / Playwright); no new test file is added (skills are prose, validated by review + an embedded scenario self-check walkthrough — the same validation approach P4/P5/P6 used for their skills).

---

## Prerequisites

This draft is **blocked** by the tools it composes. Carve this worktree **AFTER** all of the following land on `main` and the **primary** checkout is rebuilt (the `taskwright` MCP server in any worktree runs the primary's `dist/mcp/server.js`, so a composed tool is only live after its draft merges + the primary rebuilds):

- **DRAFT-5 — `next_ready_tasks`** MCP tool (pure core `src/core/readyTasks.ts` → `selectReadyTasks`). The skill's round-driver. **MUST be merged first.**
- **DRAFT-7 — `/execute-task` from any session.** The execution primitive each task runs. DRAFT-7 removes `/execute-task`'s "session MCP must be worktree-rooted" requirement so it can execute a named task in its worktree from any session (self-driven or subagent). **MUST be merged first.**
- **DRAFT-3 — `start_task`** MCP tool (pure core `src/core/startTask.ts` → `bootstrapTaskWorktree`). Bootstraps a task's `.worktrees/<branch>` and seeds its active task. Composed by the subagent prompt and the self-driven path.
- **DRAFT-4 — `request_merge` gains optional `worktree?`.** Lets `/execute-task` close a specific worktree from a session not rooted in it. Composed transitively via `/execute-task`.

**Carve this worktree AFTER those land so their code is present** (`next_ready_tasks`, `start_task`, `/execute-task`, and the `request_merge { worktree }` overload must all exist and be built into the primary before the self-check walkthrough in Task 1 can exercise them). This plan touches **no** source that DRAFT-3/4/5/7 modify — it adds one skill file and one CLAUDE.md bullet — so there is no merge-conflict surface with them; the dependency is purely that the composed tools must be **live** for the walkthrough.

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit with `--no-verify`** (the repo's lint-staged pre-commit hook flips the whole tree CRLF->LF on Windows). Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

---

## Locked names & wire conventions (from the cross-task contracts — do not rename)

The skill is prose, but it invokes these tools by their exact names and shapes. Transcribe them verbatim into the skill:

- **`next_ready_tasks`** (DRAFT-5): input `{ limit?: number; category?: string; milestone?: string }`; output `TaskSummary[]` (identical shape to `get_board` rows — `{ id, title, status, priority, category, milestone, type, causedBy, dependencies, blockedBy, locked, draft }`) filtered to **READY** = status not Done AND every dependency Done AND not claimed by a live (non-stale) session AND not locked/blocked AND not currently active in the merge queue; ordered by priority (high > medium > low) then ordinal. This is the round driver.
- **`start_task`** (DRAFT-3): input `{ taskId: string }`; output `{ created: boolean; taskId: string; branch: string; worktree: string /* repo-root-relative, e.g. ".worktrees/task-7-add-login" */; worktreeAbs: string; relaunchHint: string }`. Bootstraps `.worktrees/<branch>` and seeds the task's active-task pointer.
- **`request_merge` with optional `worktree?: string`** (DRAFT-4): a branch name OR a repo-root-relative `.worktrees/<branch>` path; when present, the merge runs against that linked worktree from a session not rooted in it. Invoked **by `/execute-task`**, not directly by the orchestrator.
- **`/execute-task`** skill (DRAFT-7, "from any session"): executes exactly one task in its worktree end-to-end — claim → adaptive strategy → record → close via `request_merge` — and (per DRAFT-7) no longer requires the invoking session's MCP to be worktree-rooted.
- **`claim_task`** (existing): input `{ taskId }`; output `ClaimResult` with `{ claimed, surrendered?, heldBy?, locked?, blockedBy? }`. Advisory claim (see CLAUDE.md); `surrendered: true` means another live session already holds it.
- **`get_board`** (existing): `{ category?, milestone?, status? }` → `BoardTaskSummary[]` — used to evaluate stop conditions (drained vs all-blocked).
- **`Task`** tool (built-in): spawns an **in-session** subagent. Multiple `Task` calls in one response run **concurrently**; the orchestrator receives all results when they complete. **Subscription-safe — never `claude -p`.**
- **Merge queue** (`src/core/mergeQueue.ts`, existing): already serializes actual merges and enforces right-of-way. `request_merge` (inside `/execute-task`) blocks for its turn. The orchestrator does **not** manage merge ordering.
- **Skill file** (DRAFT-8, this task): `.claude/skills/orchestrate-board/SKILL.md`, `name: orchestrate-board` (chosen to avoid clashing with the claude-harness `/orchestrate` deepseek-worker skill — do **not** trigger on the bare word "orchestrate").

---

## Design

The task focus mandates that this section resolve four questions. These are **policy** the skill's prose encodes (the orchestrator is an LLM following the skill); none require new code.

### D1 — Degree of parallelism

- **The ready set is provably mutually independent.** `next_ready_tasks` returns only tasks whose *every* dependency is Done. If two returned tasks A and B had a dependency edge A→B, then B could only be ready if A were Done — but A appears in the set precisely because it is *not* Done. Contradiction. Therefore **no two tasks in one `next_ready_tasks` result depend on each other**, and the whole set is safe to run concurrently. No per-pair independence computation is needed (unlike the SDD subtask check inside `/execute-task`).
- **Cap, not swarm.** Each runner does real builds/tests (`bun install`, `bun run test`), which are CPU/disk-heavy, and merges serialize in the queue regardless — so beyond a small fan-out the wall-clock gain flattens while contention rises. Default **`MAX_PARALLEL = 3`** subagents per round. The user may override ("run up to N at a time", "one at a time" → sequential). If the ready set is larger than the cap, the extra tasks wait for the next round (they refresh into `next_ready_tasks` because they were neither dispatched nor claimed).
- **Mode selection.** Default: **parallel** when the round's batch has ≥ 2 tasks and the user did not ask for sequential; **self-driven sequential** when the batch is 1 task, or the user asked for conservative / one-at-a-time / low-resource execution. Both modes run the identical per-task sequence (`start_task` → worktree deps → `/execute-task` → `request_merge`); the only difference is whether the orchestrator runs it inline (sequential) or hands it to a `Task` subagent (parallel).

### D2 — Failure & retry

- Each runner can end in one of four states, reported as a compact JSON status: **done** (merged), **failed** (an unrecoverable error — a verify gate it cannot make pass, an unresolvable rebase conflict, a crash), **surrendered** (its `claim_task` returned `surrendered: true` — someone else already held it), or **cancelled** (the worktree's `.taskwright/cancelled` marker appeared or the worktree vanished — a human cancelled the dispatch).
- **No auto-retry by default.** A `failed` task usually needs human eyes; silently re-running it risks a loop that burns budget. The orchestrator **surfaces** the failure (task ID + the runner's returned reason/summary) and **moves on** to the next task. The user may opt into "retry failed tasks once" — but the default is surface-and-continue.
- **Never leak a claim.** The runner releases its claim on failure (`release_task`); the orchestrator **defensively** calls `release_task` for any task whose subagent reported `failed` (or crashed without a status), so the task returns to the ready pool for a human or a later round. `surrendered` needs no release (the runner never held it). `cancelled` needs no release (the extension's Cancel-dispatch teardown already released it).
- **Progress guard.** If a full round completes and produces **zero** `done` tasks while the ready set is unchanged (everything `failed`/`surrendered`), the orchestrator **stops** and reports the stuck frontier — this prevents an infinite no-progress loop.

### D3 — Monitoring subagent completion + merge-queue turns

- **Completion.** The `Task` tool is awaited per batch: issuing N `Task` calls in one response runs them concurrently, and the orchestrator receives **all N returned summaries** when they finish. The orchestrator does **not** poll — it reads each subagent's final JSON status. In self-driven mode there is nothing to monitor (the orchestrator ran the task itself and observed `request_merge` return).
- **Merge-queue turns.** The orchestrator does **not** sequence merges. Each runner's `/execute-task` calls `request_merge`, which enrolls the task in the shared `src/core/mergeQueue.ts` queue, waits for right-of-way, and returns only after the fast-forward merge (or PR) completes. So parallel subagents do their *work* concurrently but their *merges* serialize automatically inside `request_merge` — the orchestrator simply awaits the batch. After a batch returns, the orchestrator re-pulls `next_ready_tasks`: merged tasks have unlocked their dependents, so the next round's ready set may be larger.

### D4 — Stop conditions

The loop stops when **any** holds:

1. **Drained** — `next_ready_tasks` is empty AND `get_board` shows no non-Done work the orchestrator is responsible for → the reachable board is Done. Report and stop.
2. **All-blocked** — `next_ready_tasks` is empty but `get_board` still lists non-Done tasks, all `locked`/blocked by not-yet-Done dependencies, and nothing is in flight → report the blocked frontier (which tasks, blocked by what) and stop.
3. **User budget** — the user capped the run (max tasks, max rounds, max parallel, or "just the currently-ready ones"). Stop when the budget is exhausted; report what remains ready.
4. **No progress** — a full round yielded zero `done` with an unchanged ready set (D2 progress guard). Stop and surface the stuck frontier.

### D5 — Advisory-claim honoring (no collisions)

- Within one orchestrator, a round's batch is a **set** (each ready task dispatched exactly once) — no self-collision. `next_ready_tasks` already excludes tasks claimed by a live session and tasks active in the merge queue, so a task in flight from a prior round is not re-picked.
- Across orchestrators / a concurrent human, the guard is **claim-before-work**: every runner calls `claim_task` **first**; a `surrendered: true` result means stop-and-report (`surrendered`), never do the work. This makes the advisory claim the single point that prevents two sessions executing the same task — exactly the CLAUDE.md model ("a claim only fails if another session already holds the task; pick a different task").

---

## File Structure

**Create:**

- `.claude/skills/orchestrate-board/SKILL.md` — the `/orchestrate-board` skill: the ready-task loop, the two execution modes, the exact subagent prompt template, the claim-before-work rule, failure reconciliation, and the stop conditions.

**Modify:**

- `CLAUDE.md` — add the orchestrate-board bullet after the P6 tech-tree bullet (Task 2).

**Test:**

- None. Skills are prose; validation is review + the embedded scenario self-check walkthrough (Task 1, Step 2). If a future revision adds a consumed source core, unit-test it then — this revision adds none (see Self-Review §2). The per-task verify gate (`bun run test && bun run lint && bun run typecheck`) is a **regression** check that the added Markdown breaks nothing.

---

## Task 1: `.claude/skills/orchestrate-board/SKILL.md` (the skill)

**Files:**

- Create: `.claude/skills/orchestrate-board/SKILL.md`

**Goal:** author the full skill verbatim. It encodes the loop (`next_ready_tasks` → choose mode → run batch → reconcile → refresh → stop), the exact self-contained subagent prompt template, the claim-before-work rule, the failure/surrender/cancel reconciliation, and the D4 stop conditions. Frontmatter matches the house YAML-fence format of `.claude/skills/create-task/SKILL.md:1-5` and `.claude/skills/index-codebase/SKILL.md:1-5`.

- [ ] **Step 1: Create the skill**

Create `.claude/skills/orchestrate-board/SKILL.md` with the exact content below (byte-for-byte — no paraphrase):

```markdown
---
name: orchestrate-board
description: Autonomously run the full Taskwright cycle for MANY ready tasks — either self-driven sequentially, or by dispatching parallel in-session subagents (one per independent ready task, each bootstrapping its own worktree and running /execute-task to Done). Use when the user says /orchestrate-board, or asks you to "work through the board", "clear the ready tasks", "run all the ready work", or "drive the board autonomously". Not for a single task (use /execute-task) or authoring new work (use /create-task). Subscription-safe: in-session subagents via the Task tool, never `claude -p`.
allowed-tools: mcp__taskwright__next_ready_tasks, mcp__taskwright__start_task, mcp__taskwright__claim_task, mcp__taskwright__release_task, mcp__taskwright__get_board, mcp__taskwright__get_active_task, mcp__taskwright__request_merge, Task, Skill(execute-task), Bash, Read, Grep, Glob
---

# Orchestrate board (Taskwright autonomous run)

Drive the whole Taskwright board, not one task: repeatedly pull the **ready** tasks, run each end
to end in its own isolated worktree (yourself sequentially, or via parallel in-session subagents),
and stop on a clear condition. Parity: every step is one a human can drive from the board (Dispatch
/ Claim / Request merge) — you are automating the *sequence across many tasks*, not bypassing review
or the merge queue. Each individual task is still executed by `/execute-task`; this skill is the loop
around it.

## When to use

- The user invokes `/orchestrate-board`, or asks you to work through / clear / drive / burn down the
  board's ready tasks.
- Best when several tasks are ready and independent and the user wants them all taken to Done.
- **Not** for a single task — use `/execute-task`. **Not** for authoring or decomposing new work —
  use `/create-task`. This skill only *runs existing ready tasks*.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any headless
agent. Parallelism is **in-session subagents** dispatched with the built-in `Task` tool; each subagent
invokes `/execute-task`, which also runs in-session. All other mechanism is the `taskwright` MCP tools
plus local Bash/Read/Grep/Glob.

## Key facts you rely on

- **The ready set is mutually independent.** `next_ready_tasks` returns only tasks whose *every*
  dependency is Done. Two returned tasks can never depend on each other (a dependency would keep the
  dependent out of the set), so the whole set is safe to run **concurrently**.
- **The merge queue serializes merges for you.** Each task's `/execute-task` closes with
  `request_merge`, which waits its turn in the shared merge queue and merges under right-of-way. You
  never order merges yourself — parallel workers do their *work* concurrently and their *merges*
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

1. **Pull ready tasks.** Call `next_ready_tasks` (pass `limit` from the budget if set). Each row is a
   ready, unclaimed, unblocked, not-in-queue task, ordered by priority then ordinal.

2. **Check stop conditions.** If the ready set is **empty**, decide which stop applies:
   - Call `get_board`. If it shows **no** non-Done tasks → **Drained**: report Done and stop.
   - If non-Done tasks remain but are all `locked`/blocked by not-yet-Done dependencies and nothing is
     in flight → **All-blocked**: report the blocked frontier (which tasks, blocked by what) and stop.
   Otherwise (ready set non-empty) continue.

3. **Choose the batch.** Take the top `min(readyCount, cap)` tasks — parallel `cap` (default 3), or 1
   in sequential mode. The rest wait for the next round (they refresh back into `next_ready_tasks`).

4. **Run the batch.**
   - **Parallel:** issue one `Task` subagent per batch task **in a single response** (concurrent),
     each with the subagent prompt below (substitute `{{taskId}}` / `{{title}}`). Await all results.
   - **Sequential:** for the one task, do it inline — `start_task`, `cd` into its `worktreeAbs`,
     `bun install` if `node_modules` is absent, then invoke `/execute-task` for that task ID (which
     claims, does the work, and closes with `request_merge`). Do **not** commit/merge from the repo
     root yourself.

5. **Reconcile results.** For each runner's returned status:
   - `done` → count it; its dependents may now be ready.
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

Return ONLY a compact JSON object:
{"status":"done"|"failed"|"surrendered"|"cancelled","taskId":"{{taskId}}","summary":"<1-2 sentences>"}
```

In **self-driven sequential** mode you perform these same five steps inline for the one task, instead
of handing them to a subagent.

## Rules of thumb

- One round = pull ready → run a batch → reconcile → refresh; loop until a stop condition.
- The ready set is mutually independent — the whole batch is safe to parallelize; cap the fan-out
  (default 3), don't swarm.
- Claim before work; a surrendered claim means skip, never double-execute.
- Let `request_merge` (inside `/execute-task`) serialize merges — never order merges yourself.
- Failures: surface + `release_task` + move on; no auto-retry unless the user asks.
- Stop on drained / all-blocked / user budget / no-progress — and always report what remains.
- Subscription-safe: parallelism is `Task` subagents in-session; never `claude -p`.
```

- [ ] **Step 2: Scenario self-check walkthrough (the skill's "test")**

Skills are validated by review + a scenario walkthrough (as P4/P5/P6 did). Trace the skill against these five scenarios and confirm each holds; record the walkthrough in the task's implementation notes via `edit_task`. This is the falsification pass — if any trace diverges, the skill prose is wrong and must be fixed before commit.

- **S1 — N ready tasks reach Done sequentially.** Board has TASK-A, TASK-B, TASK-C, all ready, user asked "one at a time". Round 1: `next_ready_tasks` → [A, B, C]; sequential mode, batch = [A]; `start_task(A)` → cd → `bun install` → `/execute-task` for A → `request_merge` merges A → Done. Round 2: `next_ready_tasks` → [B, C] (A is Done, dropped); batch = [B] → Done. Round 3: [C] → Done. Round 4: `next_ready_tasks` → [] and `get_board` shows no non-Done work → **Drained**, stop. ✅ Three tasks reach Done; loop terminates cleanly.
- **S2 — Independent tasks run as parallel subagents in separate worktrees, no claim collision, queue-serialized merges.** Board has TASK-A, TASK-B, TASK-C, all ready and independent (guaranteed by the ready-set invariant). Round 1: `next_ready_tasks` → [A, B, C]; parallel mode, cap 3, batch = [A, B, C]; three `Task` subagents dispatched **in one response**. Each runs `start_task` → a **distinct** `.worktrees/<branch>` (distinct `dispatchBranchName` per task) → `claim_task` (distinct task IDs → no collision; each returns `claimed: true`) → `/execute-task` → `request_merge`. The three `request_merge` calls enter the shared merge queue; the queue grants right-of-way to one at a time, so the merges **serialize** even though the work ran concurrently. All three return `done`. Round 2: `next_ready_tasks` → [] → **Drained**, stop. ✅ Parallel work, isolated worktrees, no claim collision, serialized merges.
- **S3 — Blocked tasks are skipped.** Board has TASK-A (ready) and TASK-D (depends on A, not Done). Round 1: `next_ready_tasks` → [A] only — D is excluded because its dependency A is not Done. Batch = [A] → Done. Round 2: `next_ready_tasks` → [D] — A is now Done, so D became ready and surfaces automatically. Batch = [D] → Done. Round 3: [] → **Drained**. ✅ D never runs before A; it appears only once unblocked, without any special handling in the skill.
- **S4 — Never `claude -p`.** Every execution path is a `Task` subagent (in-session) invoking `/execute-task` (in-session), or the orchestrator running `/execute-task` inline. The `allowed-tools` list contains `Task`, `Skill(execute-task)`, the `taskwright` MCP tools, and Bash/Read/Grep/Glob — **no** headless-invocation surface. The subagent prompt explicitly forbids `claude -p`. ✅ Subscription-safe.
- **S5 — Failure & surrender reconciliation.** A parallel batch = [A, B, C]. A returns `done`; B returns `failed` (its verify gate would not pass); C returns `surrendered` (a human had already claimed it from another worktree). Reconcile: A counted Done; B → surface "TASK-B failed: <reason>" + `release_task(B)` (returns to the ready pool for a human), no auto-retry; C → skip (not a failure). Next round: `next_ready_tasks` may re-surface B (now released) — if the user did not opt into retries the orchestrator has already surfaced it and, on a second identical failure with an unchanged ready set and zero `done`, the **no-progress guard** stops the loop. ✅ No dangling claim, failure surfaced, no infinite loop.

- [ ] **Step 3: Sanity-check the skill loads**

Confirm the frontmatter parses (YAML fence; `name` / `description` / `allowed-tools`), the `name` is `orchestrate-board` (not the bare `orchestrate`), and every `allowed-tools` entry matches a real tool: the `taskwright` MCP tool names (`mcp__taskwright__next_ready_tasks`, `mcp__taskwright__start_task`, `mcp__taskwright__claim_task`, `mcp__taskwright__release_task`, `mcp__taskwright__get_board`, `mcp__taskwright__get_active_task`, `mcp__taskwright__request_merge`), the built-in `Task` tool, `Skill(execute-task)`, and `Bash`/`Read`/`Grep`/`Glob`. No test — skills are prose, validated by Step 2's walkthrough.

- [ ] **Step 4: Full task gate**

Run in the worktree: `bun run test && bun run lint && bun run typecheck` → PASS (skill-only; the gate is a regression check that the added Markdown breaks nothing — expect the same pass count as the baseline recorded at branch base, minus the ~22 known Windows POSIX-path failures).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/orchestrate-board/SKILL.md
git commit --no-verify -m "feat: /orchestrate-board skill (self-driven or parallel subagents)

- .claude/skills/orchestrate-board/SKILL.md: a round loop that pulls next_ready_tasks,
  runs each ready task to Done either self-driven sequentially or via parallel in-session
  Task subagents (one per independent task), each bootstrapping its own worktree with
  start_task and running /execute-task -> request_merge
- ready set is provably mutually independent (deps-Done invariant), so the whole batch
  parallelizes safely; cap default 3; merges serialize in the shared merge queue
- claim-before-work anti-collision (surrendered => skip); failure => surface + release +
  move on (no auto-retry); stop on drained / all-blocked / budget / no-progress
- exact self-contained subagent prompt template; subscription-safe (Task subagents,
  never claude -p)

Completes DRAFT-8.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** DRAFT-5 (`next_ready_tasks`), DRAFT-7 (`/execute-task` from any session), DRAFT-3 (`start_task`), DRAFT-4 (`request_merge { worktree }`) — all must be merged and the primary rebuilt so the composed tools are live for Step 2's walkthrough.

---

## Task 2: Docs — CLAUDE.md bullet + AGENTS.md verify + full gate + close

**Files:**

- Modify: `CLAUDE.md`
- Review only: `AGENTS.md`

**Goal:** doc-sync the phase. Add a CLAUDE.md bullet for the orchestrate-board skill in the tech-tree list, confirm AGENTS.md needs no change (the skill is auto-discovered from `.claude/skills/` and adds no new task-workflow rule), run the full gate, and close via `request_merge` from inside the worktree (this is a normal dispatched PR — unlike the P5 orchestrator-run plan, there is no external landing agent).

- [ ] **Step 1: CLAUDE.md — add the orchestrate-board bullet**

In `CLAUDE.md`, add the bullet immediately after the P6 tech-tree bullet closes and before `## Conventions`. The P6 bullet ends with the line:

```markdown
  `docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md`.
```

Insert **after** that line (and its following blank line, before `## Conventions`) this new bullet, matching the existing bullets' density/style:

```markdown
- **Board orchestration — `/orchestrate-board` skill** ✅: an `/orchestrate-board` **skill**
  (`.claude/skills/orchestrate-board/SKILL.md`) drives the whole board autonomously — a round loop
  that pulls `next_ready_tasks`, then runs each ready task to Done either **self-driven sequentially**
  or by dispatching **parallel in-session `Task` subagents** (one per independent ready task), each
  bootstrapping its own worktree via `start_task` and running `/execute-task` → `request_merge`. The
  ready set is **provably mutually independent** (every dependency Done ⇒ no intra-set edge), so the
  whole batch parallelizes safely; fan-out is capped (default 3) and the shared merge queue
  (`src/core/mergeQueue.ts`) serializes the actual merges — the orchestrator never orders merges.
  **Claim-before-work** is the anti-collision guard (a `surrendered` claim ⇒ skip, never
  double-execute); a **failure** is surfaced + `release_task` + move-on (no auto-retry by default);
  the loop **stops** on drained / all-blocked / user budget / no-progress. Subscription-safe —
  parallelism is in-session subagents via the `Task` tool, never `claude -p`. Composes DRAFT-5
  (`next_ready_tasks`), DRAFT-3 (`start_task`), DRAFT-7 (`/execute-task` from any session), and
  DRAFT-4 (`request_merge { worktree }`). Plan:
  `docs/superpowers/plans/2026-07-08-orchestrate-board-skill.md`.
```

- [ ] **Step 2: AGENTS.md — no change needed (verify)**

`AGENTS.md` already encodes the single-task workflow (`get_active_task` → claim → work → `request_merge`, stay in your worktree, no root commits). `/orchestrate-board` is a **loop around** that workflow and adds no new per-task rule; skills are auto-discovered from `.claude/skills/`. Grep `AGENTS.md` for "orchestrat" and "parallel" to confirm nothing stale contradicts the skill; the default is **no AGENTS.md edit**. If a genuinely misleading line exists, note it to the user rather than editing in this PR.

- [ ] **Step 3: Full gate**

Run in the worktree:

```bash
bun run build && bun run test && bun run lint && bun run typecheck
```

Expected: PASS. Record the totals against the branch-base baseline captured at the start; docs-only change, so the counts match the baseline (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix"). No webview/CDP change lands in this PR, so `bun run test:playwright` / `bun run test:cdp` are optional regression only.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit --no-verify -m "docs: CLAUDE.md bullet for the /orchestrate-board skill

- CLAUDE.md: board-orchestration bullet (self-driven or parallel subagents; ready-set
  independence; capped fan-out; merge-queue-serialized merges; claim-before-work;
  failure = surface + release + move on; drained/all-blocked/budget/no-progress stops)
- AGENTS.md unchanged: /orchestrate-board loops the existing single-task workflow and is
  auto-discovered from .claude/skills/

Completes DRAFT-8.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

- [ ] **Step 5: Close via `request_merge`**

When both commits are in and the worktree is clean (`git status` shows nothing uncommitted), call `request_merge` from **inside this worktree** and wait for it to return. It rebases onto the base branch, runs the verify gate, waits its turn in the shared merge queue (and, in manual-review mode, for the human's approval on the board), fast-forward-merges, and marks DRAFT-8's task **Done**. Do **not** ff-merge or push from the repo root yourself.

**Dependencies:** Task 1 (the skill must exist for the CLAUDE.md bullet to describe it).

---

## Self-Review

**1. Spec coverage (task focus → plan):**

- **Item 4b — author `/orchestrate-board` for many tasks, self-driven OR parallel subagents** → Task 1 (the full SKILL.md with both modes).
- **Design section resolving parallelism / failure-retry / monitoring / stop conditions** → the **Design** section (D1–D5): D1 parallelism (mutual-independence proof + cap 3 + mode selection), D2 failure/retry (surface + release + no auto-retry + progress guard), D3 monitoring (await the `Task` batch; merges serialize inside `request_merge`), D4 stop conditions (drained / all-blocked / budget / no-progress), D5 advisory-claim anti-collision.
- **Composed tools** (`next_ready_tasks`, `start_task`, `/execute-task`, `request_merge { worktree }`, `claim_task`/`get_board`/`get_active_task`, the `Task` tool) → transcribed in **Locked names & wire conventions** and used in the skill by exact name/shape.
- **Exact subagent prompt template + claim-before-work rule + failure reconciliation** → in the skill's "Subagent prompt template" and "The loop" §5, and Design D2/D5.
- **Grounding reads** (create-task/execute-task SKILL.md house format; mergeQueue.ts; TaskSummary/get_board shapes; the advisory-claim + AGENTS.md workflow) → done during authoring; the merge-queue-serializes and ready-set-independence facts come straight from `src/core/mergeQueue.ts` and the DRAFT-5 READY definition.
- **Testing** (self-check walkthrough proving the four required scenarios + surrender/failure) → Task 1 Step 2, S1–S5. "Composed tools only live after DRAFT-3/4/5/7 merge + primary rebuild" → stated in **Prerequisites** and Task 1's dependency note.

**2. Why no source core / MCP tool (scope honesty):** the task focus says a helper core is *optional* ("if you add a tiny helper core…"). A skill is prose an LLM follows; its only runtime mechanism is the MCP tools + the `Task` tool, all of which the locked contracts already deliver (DRAFT-3/4/5/7). The one non-trivial decision — "which ready tasks are independent enough to parallelize" — is **eliminated by the ready-set invariant** (Design D1), not computed. Adding a core would have **no runtime consumer** (or would require a new MCP tool, which exceeds the locked DRAFT-8 contract of exactly `.claude/skills/orchestrate-board/SKILL.md`). So this revision adds none, and the plan says so explicitly rather than inventing a placeholder core.

**3. No placeholders:** the complete SKILL.md is shown verbatim (frontmatter + loop + subagent prompt template + rules); the CLAUDE.md bullet is shown verbatim with its exact insertion anchor (the P6 bullet's closing line, verified at `CLAUDE.md:232`, before `## Conventions` at `:234`); both commit messages are complete. No "TBD", no "similar to above", no undefined tool or type.

**4. Type/name consistency:** the skill's `allowed-tools` names match the registered `taskwright` MCP tools and the locked tool names (`next_ready_tasks`, `start_task`, `claim_task`, `release_task`, `get_board`, `get_active_task`, `request_merge`); `ClaimResult.surrendered` / `heldBy` (verified at `src/mcp/handlers.ts:143-157`) drive the surrender path; `start_task`'s `{ worktree, worktreeAbs, branch }` output (locked contract) is used exactly; the skill `name: orchestrate-board` matches the DRAFT-8 locked path and deliberately avoids the bare `orchestrate` trigger.

**5. Parity & subscription safety:** every step maps to a human board action (Dispatch → `start_task`; Claim → `claim_task`; Request merge → `request_merge` inside `/execute-task`); parallelism is in-session `Task` subagents; the subagent prompt forbids `claude -p`; S4 confirms no headless surface. The orchestrator never merges/commits from the repo root — each task closes through its own `/execute-task` + the shared merge queue.

**6. Build integrity:** Task 1 adds one Markdown file (no code path touched) and self-validates via the S1–S5 walkthrough; Task 2 adds one CLAUDE.md bullet and closes via `request_merge`. Each task's gate (`bun run test && bun run lint && bun run typecheck`) is a green-at-every-commit regression check. The plan carves **after** DRAFT-3/4/5/7 land so the composed tools are live for the walkthrough, and touches none of their files — zero conflict surface.
