# Design: GitHub-only synced board (off-branch storage + collision-proof claims)

**Date:** 2026-07-01
**Status:** Superseded — see
[`docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md`](../specs/2026-07-04-board-sync-v2-single-shared-board-design.md)

> **Superseded by Board Sync v2.** The live CAS engine (fetch → materialize → check → snapshot →
> ff-only push, on a poll) this spec describes was retired: it kept N copies of the board (one
> materialized copy per worktree, plus the ref) and a live background loop trying to reconcile them,
> which in practice produced silent rollbacks, file desyncs, and a blank Tree tab. v2 collapses to
> **one physical board** (the primary worktree's `backlog/`, resolved by `resolveBoardRoot()`) with
> git-native sharing moved to **discrete, user-initiated** push/pull + union-merge — no live loop, no
> per-worktree copy. Kept for historical context only; do not implement against this document.

## 1. Problem & root cause

Working on the Taskwright board while agents run in worktrees produces persistent
"desync" — e.g. a task keeps reappearing as read-only with
_"Task is from task-12-active-tasks-should-be-determined-by-focused-task-not-a-specific-button
and is read-only."_ — and deleting the task, or even the worktree, does not clear it.

**Root cause.** The board has `check_active_branches: true` / `active_branch_days: 30`
(`backlog/config.yml`). On every load, `CrossBranchTaskLoader` scans **every git branch**
touched in the last 30 days — including each agent's `task-*` worktree branch — reads the
task `.md` files committed on those branches, and merges them into the board tagged
`source: 'local-branch'`, which `isReadOnlyTask` (`src/core/types.ts`) forces to read-only.

The desync chain:

1. An agent's worktree branch `task-12-…` holds a committed copy of the task file.
2. The task is deleted on `main`, but the copy still exists in the `task-12-…` branch's commits.
3. The loader re-scans that branch, re-hydrates the ghost, and stamps it read-only.
4. Removing the **worktree directory** does not delete the **branch ref**, so the committed
   file survives; the ghost only dies once the ref is deleted _and_ it ages out of the window.

Compounding this, **claims live in task-file frontmatter** (`claimed_by` / `worktree` /
`claimed_at`), which is git-tracked — so under multi-agent load every claim/release rewrites a
git-tracked file, producing diff churn and merge friction.

The parts that are **not** git-tracked already behave cleanly: the merge queue lives at
`<git-common-dir>/taskwright/merge-queue.json` (inside `.git`, shared across worktrees) and
active-task is a git-ignored `.taskwright/active-task.json`. There is already precedent for
"in the repo area, not tracked by the project's git."

## 2. Goal & decisions

Move board storage **off the project's code branches** so it is not git-tracked directly, while
keeping it part of the repository and adding **near-real-time multi-user sync using only GitHub**
(no server, no accounts, hassle-free for any repo with push access). This eliminates the
ghost/desync at the root and prevents two people or agents from claiming the same task.

Decisions locked during brainstorming:

- **Sync substrate: GitHub only.** A `git push` to a ref is an atomic compare-and-swap; that is
  the coordination primitive. No external service.
- **Liveness: near-real-time.** Poll-based refresh (window focus + interval) to _see_ others;
  collisions are prevented instantly by the atomic push, not the poll. (True sub-second live would
  require a service and was explicitly rejected.)
- **Board home: fully off code branches.** The canonical board lives only on a dedicated sync ref;
  in code branches the board files are git-ignored local working copies.
- **Split:** `backlog/tasks`, `drafts`, `completed`, `archive` + claims/active-task → the sync ref
  (git-ignored locally). `backlog/config.yml` + `docs` / `decisions` / `milestones` → stay
  committed on `main` (reviewable, present on every branch/worktree so statuses/labels are known
  without a fetch).
- **Lifecycle: fully automatic.** The extension creates, seeds, pushes, heals, and compacts the
  board ref itself. The user never runs a git command (one consent prompt for the initial
  off-branch migration is the only gate).

## 3. Architecture — the board lives on a dedicated ref

### 3.1 The sync ref

The canonical board is a **dedicated orphan branch on `origin`**, default name `taskwright-board`
(configurable). It has no shared history with code, never merges into code, and stays small.

- **Why a branch (`refs/heads/*`) and not a custom namespace (`refs/taskwright/*`):** GitHub
  reliably accepts pushes to `refs/heads/*` on any repo with no configuration, which is what makes
  the feature hassle-free everywhere. Custom ref namespaces are inconsistently accepted across
  hosts. Cost: the orphan branch appears in GitHub's branch dropdown (cosmetic).
- The board branch is **excluded from `CrossBranchTaskLoader`** by name, and in sync mode
  cross-branch scanning of code branches is **disabled entirely** — the board is no longer on code
  branches, so there is nothing to scan. **This is what removes the ghost/desync.**

### 3.2 Local layout

The extension keeps a git-**ignored** working copy under `backlog/tasks…` exactly where it is
today, so parsers, webviews, and MCP write tools are unchanged — they still read/write
`backlog/tasks/*.md` on disk. What changes is _persistence_: the copy is snapshotted onto the
board ref and pushed, instead of being committed into the feature branch.

### 3.3 Maintaining the ref without touching the user's git state (chosen approach)

Three ways to maintain a ref decoupled from the working branch were considered:

| Approach                                                                                                                                   | Verdict                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Nested git repo (`.taskwright/board/.git`) overlaying the same paths                                                                       | Rejected — two repos over the same files is fragile                                                                                            |
| A `git worktree` for the board branch                                                                                                      | Rejected — extra checkout dir, still visible, more moving parts                                                                                |
| **Isolated-index plumbing** — `GIT_INDEX_FILE=.taskwright/board.index` + `git hash-object` / `update-index` / `commit-tree` / `update-ref` | **Chosen** — snapshots `backlog/tasks…` onto the ref and materializes it back **without ever touching HEAD, the index, or the working branch** |

The chosen approach guarantees sync can never disturb the user's actual git state — the exact
failure mode that started this problem. Materializing the ref back into the working copy uses a
temp index (`read-tree` → `checkout-index`), never the user's index.

## 4. The claim protocol — collision-proof on GitHub alone

Claiming task `T`:

1. `git fetch origin <board-ref>`, fast-forward the local ref, re-read `T`.
2. If `T` is already claimed by someone else and the claim is not stale → stop:
   _"Claimed by <who>."_
3. Otherwise write the claim into `T`'s file and commit it onto the board ref.
4. `git push origin <board-ref>` — **fast-forward only, never `--force`.**
   - **Accepted** → the claim is owned. Done.
   - **Rejected (non-fast-forward)** → someone advanced the ref first. `git fetch`, rebase the one
     commit onto the new tip (per-file, usually a clean auto-merge), re-read `T`:
     - `T` now claimed by someone else → **surrender:** _"Claimed by <who> — you lost the race."_
       Drop the commit.
     - Still free → re-push. Bounded retries with small backoff.

**Correctness.** A server-side ref update is a compare-and-swap: only a fast-forward is accepted,
and only one racer's push can be _the_ fast-forward. The loser is forced to re-fetch and observe
the winning claim, then surrenders. **Two agents/people cannot both hold the same claim.** No
server is involved.

### 4.1 Near-real-time display

A background `git fetch` of just the one small ref runs on window focus and on a ~20s interval; if
the tip moved, the board re-materializes and refreshes. Claim/status changes push immediately;
bulk edits debounce. Seeing others lags by seconds, but **collision safety is instant** because it
rides the atomic push, not the poll.

### 4.2 Offline

Everything works against the **local** board ref (its updates are atomic within the clone). On
reconnect, a background sync fetches/rebases/pushes; an offline claim that collided surrenders via
the same loop. Offline claims are provisional until the first successful push — documented, not
hidden.

### 4.3 Same-task conflict & auth

Two people editing the **same** task's body concurrently → the rebase conflicts on that one file →
resolve frontmatter fields **last-writer-wins with a warning banner**. Different tasks never
conflict (different files). Auth uses the user's **existing git push credentials** — nothing new to
set up; if push auth fails, sync degrades to local mode with a visible indicator rather than
hanging.

## 5. Components & codebase slot-in

All business logic in vscode-free pure cores with injectable `exec`/`fs`, matching the existing
`WorktreeService` / `ClaimService` / `mergeQueue` pattern.

**New pure cores (`src/core/`):**

- `boardRef.ts` — ref naming, orphan-branch creation, isolated-index plumbing to snapshot
  `backlog/tasks…` onto the ref and materialize the ref's tree back into the working copy. Never
  touches HEAD/index/working branch.
- `boardSyncEngine.ts` — the fetch → rebase → push CAS loop with bounded retry/backoff;
  `claim` / `release` / `edit` / `refresh` built on `boardRef`. The collision-proof heart; fully
  unit-testable with a fake `exec`.
- `boardLifecycle.ts` — automatic setup + self-healing (§6).
- `syncConfig.ts` — resolves `taskwright.sync.mode` (`off` | `local` | `github`), ref name, remote,
  poll interval.

**Wire-in (minimal, no rewrites):**

- `ClaimService` and the write paths route through `boardSyncEngine` when sync is on.
- `CrossBranchTaskLoader` is **disabled** in sync mode and always excludes the board branch by name
  (belt-and-suspenders).
- A `BoardSyncController` (`src/providers/`) runs the poll timer, drives lifecycle, and surfaces
  status (status-bar item + a small board indicator) and surrender/conflict toasts.
- MCP `claim_task` / `release_task` handlers route through the sync engine, so **agents get the
  identical atomic guarantee** as the UI.

## 6. Automatic setup & maintenance (`boardLifecycle.ts`)

The extension performs all of this; the user never runs a git command.

- **First run / activation with `mode: github`** — reconcile the ref across local + origin:
  - Neither exists → **create** the orphan branch, **seed** from the current committed
    `backlog/tasks…`, **push**.
  - On origin only → **fetch** and materialize.
  - Local only → **push**.
  - Diverged → **auto-rebase**.
- **`.gitignore`** entries for the board subdirs are added automatically. The one-time "move board
  off code branches" step (`git rm --cached` of the previously-tracked task files, a single
  reviewable commit) runs **after an explicit confirmation prompt** — the only consent gate,
  because it makes one commit on the user's branch. Everything after is silent.
