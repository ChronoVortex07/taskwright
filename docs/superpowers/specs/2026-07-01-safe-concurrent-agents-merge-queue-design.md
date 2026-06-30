# Safe concurrent agents: worktree isolation + merge queue

- **Date:** 2026-07-01
- **Status:** Approved design (pre-implementation)
- **Task:** TASK-15 — Prevent multi-agent worktree escape and infighting

## 1. Problem & root cause

Running multiple agents concurrently caused them to fight over changes in git.
Root-cause investigation of the primary working tree's `HEAD` reflog showed the
agents did **not** operate inside their assigned worktrees. Even though four
worktrees existed, the agents ran `git checkout` / `git commit` from the
**shared primary working tree**, so they all shared one `HEAD`. Commits landed
on whatever branch `HEAD` happened to point at when the command ran.

Reflog evidence (newest first):

- `checkout: task-4 -> task-14`, then `commit: "Make unit tests path-separator-agnostic"` — task-4's work committed onto task-14's branch.
- `reset -> 5264efc` — clawed back.
- `commit: "Detect taskwright naming"` — task-14's real work.
- `commit: "Release TASK-2 claim"` — TASK-2's work committed onto task-14's branch too.
- `reset -> 251e37e` — clawed back again.
- `checkout task-14 -> main`, re-commit "Release TASK-2 claim" on main (duplicate hash), merge task-4.

The reset/re-commit churn is the observed "infighting": commits misfiled onto
sibling branches, then reverted and redone.

**Root cause:** Worktree _creation_ alone does not constrain where an agent runs
git, and nothing serialized integration. Two failures compounded:

1. **No isolation enforcement** — nothing kept each agent's session operating
   inside its `.worktrees/<branch>` directory; an agent in the primary tree
   could `checkout`/`commit` any branch.
2. **No integration serialization** — multiple agents merged into `main`
   concurrently with no ordering or gate.

## 2. Goals / non-goals

**Goals**

- Keep each agent operating inside its own worktree; make escaping into the
  primary tree fail loudly (not silently corrupt a sibling branch).
- Serialize integration so only one task merges into `main` at a time.
- Give the human a default **review gate** before anything reaches `main`, with
  selectable automatic modes (local merge, or pull request).
- At task end the agent submits through a single call and **suspends** until its
  work is integrated — no manual babysitting, no concurrent merges.

**Non-goals**

- Launching agents. Taskwright stays subscription-safe and pull-based: it never
  spawns `claude -p`. `request_merge` shells out to `git`/test runners/`gh`, not
  to a metered Claude.
- Replacing the advisory claim system. Claims remain; the queue is layered on
  top.
- Cross-machine coordination. The queue coordinates worktrees of one local repo.

## 3. Overview

Three components:

- **A. Worktree isolation guard** — soft (hardened dispatch prompt + `AGENTS.md`)
  plus hard (`pre-commit` / `post-checkout` git hooks) so an agent that strays
  into the primary tree is blocked with a clear message.
- **B. Merge queue + right-of-way** — an ordered, shared FIFO queue whose _head_
  holds the exclusive right to mutate `main`. Replaces a raw lock.
- **C. `request_merge` flow + review gate + modes** — one blocking MCP tool that
  validates, enqueues the task into a new `Reviewing Merge` state, suspends until
  granted (auto-mode head, or human approval), then performs the mode's action
  and cleans up.

All business logic lives in `src/core/` (vscode-free, injectable `exec`/`fs`) so
it is unit-testable and reusable by the stdio MCP server, matching the existing
`WorktreeService` / `ClaimService` pattern.

## 4. Component A — Worktree isolation guard

### 4.1 Soft guidance

- **Dispatch template** (`DEFAULT_DISPATCH_TEMPLATE` in
  `src/core/dispatchPrompt.ts`): add an explicit isolation preamble — _"Your
  worktree is `.worktrees/<branch>`. `cd` into it before doing anything. Run all
  git, file, and test commands there. Never `git checkout`, `commit`, or `merge`
  in the repo root. When finished, call `request_merge` and wait for it to
  return."_
- **`AGENTS.md`**: add the same rule to the task workflow section, and document
  `request_merge` as the closing step (replacing ad-hoc merge/commit-to-main).
- Recommend enabling `taskwright.dispatchOpenTerminal` (already exists) so the
  dispatched terminal opens with `cwd` set to the worktree.

### 4.2 Hard guard

A pure predicate `src/core/worktreeGuard.ts`:

