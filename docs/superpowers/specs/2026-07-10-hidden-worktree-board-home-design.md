# Hidden-Worktree Board Home — sync.mode `git-auto` (design)

**Status:** Revised for implementation — migration-hardened (pass 2) · **Date:** 2026-07-10, revised 2026-07-11 · **Task:** TASK-91

Extends Board Sync v2 (`2026-07-04-board-sync-v2-single-shared-board-design.md`). Does **not**
supersede it: modes `off` and `git` keep their exact v2 semantics; `git-auto` is a third, opt-in
mode. Revision 2 resolves the worktree-location question, adds the prior-state migration matrix
(§5) — the load-bearing addition, since consuming repos may arrive from Board Sync v1, v2 `git`
mode, or tracked-board states — and folds in a code-level wiring audit (§3.1).

## 1. Problem

Board Sync v2 fixed the v1 failure class (N copies + live reconcile loop) by collapsing to one
physical board and making sharing a discrete `push_board`/`pull_board` step. Transcript forensics
across all repos show the discrete step is **essentially never invoked** (~0 real calls vs 215
`create_task` / 77 `request_merge`), so in practice nothing is shared or versioned. Meanwhile the
board living inside the primary code tree still causes real damage:

- Task files tracked on code branches (3 of 5 consuming repos) produce **rebase conflicts inside
  `request_merge`** (observed: `backlog/tasks/task-5 - ….md`) and require the fenced `.gitignore`
  migration to be run — which most repos never do.
- `ffMergeToBase` needs a permanent special case ("dirty outside `backlog/` blocks the merge").
- Wrongly tracked task files are always one `git add -A` away.

Goal: keep exactly **one physical board** (the v2 invariant) while making versioning + sharing
automatic, and making "board files wrongly tracked in the code tree" structurally impossible.

## 2. Approach

Move the board's one physical home out of the code working tree into a dedicated **linked
worktree of the `taskwright-board` branch**, and run a small, event-driven auto-sync on it.

### 2.1 Location and layout

- Worktree path: **`<primaryRoot>/.taskwright/board/`** — inside the already git-ignored
  `.taskwright/` dir, mirroring the established `.worktrees/<branch>` pattern. This **overrides the
  task description's `<git-common-dir>/taskwright/board`**: nesting a working tree inside
  `$GIT_DIR` is unusual and riskier with git tooling, and the common-dir's only advantage
  (surviving `git clean -dfx`) is recoverable anyway — the branch (the durable store) lives in the
  common git dir regardless, and §6 makes worktree loss a one-click repair.