- **Self-healing** — if the ref goes missing on origin it is recreated+pushed; if board files get
  accidentally committed to a code branch, it is detected and flagged.
- **History compaction** — a commit-per-claim would grow the ref forever, so the extension
  periodically **squashes** the board ref (disposable state, safe to rewrite) to keep it small.
  Automatic, throttled.
- **Degradation** — push-auth failure or no remote → silently fall back to `local` mode with a
  visible indicator; never hangs.
- **Opt-in default** — `mode` defaults to `off` for existing repos (no surprise migration);
  enabling it triggers the automatic setup above. New setups can opt straight into `github`.

## 7. Testing (TDD, Vitest — deterministic, no real network)

Write failing tests first:

- **`boardSyncEngine` CAS** — a fake `exec` rejects the first push (non-ff) then accepts after
  rebase → assert **surrender** when the rebased state shows a foreign claim, **success** when
  still free. Core correctness proof.
- **`boardRef` plumbing** (integration against a temp git repo) — snapshot subtree to ref and
  materialize back, asserting the user's **working branch / index / HEAD are untouched**.
- **Rebase-clean** (different files) vs. **same-file conflict** (last-writer-wins) paths.
- **`boardLifecycle` reconciliation matrix** (neither / origin-only / local-only / diverged) with a
  fake `exec`.