> `shouldBlockCommit({ gitDir, toplevel, branch, dispatchedBranches })` returns a
> block decision + message when **the working tree is the primary tree**
> (`gitDir` is `<repo>/.git`, not `<repo>/.git/worktrees/<id>`) **and** `branch`
> is a dispatched task branch (a `.worktrees/<branch>` directory exists for it,
> or its task is claimed with a `worktree`).

Message: _"TASK-X belongs in `.worktrees/<branch>` — commit there, not the main
tree. (Bypass with `git commit --no-verify` if you really mean to.)"_

This catches the exact bug — an agent committing a task branch in the primary
tree — without blocking legitimate human commits on `main` (the integration
branch is never a dispatched task branch) and without touching the queue's
fast-forward integration (a fast-forward does not fire `pre-commit`).

A `post-checkout` hook additionally **warns** (does not block) when a dispatched
task branch is checked out in the primary tree, nudging the agent back.

### 4.3 Hook installation (`src/core/hookInstaller.ts`)

- This repo already uses **husky + lint-staged** (`.husky/pre-commit` runs
  lint-staged). The installer therefore **integrates with the existing hook
  manager** rather than overwriting `core.hooksPath`:
  - Append an idempotent, fenced block (`# >>> taskwright guard >>>` …
    `# <<< taskwright guard <<<`) to `.husky/pre-commit` that invokes the bundled
    guard checker; re-running the installer replaces only the fenced block.
  - If husky is absent, fall back to writing `.git/hooks/pre-commit` (chaining
    any pre-existing hook).
- The guard checker is a small bundled Node entrypoint (e.g.
  `dist/hooks/worktree-guard.js`) that gathers git facts and calls
  `worktreeGuard`; exit non-zero to block.
- Installation runs on extension activation, gated by
  `taskwright.enforceWorktreeIsolation` (default `true`). When the setting is
  `false`, the fenced block is removed.

## 5. Component B — Merge queue & right-of-way

### 5.1 Storage

A single shared file all worktrees can see:
`$(git rev-parse --git-common-dir)/taskwright/merge-queue.json`. The common git
dir is identical from every worktree, so the queue is genuinely shared (unlike
the per-worktree, git-ignored `.taskwright/`). Writes are atomic
(write-temp-then-rename); readers tolerate a missing file as "empty queue".

### 5.2 Shape

```json
{
  "version": 1,
  "entries": [
    {
      "taskId": "TASK-7",
      "branch": "task-7-add-login",
      "worktree": ".worktrees/task-7-add-login",
      "mode": "manual-review",
      "submittedAt": "2026-07-01 12:30",
      "approved": false,
      "active": false,
      "activeAt": null
    }
  ]
}
```

### 5.3 Operations (`src/core/mergeQueue.ts`, injectable `fs`)

- `enqueue(entry)` — append if the task is not already queued.
- `head()` — first entry (the right-of-way holder).
- `approve(taskId)` — set `approved: true` (written by the board UI).
- `sendBack(taskId)` — remove the entry (board "Send back").
- `markActive(taskId)` / `dequeue(taskId)` — head claims `active` while it
  performs its merge, then is removed on completion.
- `isHeadStale(timeoutMinutes)` — a head that has been `active` longer than
  `taskwright.mergeQueueStaleMinutes` (default 30) is reclaimable, so a crashed
  agent cannot wedge the queue. Reclaim drops the stale head and promotes the
  next entry.

**Right-of-way rule:** only the head may mutate `main`. Strict FIFO. Reordering
and "skip" are explicitly out of scope for v1 (FIFO + Send-back covers the need).

## 6. Component C — `request_merge` flow + modes

### 6.1 Modes (`taskwright.mergeMode`)

Mode sets both the gate and the action:

| Mode                          | Gate                            | Action when granted                    |
| ----------------------------- | ------------------------------- | -------------------------------------- |
| `manual-review` **(default)** | human approval                  | fast-forward merge to `main`           |
| `auto-merge`                  | none                            | fast-forward merge to `main`           |
| `auto-pr`                     | none (review happens on GitHub) | push branch + open PR targeting `main` |

The mode is captured on the queue entry at submission, so changing the setting
mid-flight does not retroactively re-gate already-queued tasks.

### 6.2 `request_merge` lifecycle (MCP tool, `src/core/finishTask.ts`)