- The worktree checks out the local branch **`taskwright-board`** (created from the existing
  `taskwright-board` ref when present — see §5 for the divergence fold — else seeded from the
  current board via the existing `snapshotBoardRoot`). Its tree keeps the existing ref layout:
  `backlog/tasks/`, `drafts/`, `completed/`, `archive/`, `milestones/` — so existing refs,
  `boardMerge.ts`, and remote clones on plain `git` mode stay interoperable. **Nothing outside
  `backlog/<the five state dirs>` is ever committed to the branch** (old v2 clients enforce this
  with `materializeRefToWorktree`'s non-board-path guard, which would throw on their next pull);
  the auto-commit is pathspec-limited to guarantee it (§4).
- **What moves / what stays:** only the five board-state dirs (`tasks`, `drafts`, `completed`,
  `archive`, `milestones` — v2's `boardTrackedPaths`) live on the board branch. `backlog/config.yml`
  and `backlog/docs|decisions/` stay in the code repo (they version with the code). The parser gains
  a split root: *state root* (the board worktree's `backlog/`) + *config root* (repo `backlog/`).
  The split is forced by interop: the ref layout has no `config.yml`, and adding one would trip old
  clients' non-board-path guard.
- Line-ending safety: the board worktree gets `extensions.worktreeConfig` + a per-worktree
  `core.autocrlf=false` so commits round-trip byte-exact regardless of the clone's global autocrlf
  (the `boardRef.ts` `NO_EOL_CONVERT` lesson, applied to a persistent checkout). A committed
  `.gitattributes` was rejected — it would be a non-board path and break old clients' pull guard.

### 2.2 Root resolution and the primary-root split

`resolveBoardRoot()` becomes mode-aware: in `git-auto` it returns
`<primaryRoot>/.taskwright/board/backlog`; in `off`/`git` it returns the primary `backlog/`
unchanged. Both the MCP server and the extension host already route every board read/write through
this one function (`resolveWorkspaceBacklogRoot`), so the live layer stays **one copy, zero
reconciliation** — identical shape to v2. The MCP server resolves its root at launch (unchanged);
a mode flip therefore requires a window reload + MCP restart, which the migration command
performs/announces.

**The `dirname` hazard (audit finding).** Roughly fifteen call sites assume
`path.dirname(backlogPath) === primaryRoot` — doctor actions, claim/intake/plan/dispatch actions,
TaskDetail/TasksController active-task reads, `extension.ts`'s `activeRootDir()`, and the MCP
handlers' `makePrimaryBoard` (which independently re-derives the primary root from the git common
dir and hard-codes `'backlog'`). In `git-auto` that dirname is `…/.taskwright/board`, so every one
of these would read/write session state (`.taskwright/active-task.json`, `handoff/`, `.worktrees/`)
in the wrong place. The design therefore introduces an explicit **primary-root accessor** carried
alongside the backlog path (extension: on the workspace-manager root record; MCP: on the handler
deps), and every `dirname(backlogPath)` consumer is converted. `off`/`git` behavior is unchanged
(accessor returns the same value dirname used to). While touching the selector plumbing, the
language `documentSelector` gains the missing `milestones/` glob (pre-existing gap).

`resetTaskFile` (MCP `BoardOps`) currently does `git checkout -- <rel>` against the primary tree;
in `git-auto` the board worktree is a real checkout of the board branch, so the same operation runs
`-C <boardWorktree>` and actually works better than in v2 (where board files are untracked in the
primary and the checkout is a no-op).

### 2.3 What `git-auto` deletes from the merge path — and what it must not

With the board out of the code tree, `request_merge`'s rebase can never hit a `backlog/tasks/*`
conflict, and `ffMergeToBase`'s "dirty outside `backlog/`" carve-out (`hasCodeWip`,
`collidingWipPaths`) is inert in `git-auto`. The carve-out **stays in the code** — `off`/`git`
repos still need it — but the git-auto integration test asserts a dirty board never blocks a merge
by construction rather than by exemption.

## 3. Auto-sync engine (the only new moving part)

A deliberately small state machine, **never** a poll loop:

1. **Commit (local capture).** Debounced 5–10 s after the last board write (MCP or UI — both are
   observed via the existing `FileWatcher`, repointed at the board worktree in `git-auto`):
   `git -C .taskwright/board add -A -- <the five boardTrackedPaths> && commit` (no-op when clean).
   Pathspec-limiting the add is what guarantees the branch never grows a non-board path (§2.1
   interop guard) even if strays land in the worktree. Commits pass
   `-c user.name=Taskwright -c user.email=taskwright@local` as a fallback so repos/CI without a
   git identity still capture.
2. **Sync (fold remote).** Triggered by **events only**: activation, `enableSync`/mode flip,
   before + after `request_merge`, after a commit in (1), and the manual push/pull commands.
   Under a **single-flight lock** (queued events coalesce): commit-if-dirty → fetch
   `origin/taskwright-board` (explicit refspec via the existing `fetchRef` staging-ref plumbing —
   FETCH_HEAD-race lesson) → if remote has new commits, three-way **union-merge via the existing
   `mergeBoards()`** (base = merge-base) → commit the merged tree with two parents
   (`commitMergedTree`) → advance the branch and `git -C … reset --keep` the worktree to the merged
   tip (`--keep`, never `--hard`: uncommitted edits were already captured by the commit step under
   the same lock, and `--keep` aborts rather than destroys if not) → push (best-effort).
3. **Two processes, one engine.** The engine core is vscode-free (like `boardPushPull.ts`) so both
   hosts drive it: the **extension host** owns the watcher-debounced commit loop and the
   activation/manual events; the **MCP server** runs commit+sync at its own `request_merge`
   boundaries so headless orchestration stays fresh without VS Code open. Cross-process
   single-flight uses a lock file (`<commonDir>/taskwright/board-sync.lock`, stale-aged), and git's
   own index lock is the backstop; a lost race degrades to "retry on next event", never an error.
   Headless-only usage between merges accumulates uncommitted writes — bounded, documented.
4. **Degrade, never block.** No remote / offline / push rejected → local commits accumulate,
   status-bar shows the pending state; a later event retries. Sync failure **never** fails a board
   write or a git operation. Conflicts surface exactly as v2 does (status bar + notification with
   Open action) — same-task both-sides edits resolve by newer `updated_date`, never silently.

Invariants carried from the v1 postmortem: **one copy** (writes and sync target the same
directory); **no background interval** (events only); **never `reset --hard` over uncommitted
edits** (the commit step always runs first under the same lock); milestones included by
construction (the whole tree syncs, no path list).

## 4. Config surface

- `taskwright.sync.mode`: `off` | `git` | `git-auto` (package.json enum + `syncConfig.ts`
  `coerceMode` pass-through; legacy `'local'`/`'github'` coercions untouched). Persisted to the
  shared `<commonDir>/taskwright/sync-config.json` as today, so the out-of-process MCP server reads
  the same truth.
- `push_board` / `pull_board` MCP tools + commands remain the manual escape hatch in `git-auto`
  (they enqueue the same sync event instead of the v2 isolated-index path).
- Status bar: mode, last-sync, pending-commits/pending-push, conflict count (extends the v2
  `boardSyncUx.ts` model).

## 5. Migration (the load-bearing section)

Migration to `git-auto` runs **only** through the explicit `taskwright.enableSync` command flow
(which gains a mode choice). Activation never performs the initial move; it performs **detection,
bootstrap, and hygiene** for repos already in `git-auto` (§5.3, §6). Everything below is idempotent
— re-running `enableSync` on any state is safe.

### 5.1 Prior-state matrix

| # | Prior state | Detection | Migration action |
|---|---|---|---|
| S0 | Fresh repo, no board | no `backlog/` | Init config root in repo `backlog/`; seed an empty branch; add worktree. |
| S1 | v2 `off` (default): board git-ignored in primary `backlog/` | fenced block present, `git ls-files` over board paths empty | Seed branch from live board → add worktree → verified move (§5.2). |
| S2 | Board files **tracked on code branches** (3 of 5 consuming repos; *this repo tracks `milestones/`*) | `git ls-files -- <boardTrackedPaths>` non-empty | Untrack (`git rm -r --cached --ignore-unmatch`), (re)write the fenced block — `applyBoardIgnore` already emits the 5-dir v3 block incl. `milestones/`, upgrading stale 4-dir blocks in place — commit, then proceed as S1. **Working-tree content is the source of truth** (an uncommitted board edit survives because untracking never touches working files). Stale copies remain on *other* code branches/history — expected; surfaced in the migration summary; §6's stray-fold heals any resurrection. |
| S3 | v2 `git` mode: local `taskwright-board` ref exists (likely **stale** — pushes were rare), remote may exist and may be ahead | `refTip()` non-null | Seed = fold, not clobber: snapshot live board (ours) → fetch remote ref if reachable (theirs; skip when offline) → `mergeBoards(base = merge-base map, ours, theirs)` → `commitMergedTree` **parented on the existing tips** so ref history continues and the remote push stays fast-forward → branch + worktree from that tip → verified move (§5.2). Conflicts surfaced per v2 rules. |
| S4 | v1 CAS leftovers: `.taskwright/board.materialized` marker, legacy `'local'`/`'github'` mode values, per-worktree materialized copies under `.worktrees/*/backlog/` | marker file exists / `coerceMode` / n.a. | Tolerate + clean: delete the marker opportunistically; mode values already coerce on read; materialized copies in task worktrees are inert (v2 made them unreachable) and die with their worktrees. Then proceed per S1–S3. |
| S5 | **Fresh clone of an already-migrated repo**: committed `.vscode/settings.json` says `git-auto`, but no `.taskwright/` (ignored ⇒ not cloned), no local branch; `origin/taskwright-board` exists | activation: mode `git-auto` ∧ worktree missing | **Activation bootstrap** (not enableSync): fetch ref → create local branch from it → `git worktree add` → done. No move needed — a migrated repo's primary `backlog/` holds only config/docs. This is the payoff case: a teammate clones and the board just appears. |
| S6 | Already migrated (re-run) | worktree exists ∧ healthy | Ensure-only no-op (re-assert gitignore block, worktree config, hooks opt-in). |

### 5.2 The verified move (S1–S3) — ordering is the safety argument

1. **Pre-move safety snapshot**: `snapshotBoardRoot` onto the ref (existing machinery) — a durable,
   named backup of the exact pre-move state, before anything is touched.
2. Dispose the extension's board `FileWatcher` (no event storms / Windows handle locks during the
   move).
