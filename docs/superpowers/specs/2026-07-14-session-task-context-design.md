# TASK-129 — Full task context from start_task/claim_task + a session-claim fallback for get_active_task

## The friction

In the Jul 13 `/orchestrate-board` run, 9 of 11 self-bootstrapping subagents called `get_active_task`
right after their own `start_task` / `claim_task` and got `{"active": false}` every time.

The cause is structural, not a bug:

- `start_task` seeds the active-task marker **into the new worktree** (`<worktree>/.taskwright/active-task.json`),
  because that is where a *relaunched* session would read it.
- But the calling session's MCP server is rooted in the **primary** tree and cannot re-root
  (`server.ts` binds `TASKWRIGHT_ROOT || cwd` once at launch). `get_active_task` reads
  `readActiveTask(deps.root)` — the primary root — where nothing was ever written.

So the session that just bootstrapped a worktree is precisely the session that cannot see its own
active task. Each agent then rediscovered its task file by trial and error, made worse by git-auto
mode (`ls backlog/tasks/` fails at the repo root; the board lives at `.taskwright/board/backlog/tasks/`).

## Fix

### (a) Return the context up front — the real fix

`start_task` and `claim_task` already know exactly which task they acted on. Return the task's full
context (the same `TaskSummary` `get_active_task` returns: description, ACs, DoD, plan + planProgress,
tree fields, and `filePath`) in their result. A follow-up lookup then becomes unnecessary — the agent
never needs to find the board on disk, in any board mode.

### (b) Session-task ledger — the fallback

New `src/core/sessionTasks.ts`: a local, git-ignored ledger at `<root>/.taskwright/session-tasks.json`
recording the tasks **this session** started/claimed (`{ taskId, worktree, at, via }`).

- `start_task` and a successful `claim_task` record an entry.
- `release_task` and a terminal `request_merge` (`merged` / `pr_opened`) forget it.
- Read-time liveness filter: the task must still exist, must not be at the board's terminal status,
  and the entry must be inside the claim-staleness window (12h).

`get_active_task` resolution order, reporting `source`:

1. `marker` — the ephemeral active-task file, written by the board popover or a dispatch. **Always
   wins** (AC #3: externally-dispatched sessions see no behavior change).
2. `session` — exactly ONE live ledger entry ⇒ that is unambiguously this session's task.
3. `none` — nothing, or **ambiguous**: more than one live entry (an orchestrator that bootstrapped N
   subagent worktrees shares one MCP server and one root, so its ledger holds all N). Return
   `active: false` with `candidates`, never a guess.

The ambiguity guard is the load-bearing part: MCP calls carry no cwd, so the server genuinely cannot
tell one in-session subagent from another. Returning the most-recent entry would hand 10 of 11
subagents *someone else's task* — silently working the wrong task is far worse than `active: false`.
Honest ambiguity + (a) makes the fallback safe.

### (c) Surfaces

`get_active_task` / `claim_task` / `start_task` tool descriptions, the MCP instructions, and the
`execute-task` / `orchestrate-board` skills state the new contract: work from the context
`start_task` / `claim_task` returned; never hunt the filesystem for the board.

## Plan

- [x] `src/core/sessionTasks.ts` + unit tests (record / read / forget / liveness / corrupt file)
- [x] `hydrateTaskSummary` helper shared by `get_active_task`, `start_task`, `claim_task`
- [x] `start_task` returns `task`; records a ledger entry
- [x] `claim_task` returns `task`; records a ledger entry (not on surrender/locked)
- [x] `get_active_task` marker → session → none, with `source` and `candidates`
- [x] `release_task` / terminal `request_merge` forget the ledger entry
- [x] Tool descriptions + MCP instructions
- [x] `execute-task` + `orchestrate-board` skills; contract test that no skill hunts for the board
- [x] `bun run test && bun run lint && bun run typecheck`