- **Loader exclusion** — the board branch never surfaces as a cross-branch task (regression test
  for the original bug).
- **Offline → reconnect surrender** path.

Then run the full gate: `bun run test && bun run lint && bun run typecheck`. (Note: ~22 upstream
unit tests assert POSIX paths and fail on Windows by design — see `CLAUDE.md`.)

## 8. Risks & boundaries (documented, not hidden)

- **Merge queue stays local-clone for v1.** `.git/taskwright/merge-queue.json` still orders
  worktrees of one clone; cross-**machine** merge ordering is out of scope here. Acceptable because
  the claim sync already stops two _people_ grabbing the same task — the main cross-machine
  collision. Future work.
- **Branch-list clutter** on GitHub (the orphan branch is visible) — cosmetic, documented.
- **Never force-push** the board ref; a genuinely corrupted/diverged ref needs a manual `--force`
  (rare, surfaced with instructions).
- **Backlog.md CLI** on a feature branch won't see tasks (they are off-branch now) — an expected
  consequence of the chosen model; Taskwright still sees everything.

## 9. Out of scope

- Cross-machine merge-queue ordering (claims are covered; merge ordering stays per-clone).
- Sub-second live updates / presence cursors (would require a service; rejected).
- Any change to dispatch's paste-based, subscription-safe UX.

## 10. Affected files

- `src/core/boardRef.ts`, `src/core/boardSyncEngine.ts`, `src/core/boardLifecycle.ts`,
  `src/core/syncConfig.ts` (new).
- `src/core/ClaimService.ts` / claim write paths — route through the sync engine when sync is on.
- `src/core/CrossBranchTaskLoader.ts` — disable in sync mode; always exclude the board branch.
- `src/providers/` — new `BoardSyncController` (poll timer, lifecycle, status UI).
- `src/mcp/handlers.ts` — `claim_task` / `release_task` route through the sync engine.
- `package.json` — `taskwright.sync.*` settings (`mode`, `ref`, `remote`, `pollIntervalSeconds`).
- `.gitignore` — board subdirs (managed by the extension).
- `src/test/…` — cores as in §7.
- `AGENTS.md` / `CLAUDE.md` — document sync mode, the board ref, automatic lifecycle, and boundaries.