3. Create/advance the branch tip (per S1/S3 above) and `git worktree add .taskwright/board
   taskwright-board` (prune stale registrations first).
4. **Verify before delete**: for every file under the primary's five state dirs, require the
   worktree copy to be byte-identical (or the file to appear in the surfaced conflict list from the
   S3 fold). Only then delete the primary copies — per-file, delete-last.
5. **Commit point**: write `sync-config.json` `mode: 'git-auto'` (and the VS Code setting) only
   after step 4 completes. Any abort before this leaves the mode unflipped and the primary board
   intact and authoritative (steps 1–3 are additive); an abort *during* step 4 leaves every file in
   at least one complete home plus the step-1 ref backup. Re-running `enableSync` resumes
   idempotently.
6. Prompt for window reload (restarts the MCP server so its launch-time root picks up the new
   mode).

Windows notes: deletes/renames may hit EBUSY from editors/watchers — retry once, then leave the
file and report it in the summary (the §6 stray-fold picks it up later); never fail the whole
migration for one locked file. Long-path and spaces-in-path covered by tests.

### 5.3 The split-brain window and its heal

Between the mode flip and the reload, a still-running MCP server (root bound at launch) would
recreate and write `backlog/tasks/` in the **primary** tree. This cannot be prevented from the new
code (the old process doesn't consult it), so it is **healed instead**: at every `git-auto`
activation and before every sync, if state dirs exist under the primary `backlog/`, their files are
folded into the board via `mergeBoards` (newer `updated_date` wins, conflicts surfaced), then
removed — same verified-move discipline as §5.2 step 4. Surfaced as a board-doctor finding with a
one-click repair (§6) and auto-healed silently when unambiguous. The migration summary also tells
the human to end other agent sessions before migrating.

### 5.4 Reverse migration (leaving `git-auto`)

Flipping the mode back by hand would leave `resolveBoardRoot` pointing at a primary `backlog/`
with no task dirs — the board would *look* emptied. Two defenses:

- **Supported path**: the `enableSync` mode picker offers `git`/`off` from `git-auto`; the reverse
  move is cheap with existing primitives — commit pending worktree changes → snapshot to ref →
  `materializeRefToWorktree` into the primary `backlog/` → remove the board worktree (branch kept
  as the durable store) → flip mode → reload.
- **Detection**: mode is `off`/`git` ∧ primary `backlog/tasks` missing ∧ a populated
  `.taskwright/board` (or `taskwright-board` ref) exists ⇒ board-doctor finding ("board looks
  empty — mode was switched without migrating back") with repairs *Restore board here* (the
  reverse move) or *Return to git-auto* (flip the setting back).

## 6. Failure recovery (board doctor)

The board branch is the durable store; the worktree is reproducible. New doctor findings (added to
`DoctorFindingType`/`DoctorRepair`, the `doctorActions` switches, and the MCP `board_doctor` tool
description — all currently exhaustive):

| Finding | Detection (git-auto) | Repair |
|---|---|---|
| `board-worktree-missing` | mode `git-auto` ∧ `.taskwright/board` absent/unregistered (e.g. `git clean -dfx`, manual rm) | `git worktree prune` → re-add from `taskwright-board` (or bootstrap from remote per S5). Loss bound: the debounce window (seconds) of uncommitted edits — committed history lives on the branch in the common git dir and survives any worktree deletion. |
| `board-strays-in-primary` | state dirs present under primary `backlog/` while mode `git-auto` | Fold + clean per §5.3. |
| `board-mode-mismatch` | §5.4 detection | Restore-here / return-to-git-auto per §5.4. |

`gatherDoctorFacts` gains the board-worktree facts; existing findings/repairs untouched.

## 7. Components

| Unit | Responsibility | Purity |
|---|---|---|
| `boardWorktree.ts` (new) | create/repair/locate/prune the board worktree; seed branch from ref/board; worktree config (autocrlf) | git plumbing (mirrors `WorktreeService` shape) |
| `resolveBoardRoot()` / `resolveWorkspaceBacklogRoot` (mod) | mode-aware root: worktree `backlog/` in `git-auto` | pure core + wiring |
| primary-root accessor (new, threaded) | replace every `path.dirname(backlogPath)` primary-root derivation (providers, doctor, MCP `makePrimaryBoard`) | wiring |
| parser/writer split root (mod) | state root vs config root (`config.yml`, docs/decisions from repo `backlog/`) | wiring |
| `autoSync.ts` (new) | debounce, event queue, single-flight + cross-process lock, commit→fetch→merge→push planner | pure planner core + git shell |
| `mergeBoards()` (reused) | unchanged conflict model | pure |
| `enableSync` migration (mod) | mode picker; S0–S6 matrix; verified move; reverse move; reload prompt | wiring |
| board doctor (mod) | three new findings/repairs (§6) | pure diagnoser + UX switch |
| status-bar UX (mod) | mode, last-sync, pending/conflict state | UI |
| docs (mod) | CLAUDE.md/AGENTS.md sync sections; Backlog.md-CLI divergence note | docs |

## 8. Testing

- **Unit (pure cores):** mode-aware root resolution (off/git unchanged, git-auto repointed);
  sync-step planner (dirty/clean × remote ahead/behind/diverged/unreachable → expected git ops);
  debounce/lock coalescing (fake timers); migration-state classifier (S0–S6 from detection facts);
  verified-move file comparator; doctor findings.
- **Integration (real temp git, two clones):** write→auto-commit→push→pull round-trip; divergence
  → union-merge with surfaced conflict; offline accumulation + later push; worktree deleted →
  `board-worktree-missing` repair; **migration matrix**: S1, S2 (tracked files incl. a stale 4-dir
  gitignore block + uncommitted board edit), S3 (stale local ref + ahead remote → fold, ff push),
  S4 (marker cleanup), S5 (fresh-clone bootstrap), S6 + double-run idempotence; reverse migration;
  split-brain stray fold; dirty board never blocks `request_merge` in git-auto.
- **Windows:** byte-exact blobs (per-worktree `core.autocrlf=false`); paths with spaces; `git
  clean` recovery; EBUSY-tolerant move.

## 9. Non-goals

- No live/interval polling, no CAS, no per-worktree copies — ever (v1 postmortem is binding).
- No automatic conflict resolution beyond v2's last-writer-wins + surface.
- Upstream Backlog.md CLI compatibility (root-level `backlog/tasks`) is **dropped in `git-auto`
  mode only** — documented; `off`/`git` keep it. No junction/symlink shim (rejected: reparse-point
  hazards on Windows — `git worktree remove --force` follows reparse points).
- Real-time multi-user editing. Sharing is still git-native and asynchronous, just automatic.
- No auto-enable: `git-auto` is opt-in via `enableSync`, never a default flip.