Called once by the agent from inside its worktree. It behaves like a long Claude
Code tool call: it does not return until the work is integrated (or aborted), so
the agent simply suspends on the pending tool result — the "stop until the output
returns" behaviour.

1. **Validate + verify up front.** Worktree is clean (uncommitted changes →
   abort: "commit or discard first"). Rebase onto `main` (`git rebase main`);
   conflict → `git rebase --abort` + abort with the conflict list. Run the
   verification commands (`taskwright.mergeVerifyCommands`, default
   `["bun run test", "bun run lint", "bun run typecheck"]`); any failure → abort
   with the failing output. **Aborts here never enqueue** — only green, rebased
   work enters review.
2. **Enqueue + set status `Reviewing Merge`** (via the writer, surgically).
3. **Wait for the green light.** Return from the wait only when **this task is
   the head** AND **(mode is auto OR `approved` is true)**. Until then the call
   is suspended.
4. **On grant, re-validate.** `main` may have advanced while waiting (a prior
   head merged), so re-rebase onto current `main` and re-run verification before
   touching `main`. (While this task is the active head, no other task may merge,
   so `main` is stable for the duration of the action.)
5. **Perform the action.**
   - `manual-review` / `auto-merge`: confirm the primary tree is clean, then
     `git -C <primary> merge --ff-only <branch>` — a linear fast-forward into
     `main` (matches this repo's history). The right-of-way makes touching the
     primary tree safe; the clean-check prevents clobbering human WIP.
   - `auto-pr`: `git push -u origin <branch>` then open a PR targeting `main`
     (via `gh pr create`, or the GitHub API if `gh` is unavailable); record the
     PR URL in the task's Implementation Notes. Requires a configured remote;
     abort with a clear message if none.
6. **Finish + cleanup.** `complete_task` (status → `Done`, file moves to
   `completed/`); `git worktree remove <worktree>` (removes the worktree and any
   stray untracked files with it); delete the merged branch
   (`auto-pr` keeps the remote branch for the open PR but removes the local
   worktree); clear `.taskwright/handoff/<id>.md` and the worktree's
   active-task; `release_task`.
7. **Dequeue.** Removing the head unblocks the next head's pending
   `request_merge`.

The tool always releases its place in `finally`; an abort at any step leaves the
queue and `main` untouched and returns a structured reason the agent can act on.

### 6.3 Blocking / subscription semantics

Preferred: `request_merge` blocks for the whole duration (single suspended tool
call). The board UI writes `approved` to the shared queue file; the long-poll in
`request_merge` observes it and proceeds — this is the "subscribe to a hook that
fires when approval is granted" behaviour, implemented as a file-backed
long-poll (poll interval ~1s, jittered).

Fallback for client-side tool timeouts on long human reviews: if the call must
return before being granted, it returns `{ status: "waiting", position: N,
reason: "awaiting approval" | "queued behind N task(s)" }`, and the dispatch
prompt instructs the agent to call `request_merge` again until it returns
`{ status: "merged" }` / `{ status: "pr_opened" }`. The UX is identical (the
agent waits); it is just timeout-proof. Implement the single-block path first and
only add re-call if a transport timeout is observed.

## 7. Board status & approval UI

- **Status:** insert `Reviewing Merge` →
  `["To Do", "In Progress", "Reviewing Merge", "Done"]` in `backlog/config.yml`.
  The kanban column, drag rules, and language providers are config-driven, so the
  new column appears automatically.
- **Controls** on cards/detail panel for tasks in `Reviewing Merge`:
  - `manual-review`: **Approve & merge** (writes `approved:true` → unblocks the
    agent) and **Send back** (removes the entry, status → `In Progress`; the
    agent's call returns `{status:"sent_back", reason}`).
  - `auto-merge` / `auto-pr`: read-only **queued · position N / merging…**
    indicator.
- The extension host writes approvals/send-backs; the MCP `request_merge`
  long-poll reads them. They coordinate purely through the shared queue file —
  no direct IPC.

## 8. Full task lifecycle

```
dispatch
  └─ create .worktrees/<branch>, claim(worktree=branch), status In Progress
agent (inside worktree; pre-commit guard backstops escapes)
  └─ implements, commits in the worktree, runs tests
request_merge  (one blocking call)
  ├─ validate clean → rebase onto main → verify (test/lint/typecheck)
  ├─ enqueue, status → Reviewing Merge
  ├─ wait: head? AND (auto-mode OR human-approved)
  ├─ on grant: re-rebase + re-verify
  ├─ action: ff-merge to main  | push + open PR
  ├─ cleanup: complete_task (Done), worktree remove, branch delete, release_task
  └─ dequeue → next head proceeds
```

## 9. Error handling & edge cases

- **Dirty worktree** → abort before enqueue; agent must commit/discard.
- **Rebase conflict** → `rebase --abort`, abort with conflict list; never
  auto-resolves.
- **Red verification** → abort with failing output; not enqueued.
- **Dirty primary tree at ff-merge** → abort (protects human WIP); agent retries
  after the tree is clean.
- **`main` advanced while waiting** → re-rebase + re-verify at grant time.
- **Crashed/abandoned agent holding the head** → stale-head reclaim after
  `mergeQueueStaleMinutes` promotes the next entry.
- **`auto-pr` with no remote / no `gh`** → abort with a clear setup message.
- **Hook false-positive on legitimate human work** → `git commit --no-verify`
  and/or `taskwright.enforceWorktreeIsolation: false` are documented escape
  hatches; the hook never traps a human.
- **Duplicate `request_merge`** for an already-queued task → idempotent (returns
  current queue position rather than enqueuing twice).

## 10. Configuration (new settings in `package.json`)

- `taskwright.enforceWorktreeIsolation` (boolean, default `true`) — install/remove
  the git-hook guard.
- `taskwright.mergeMode` (`"manual-review" | "auto-merge" | "auto-pr"`, default
  `"manual-review"`).
- `taskwright.mergeVerifyCommands` (string[], default
  `["bun run test", "bun run lint", "bun run typecheck"]`).
- `taskwright.mergeQueueStaleMinutes` (number, default `30`).

## 11. Module layout & file inventory

New cores (`src/core/`):

- `worktreeGuard.ts` — pure block/allow predicate + message.
- `hookInstaller.ts` — husky-aware install/uninstall of the guard hook.
- `mergeQueue.ts` — shared FIFO queue (enqueue/head/approve/sendBack/active/
  dequeue/stale), atomic fs, injectable.
- `finishTask.ts` — the `request_merge` orchestration (validate → verify →
  enqueue → wait → re-verify → act → cleanup), injectable `exec` + test runner +
  clock.

Hook entrypoint: `src/hooks/worktree-guard.ts` → bundled to
`dist/hooks/worktree-guard.js`.

MCP: add `request_merge` to `src/mcp/handlers.ts` + `src/mcp/server.ts` (reusing
`finishTask`); surface queue position in `get_active_task` for convenience.

UI/providers: new column + approval controls in the kanban and task-detail
providers/components; commands `taskwright.approveMerge` /
`taskwright.sendBackMerge`.

Config/docs: `backlog/config.yml` status; `DEFAULT_DISPATCH_TEMPLATE` and
`AGENTS.md` isolation/closing-step edits; settings in `package.json`.

## 12. Testing strategy (TDD, per project)

- **Unit (Vitest):** `worktreeGuard` truth table (primary vs worktree, dispatched
  vs non-dispatched branch, bypass); `mergeQueue` FIFO ordering, approval,
  send-back, stale-head reclaim, atomic-write round-trip; `finishTask` happy path
  - each abort branch with mocked `exec`/test-runner/clock; `hookInstaller`
    idempotent fenced-block install/replace/remove against a husky and a non-husky
    fixture.
- **MCP handler tests:** `request_merge` returns the right structured outcomes
  (`merged` / `pr_opened` / `waiting` / `sent_back` / abort reasons).
- **Webview (Playwright):** the `Reviewing Merge` column renders and the
  Approve/Send-back controls post the correct messages.
- **CDP (optional):** approving in the board unblocks a simulated queue entry and
  writes `Done` to disk.

## 13. Decomposition (for the implementation plan)

- **Subtask A — Worktree isolation guard:** `worktreeGuard`, `hookInstaller`,
  hook entrypoint, prompt/`AGENTS.md` hardening, `enforceWorktreeIsolation`
  setting, tests.
- **Subtask B — Merge queue + `request_merge`:** `mergeQueue`, `finishTask`,
  `request_merge` MCP tool, all three mode actions, verify/abort handling,
  settings, tests.
- **Subtask C — Board state + approval UI + modes wiring:** `Reviewing Merge`
  status, kanban column + controls, approve/send-back commands feeding the queue,
  `mergeMode` plumbing, webview tests.

A/B/C are buildable and testable independently; B's queue and C's UI meet only at
the shared queue file, so they integrate cleanly.
