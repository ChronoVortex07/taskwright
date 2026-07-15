# Changelog

All notable changes to Taskwright are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.0] - 2026-07-15

The **stable task IDs + workflow friction hardening** release. Drafts never change their ID — every
reference (another task's `dependencies`, a spec, a handoff) stays valid for the life of the task.
The merge queue gets a cross-process verify slot so concurrent suites can't oversubscribe the CPU,
`request_branch_merge` gives task-less branches the same sanctioned merge path as board tasks, the
verify doctor is proactive (it asks at board init instead of staying silent until a merge aborts),
and several workflow rough edges are smoothed: the pre-commit hook works on Windows without
`--no-verify`, `get_active_task` has a session fallback so self-bootstrapping sessions see their
own task, and `complete_task` is dewired so finished work can't vanish off the board.

### Added

- **`request_branch_merge` — a sanctioned merge path for work with no board task.** Multi-phase dev
  sessions in ad-hoc worktrees (a `tech-tree-p5` branch, an orchestrator's own scratch worktree)
  never fit claim → execute → `request_merge`, because that tool requires a task ID. So they fell
  back to a manual `git merge --ff-only` in the repo root — which skips the verify gate, skips the
  merge queue's right-of-way against every other agent working the repo, and then trips the
  merge-without-review guardrail, costing ~4 turns of block → explain → ask → override every single
  time.

  The new MCP tool runs the **identical** pipeline as `request_merge` — rebase onto the base branch,
  verify under the shared verify slot, the same FIFO merge queue (task merges and branch merges are
  ordered against each other in one queue), the same manual-review approval gate, then the
  fast-forward merge — and returns the same abort codes (`verify_failed`, `verify_timeout`,
  `dirty_worktree`, `dirty_primary`, `rebase_conflict`, `wrong_root`). Only what the absence of a
  task implies differs: **nothing on the board is touched** (no Done flip, no claim release), and the
  worktree and its branch **survive the merge** so the session keeps working in them —
  `removeWorktree: true` opts into teardown. Both invariants are enforced in the merge core from the
  queue key (`branch:<name>`) itself, not by callers remembering to ask for them.

  Because a task-less entry has no board card, the manual-review gate is granted from a new
  **"Taskwright: Review Branch Merge (no task)"** command (approve / send back), and every
  agent-facing surface (AGENTS.md, CLAUDE.md, the `execute-task` and `orchestrate-board` skills, the
  injected convention, the MCP instructions) now names this path where it forbids merging in the repo
  root — a contract test fails the build if one of them forbids without offering the alternative.

- **The verify doctor is now proactive: wrong verify commands can't ship silently.** The doctor could
  already prove a repo's merge-verify commands were wrong (1.x), but nothing ever _asked_ — and the
  bun-flavored defaults ship with every install, so a cross-repo scan found 0/5 repos had ever
  changed them. A non-bun repo therefore carried a gate that could not run, and only discovered it as
  a baffling `verify_failed` abort at merge time, after the work was done.

  Two changes close that. **The doctor now also catches a _runner mismatch_** — commands that run but
  drive a package manager the repo's **lockfile** proves it does not use (`bun run test` in a
  pnpm-locked repo). This is the shape the untouched defaults actually take: nothing is "provably
  broken", so the old evidence-only check stayed silent. A package manager that was merely _guessed_
  (no lockfile) is never evidence, so the doctor still does not cry wolf. **And it speaks at board
  init**, with a one-click "Apply suggested commands".

  It asks **once per situation**, remembered durably in `<commonDir>/taskwright/verify-doctor.json`
  and keyed by a signature of (repo shape + configured commands + suggested commands): declining is
  respected — no re-prompt, and no standing `board_doctor` finding either — while changing the
  commands, or changing the repo so the advice changes, is a _new_ situation the doctor may raise
  once. A decision is never a blanket mute. Nothing is ever rewritten without a human click.

- **`board_doctor` reports a typed `verify-commands-mismatch` finding** (repair:
  `apply-verify-commands`, carrying the exact command set to apply), so an agent pre-flighting the
  board sees a mis-wired merge gate _before_ spending a task on it — and the extension's doctor
  offers the one-click fix. Suppressed only by an explicit human decline.

- **End-to-end acceptance test** (`stableTaskIds.integration.test.ts`): proves the invariant rather
  than its parts — a reference written against a draft, structurally **and in prose**, survives
  promotion on a fresh board AND on a migrated legacy one. The prose case is the point: no remap can
  rewrite free text, so prose written against a legacy id before the migration is unrecoverable
  (asserted, deliberately) — which is why the fix is "never change an id", not "remap harder".
- **`idSpaceContract.test.ts`** — fails the build if any agent-facing surface (the `create_task`
  `draft` flag, `promote_draft`/`promote_drafts`/`demote_task`, `archive_task`/`restore_task`, the
  create-task and index-codebase skills, CLAUDE.md, AGENTS.md) promises the legacy id shape outside an
  explicit legacy/migration note, since that makes agents write draft-flavored ids into specs and
  handoffs.

- **`start_task` and `claim_task` now return the task's full context — and `get_active_task`
  has a session fallback so self-bootstrapping sessions can see their own work.** A session that
  creates its own worktree with `start_task` was the one session that could not see its active
  task: `start_task` writes the marker inside the new worktree, but the calling MCP server stays
  rooted in the primary tree (it binds at launch; `cd` does not move it). In a
  `/orchestrate-board` run, 9 of 11 self-bootstrapping subagents called `get_active_task` right
  after their own `start_task`/`claim_task`, got `{"active": false}`, and went hunting for
  the board on disk — which in `git-auto` mode lives outside the repo root entirely.

  `start_task` and `claim_task` now return the full `task` summary — description, ACs, DoD,
  plan + progress, tree fields, board `filePath` — in the same shape `get_active_task` returns,
  so a self-bootstrapping caller never needs to ask again. `claim_task` hydrates after the claim
  write, so the echoed status reflects the post-claim "In Progress". Separately, a new local,
  git-ignored session ledger (`src/core/sessionTasks.ts`) tracks every task this session started
  or claimed, giving `get_active_task` a fallback when the marker file isn't reachable from this
  server root. The ledger resolves marker → session → none, reports `source` so callers know
  which path answered, and returns candidates (not a guess) when more than one live entry exists
  (one orchestrator session shares one MCP server and root across all in-session subagents, and
  MCP calls carry no working directory, so "most recent" would hand N−1 subagents someone else's
  task). The marker still wins, so externally-dispatched sessions are unchanged. Agent-facing text
  now says the context arrives with `start_task`/`claim_task` and forbids a filesystem hunt;
  `taskContextContract.test.ts` fails the build otherwise.

### Changed

- **`taskwright.mergeVerifyTimeoutMinutes` default raised 10 → 20.** Measured on this repo:
  `bun run test` takes 21s unloaded and 57s with three suites running concurrently. 10 minutes was
  not provably too small, but the margin under heavy load was only ~2-3× and the failure is
  asymmetric — a premature kill costs an agent a full retry cycle, a late kill only delays aborting a
  genuinely hung command.
- **Vitest's per-test `testTimeout` raised 5s → 20s.** This, not the harness cap, is the timeout the
  load-induced flakes actually hit: a git-subprocess test that takes ~1s alone can exceed 5s on an
  oversubscribed machine, turning the suite red.
- **`verify_failed` and `verify_timeout` are now unmistakable in prose**, not just in the abort code:
  a red suite says it exited non-zero, that a bare retry will fail the same way, and (when the slot
  serialized it) that no other merge was competing with it; a killed suite says it was _killed_ for
  exceeding the clock and names the setting to raise. Agents were reading the former as the latter.

- **Drafts mint real `TASK-N` IDs from the shared counter.** There is **one ID space** across
  `tasks/`, `drafts/`, `completed/`, and `archive/` — the `drafts/` folder (never the ID) is the sole
  draftness marker. `promoteDraft` and `demoteTask` are **pure file moves**: the ID and status are
  preserved, and nothing that referenced the draft dangles. `getNextTaskId` scans every folder, and
  `allocateAndWrite` locks a single `backlog/.locks/` namespace — per-directory locks would let a
  concurrent `create_task` and draft-create both claim the same number (the old TASK-48 clobber,
  re-armed by the shared counter).
- **Legacy `DRAFT-N` boards migrate automatically and idempotently** at activation and MCP startup
  (`src/core/draftIdMigration.ts`, plus a `legacy-draft-ids` board-doctor finding). The migration
  re-IDs drafts in place — it never promotes — and remaps every reference through the shared
  `src/core/idRemap.ts` (which also closes the `parent_task_id` / `subtasks` / `references[]` gaps
  `promoteDrafts`' old remap missed). `remapIds` scans every folder an id can occupy —
  `tasks`/`drafts`/`completed`/both `archive` subfolders — because a completed task's dependency list
  and an archived task's references are restorable records (archiving is a soft delete).
- **Archive/restore routes by source folder.** `archive_task` moves a draft → `archive/drafts/` and a
  task → `archive/tasks/`; `restore_task` returns it to the folder it came from. This deletes the
  last id-prefix branch in the codebase.

- **`complete_task` is dewired: finished work can no longer be archived off the board.**
  `complete_task` moved a task file into `backlog/completed/`, taking it out of the board's
  records entirely. `request_merge` already marks a merged task Done and leaves it in `tasks/`,
  where it stays visible — so completion was fully served without it, and the only thing
  `complete_task` actually did was make finished work vanish, one tool call (or one click) away
  from any agent or human. The agent instructions even had to carry a "do not call
  `complete_task`" warning to defend against a tool Taskwright itself exposed.

  The tool is unregistered from the MCP server (a call now fails as an unknown tool), the
  controller message case is removed, and the webview message variant is deleted — no silent path
  into `backlog/completed/` remains. The underlying machinery (`BacklogWriter.completeTask()`
  and `completeTaskHandler`, with all their tests including the P1 bug/caused_by rule) is kept
  intact so re-wiring is a re-registration once milestone-completion semantics settle. The MCP
  instructions no longer spend their truncation budget warning about an uncallable tool, and the
  dewire contract is pinned by `completeTaskDewired.test.ts`.

### Fixed

- **Concurrent merges no longer flake each other's verify suites.** The merge queue serialized the
  _merge_, but every caller ran its verify commands **before** enqueuing — so N parallel
  `/orchestrate-board` subagents each launched a full `bun run test` (itself a CPU-saturating worker
  pool) at the same time, oversubscribing the machine by ~N×. Git-subprocess-heavy tests then blew
  their per-test timeouts and the merge aborted `verify_failed`, with every test passing in
  isolation; agents responded by blind-retrying (one task burned ~11 minutes over 4 consecutive
  `request_merge` calls) or by pushing `verifyTimeoutMinutes` ever higher, which masked the
  contention instead of removing it.

  `request_merge` now takes a **shared verify slot** (`src/core/verifySlot.ts`) around every verify
  run: an `O_EXCL` lock file in the git common dir, so exactly one verify runs at a time across every
  worktree _and_ every MCP server process sharing the repo. The slot is held only for the run and
  released **before** the merge-queue wait, so a slot-holder → queue-waiter → slot-waiter cycle
  cannot form; it is stealable when its holder's process is gone, its lease expires, or the record is
  a torn write, so a crashed holder cannot wedge every future merge. Throughput is essentially
  unchanged (measured: 3 concurrent suites take 57s each = 57s wall; serialized, 21s each = 63s
  wall), because vitest already uses every core.

- **Playwright no longer silently reuses another worktree's Vite fixture server.** The primary
  checkout serves on 5173; each `.worktrees/<branch>` now derives its own stable port from its path
  (`scripts/lib/fixtureServer.ts`), and the global setup aborts loudly if the server on the expected
  port serves another tree's `dist/webview/` directory. (TASK-111)
- **Stale `findRequestNonce` no longer reopens the find bar on tree remount.** A nonce bumped by a
  prior `/` keystroke could survive into the next mount and reopen the bar. The nonce is now cleared
  after the canvas acknowledges it, and the initial mount never answers a non-zero nonce.

- **The pre-commit hook no longer flips the whole tree's line endings on Windows, and the
  `--no-verify` folklore is retired.** The lint-staged pre-commit hook once flipped every file
  CRLF→LF on Windows, so every doc and memory note told agents to commit with `--no-verify` —
  folklore that also skipped the lint the hook exists to run. The structural fix already lived in
  `.gitattributes` (`* text=auto eol=lf`): `eol=lf` overrides `core.autocrlf`, so every
  checkout materializes LF regardless of the developer's git config.
  `core.autocrlf=false`/`core.eol=lf` are only local config and never travel with a clone, so
  `.gitattributes` is the only defense that does. Prettier's `endOfLine` is now `lf`
  (was `auto`, which merely preserved whatever was on disk and could never heal a stray CRLF).
  The invariant is pinned by `precommitEol.test.ts` — clone a fixture with the hostile
  `core.autocrlf=true`, run real lint-staged against real configs, commit, and assert every
  file the commit did not stage is byte-identical. The `--no-verify` CRLF guidance is stripped
  from 15 plan docs and `HANDOFF.md`, with a contract test so it cannot come back.

- **`isSamePath` now selects its path flavor from its `winLike` flag, fixing cross-platform
  path comparison.** The function resolved both paths with the ambient `path.resolve`, so its
  `winLike` flag switched only the case rule, not the path flavor. On Linux CI
  `winLike=true` did not treat a backslash as a separator; on Windows `winLike=false` still
  split on backslashes. Each platform could therefore only test its own rule — making a
  cross-platform regression test for the Windows separator bug impossible to write. Fixed by
  selecting the flavor from the flag (`path.win32` / `path.posix`). Production behavior is
  byte-identical on both real platforms; both rule sets are now assertable from either. Also
  adds merge-path regression tests (`requestMergeResumeIntegration.test.ts`) covering the
  pending/ticket resume protocol end-to-end against a real repo.

### Known issues

An independent audit of this wave (TASK-134, by a non-Claude model against the shipped code,
grounding-checked) found latent defects now tracked as follow-ups. These have narrow timing
windows or multi-session preconditions and are not regressions — they pre-date this wave:

- **TASK-135 — verify-slot lock protocol:** the slot's lock file is published non-atomically (a
  multi-write ceremony under a rename — a crash mid-ceremony can leave a partial record that the
  next holder misreads), stale-lease stealing is unguarded against a concurrent stealer, the lease
  is not persisted (a holder that crashes and quickly restarts its MCP server reclaims under a
  stale lease before the crash is detectable), and non-contention errors (permission-denied,
  disk-full) are swallowed as "slot held" instead of surfaced.
- **TASK-136 — `request_branch_merge` slash-branch target misroute:** a target like
  `feature/docs` (a branch name containing a slash) is misparsed as a worktree path and routed
  to the wrong merge path.
- **TASK-137 — `get_active_task` cross-session ledger leak:** the session ledger is process-wide
  and survives an MCP server reload, so in the narrow window between a crash and the next
  activation a restarted session can inherit another session's tasks.

> **TASK-131 (milestone-completion / band collapse) is not in this release.** Its merge core
> landed on a branch but the feature is parked mid-implementation (the webview phase is pending),
> so it must not be described as shipped.

## [1.8.1] — 2026-07-13

Three field bugs, each traced to a root cause and reproduced before it was fixed: autonomous runs
stalling on a worktree prompt, board sync refusing to enable without saying why, and the Tree tab
rendering nothing.

### Fixed

- **`/orchestrate-board` no longer stalls on a worktree-entry approval it could never satisfy.**
  Every run paused for permission and then failed with `Cannot enter worktree: … is the repository
root, not an isolated worktree`. That string is not Taskwright's — it comes from Claude Code's own
  `EnterWorktree` tool, whose documented trigger is "CLAUDE.md or memory instructions direct you to
  work in a worktree", which is exactly what every Taskwright instruction surface said. It can never
  open a Taskwright worktree: the harness manages its own `.claude/worktrees/`, while ours are plain
  `git worktree add` directories under `.worktrees/`, and a cwd-pinned `Task` subagent (how
  orchestrate-board fans out) may only switch within `.claude/worktrees/`. Allowlisting the
  permission would not have helped — the prompt was not the bug, the tool call was. Both skills, the
  AGENTS.md convention block and both dispatch templates now forbid the worktree-switch tool **by
  name** and state the mechanism that works (`cd` / `git -C`); a contract test fails the build if any
  surface loses it.

  Same change closes a silent work-loss path behind it. `/execute-task` decided "am I in my
  worktree?" by probing `git rev-parse --git-dir` from the shell — but after a `cd` that probe
  reports the worktree while the MCP server is still rooted in the primary tree (it roots at launch
  and cannot re-root). The mis-rooted `request_merge` that followed aborted, and the cancellation
  contract listed that abort as a "worktree vanished ⇒ cancelled" signal, so a subagent reported
  `{"status":"cancelled"}` — which orchestrate-board deliberately never retries. Rootedness now
  follows from a fact the shell cannot lie about (did this session call `start_task`?), such a
  session always closes with `request_merge { taskId, worktree }`, and the primary-tree abort carries
  its own machine-readable code, **`wrong_root`** — a misuse, never a cancellation. (TASK-122)

- **"Enable Board Sync" can no longer wedge a repo, and when it refuses it says why.** The git-auto
  migration aborted permanently in some repos, naming a few task files and giving no reason.
  Measured on the repro board: of 123 files, 118 were identical, 4 differed only by line endings, 1
  by content. Three defects, all in verify-before-delete. (1) `verifyMove` returned bare paths and
  the notification printed a count plus one filename — it now classifies every difference (`absent` |
  `eol-only` | `content-drift`) and the abort lists every blocker with its reason behind a **Show
  details** action, instead of falsely suggesting a re-run. (2) The permanent blocker was **EOL
  normalization**: a repo with `.gitattributes: * text=auto` normalizes CRLF→LF into the blob on
  `git add` — an in-tree attribute overrides the `core.autocrlf=false` flag the snapshot passes — so
  a CRLF task file came back out of the board worktree as LF and failed byte-equality forever. That
  is git's own declared policy applied to the file, not lost content: an EOL-only difference now
  verifies, and the board becomes canonically LF. (3) A **drifted board worktree** was compared
  stale: an existing worktree is reused without resetting it to the freshly-seeded ref tip, and a
  failed attempt leaves one behind, so every retry re-compared against stale files and re-aborted on
  whatever had been edited since. Drift is now union-merge folded forward (newer `updated_date` wins,
  conflicts surfaced) and then moved. Both field shapes are covered by integration tests against real
  git. (TASK-123)

- **The Tree tab rendered nothing on boards that use the Backburner milestone.** Clicking Tree
  mounted the view but drew zero nodes and threw one page error, `each_key_duplicate`. `bandOrder` is
  built through a de-duplicating push for declared and discovered milestones, then the reserved
  `Backburner` band was appended with a raw push that bypassed the dedupe — so a task carrying
  `milestone: Backburner` explicitly made the band appear twice. The webview keys the band `{#each}`
  by name, so a duplicate name is a duplicate key: Svelte throws and the entire canvas fails to
  render. Backburner is now reserved up front (no declared or discovered milestone can inject it) and
  appended exactly once, last — which the `backburnerIdx` computation depends on. (TASK-124)

## [1.8.0] — 2026-07-12

The **tree find bar** release: the Tree tab gets an in-canvas find, and an empty-canvas left-click
no longer accidentally authors a task.

### Added

- **Find bar on the Tree tab.** `/` or Ctrl/Cmd-F opens an in-canvas find bar that matches on task
  **id + title + description** — the identical predicate the List tab's search already uses, so
  search behaves the same on every tab. Matches get a ring, non-matches dim; Enter / Shift-Enter
  cycles the current match and Escape closes the bar and restores the canvas's own key bindings.
  Cycling walks matches in **spatial order** — sorted by band (x) then lane (y), not array order —
  so Enter steps through the board the way a human reads it, left-to-right then top-to-bottom, and
  each step re-centers the viewport on the new current match (`centerOn()` in
  `TechTreeCanvas.svelte`). Prev/next/close buttons duplicate the keyboard controls for mouse users.
  New pure core `src/webview/lib/treeFind.ts` (match predicate, spatial ordering, wraparound cycle
  index — unit-tested without a webview), new `TreeFindBar.svelte`, and find-match/find-current ring
  styling added to `TreeNode.svelte`.

  **This is a find, not a filter.** The navigator sidebar's existing dim-filter is untouched and
  composes with it — a node the navigator filter already dims is not a find candidate — and an
  active find never narrows a write: the "Promote all proposed" payload stays find-agnostic even
  with a query open.

  > **For future maintainers — a `$derived` acyclicity trap.** In `TechTreeCanvas.svelte`,
  > `findResults` may depend **only** on the two primitive dim sources, `navFilterDimmedIds` and
  > `hiddenIds` — **never** on the composed `dimmedIds`/`fadedIds` (which themselves fold find's own
  > output back in to dim non-matches). The original design had exactly that cycle
  > (`dimmedIds` → `findResults` → `dimmedIds`). Svelte 5 deriveds are lazy, pull-based getters with
  > no fixed-point iteration: reading a derived that transitively reads itself throws
  > `derived_references_self` in dev and stack-overflows in a production build. The two sets are kept
  > as separate deriveds, declared in dependency order, specifically to keep this cycle from
  > reappearing — see the comments at `TechTreeCanvas.svelte` around `navFilterDimmedIds`/
  > `findResults`.

  `/` and Ctrl/Cmd-F are handled at the **window** level (`Tasks.svelte`), so they open the bar
  from wherever focus happens to be — the canvas, a zoom button, `<body>` after a popover closed —
  by bumping a `findRequestNonce` prop the canvas answers with its own `openFind()` (the same
  host→canvas nonce convention the navigator jumps use). The canvas's own `.tree-viewport` key
  handler still routes to that one idempotent opener, so the two layers cannot fight. On the List
  tab, `/` keeps focusing that view's search box.

  Coverage: `src/test/unit/treeFind.test.ts` (pure core), `e2e/tree-find.spec.ts` (19 tests,
  including a regression for each bug fixed below). Visual proof:
  `docs/tree-find-bar-visual-proof.md`.

### Changed

- **An empty-canvas left-click no longer creates a task.** It previously made it impossible to
  click the Tree panel just to focus it (e.g. before pressing `/`) without accidentally authoring a
  task. Right-click's context menu remains the create-in-place path, inferring the clicked cell's
  lane/band exactly as before; drag-to-connect dropped on empty canvas still opens the create form
  pre-linked, since that's a drop gesture, not a click.

### Fixed

- **`/` and Ctrl-F silently did nothing whenever focus was outside the canvas viewport.** The
  canvas's key handler is bound to `.tree-viewport`, not `window` — and the toolbar, the "Promote
  all proposed" button and the in-flight panel are its _siblings_ — so after zooming, fitting,
  promoting, dismissing a popover via its ✕ (which removes the focused element, dropping focus to
  `<body>`), or simply opening a never-clicked "cold" tab, the keystroke never traversed the
  viewport and the advertised shortcut did nothing until the user clicked the canvas. The
  window-level handler in `Tasks.svelte` only _focused_ an already-rendered input, which does not
  exist until the bar is open. Fixed by making that window-level handler actually **open** the tree
  find bar (via the `findRequestNonce` prop described above) whenever the Tree tab is active.
  The canvas still also mount-focuses its viewport once (backing off if something else already holds
  focus, so it can't steal focus from, e.g., the create-task form's title input if a late/concurrent
  `tasksUpdated` flips the canvas from empty-state to laid-out while that form is open) — but that
  is now belt-and-braces for find and load-bearing only for the arrow/j-k node-nav keys.
  Ctrl/Cmd-F now also sits **behind** the create-form modal guard, so it can no longer pull focus to
  a search box behind an open modal.

- **Right-clicking inside the find input popped the canvas "create here" context menu** instead of
  the native text-editing menu (no copy/paste). The canvas `oncontextmenu` handler now bails on
  `.tree-find-bar` _before_ calling `preventDefault()`, mirroring its `onPointerDown` guard.

- **The find bar could slide under the canvas toolbar** in a narrow panel (bar `z-index: 12`;
  toolbar and promote-all button `z-index: 20`). The bar — a transient, focused overlay — now sits
  above them.

- **The find bar's prev/next/close buttons were visually present but silently unclickable by
  mouse.** `TechTreeCanvas`'s `onPointerDown` had no guard for `.tree-find-bar` (only
  `.tree-toolbar`/`.tree-popover` were excluded), so a pointerdown on a find-bar button fell through
  to the empty-viewport pan branch and captured the pointer onto the canvas before the button ever
  saw a click. Surfaced by adding e2e coverage that actually clicks the buttons instead of only
  driving them via keyboard; fixed by adding the missing guard.

- **A node with an active bug that was also a find match lost its red bug ring entirely.** In a
  CSS `box-shadow` list the _first_-listed shadow paints on top, and `TreeNode.svelte`'s combined
  `.has-active-bug.find-match` / `.has-active-bug.find-current` rules listed the larger-or-equal bug
  ring spread first — so the bug ring fully occluded the find ring underneath (and for
  `find-current`, alpha-blended into an almost-pure-blue smear). Fixed by reordering the shadows so
  the smaller find ring is listed first (innermost, painted on top) and the bug ring uses a
  strictly larger, non-overlapping spread listed after it, rendering as two distinct concentric
  rings instead of one occluding the other. Re-verified with cropped, 2x-scaled screenshots in both
  dark and light themes (`docs/tree-find-bar-visual-proof.md`) — confirming this is a genuine CSS
  layering fix, not a theme-contrast coincidence — and now _guarded_ by an `e2e/tree-find.spec.ts`
  test that reads the computed `box-shadow` of a node that is both `has-active-bug` and a find
  match/current match and asserts two distinct, non-nesting ring spreads with the smaller listed
  first, so a future edit to the shadow lists cannot silently re-occlude the bug ring.

- **A half-built `dist/webview/` silently broke three unrelated `tree-canvas` tests.**
  `dist/webview/styles.css` is emitted only by `build:css`, not `compile:webview` — running the
  narrower build left it missing, which 404s silently in Chromium and collapses the fixture page's
  entire height chain, so tests failed exactly like a code regression with no signal pointing at the
  actual cause. This cost the project roughly an hour of misdiagnosis on this branch (and recurred a
  second time during this branch's own final verification pass). `playwright.config.ts` now runs a
  `globalSetup` (`e2e/global-setup.ts`) that asserts `dist/webview/{styles.css,tasks.js,tasks.css}`
  exist before any test runs, failing loudly with the missing file(s) named instead of letting the
  suite fail sideways.

## [1.7.0] — 2026-07-12

The **performance** release: the tech tree stops repainting the whole board when you hover a node,
zoomed node text rasterizes crisply again, and Taskwright no longer gates VS Code's eager-extension
startup phase.

### Fixed

- **Hovering a node repainted the entire tech tree.** On a large board, moving the pointer onto and
  off a node visibly flickered the whole canvas — every node and every edge, not just the hovered
  one. `EdgeLayer.svelte` gave every edge path a `class:incident` and a `class:faded` derived from
  the hovered node, so a single `pointerenter` rewrote **every** edge on the board: a
  `MutationObserver` on a 120-node / 117-edge board counted **117 mutated elements per hover**. Each
  of those paths also carried `transition: opacity 0.12s`, so all 117 _animated_ their opacity on
  every hover in **and** out — and because `.tree-surface` was promoted to a single composited layer
  (`will-change: transform`), that edge-only restyle re-rasterized every node with it.

  The edge layer is now two layers: a **base group** holding every dependency edge, rendered once and
  never touched by hover, and a **highlight overlay** carrying only the active node's incident edges,
  drawn opaque on top. Fading the rest is a single `.has-active` class on the base group, with CSS
  doing the dimming — **zero per-edge DOM writes**. The board-wide opacity transition is gone.
  **117 → 2 mutated elements per hover.** The highlight/dim semantics and the bug→cause edge reveal
  are unchanged. Coverage: `e2e/tree-hover-perf.spec.ts` (mutation budget on a synthetic large
  board), plus updated `e2e/tree-canvas.spec.ts` hover assertions.

- **Node text rendered blurry when zoomed in.** `.tree-surface` — the element carrying the pan/zoom
  `transform: scale()` — had a permanent `will-change: transform`. That promotes it to its own
  composited layer and tells Chromium the transform will keep animating, so it rasterizes the layer
  once and then _scales that bitmap_ for later transforms rather than re-rasterizing text at the new
  scale: zooming in magnified a texture rendered at the old scale.

  The compositor hint is now **gesture-scoped** — applied while panning or wheeling (where it
  actually buys smooth motion) and dropped once the viewport settles, which is exactly when the
  browser re-rasterizes the text at the new scale. A wheel has no end event, so it settles on a short
  idle timer. Coverage: `e2e/tree-zoom-raster.spec.ts`.

  > **On the evidence:** this one is verified at the _property_ level, not by pixels. A screenshot
  > **cannot** show stale-raster blur — capturing one forces the compositor to re-rasterize the layer,
  > so the before/after images come out identical whether or not the bug is present. The tests assert
  > that `will-change` is absent at rest, present mid-gesture, and released after settle.

- **Taskwright was the last eager extension to activate, gating VS Code's startup.** The extension
  host log showed Taskwright activating ~2.1s after the host started, holding up the
  `Eager extensions activated` milestone — and therefore every `onStartupFinished` extension queued
  behind it. The board data was never the cause: parsing the full 98-task board takes **40ms cold and
  2ms warm** (`runBoardDoctor`: 1.5ms). Two things were:

  1. **Every `activationEvents` entry was a recursive glob.** VS Code resolves a plain
     `workspaceContains:` path with a single file `stat`, but a pattern containing glob
     metacharacters goes through the **workspace search service** — walking the tree before it can
     even decide whether to activate. See _Changed_ below.
  2. **`activate()` fired a burst of git subprocesses inline**: the worktree guard, post-checkout
     warn, board hooks, merge-config publish + verify doctor, sync-config publish, the board-sync
     status bar, the git-auto bootstrap (ensure-worktree, fold-strays) and its **network fetch and
     push**, plus the board doctor. Being un-awaited is not the same as being free — it all competed
     with window startup. That work now runs through a new deferred runner
     (`src/core/deferredBootstrap.ts`): once, ~2s after activation, cancellable, pull-forward-able,
     and it never rejects into activation. The ordering the git-auto engine depends on is preserved
     (housekeeping → status bar → ensure-worktree → fold-strays → first sync).

  > **On the evidence:** the "before" is measured (extension-host log). The "after" — Taskwright no
  > longer gating the eager milestone — has **not** yet been re-measured end-to-end, because that
  > requires this build installed and the window reloaded.

### Changed

- **Activation events are plain paths, never globs.** The six recursive-wildcard `workspaceContains:`
  patterns are replaced by `backlog/config.yml`, `backlog/config.yaml`, `.backlog/config.yml`,
  `.backlog/config.yaml`, and `backlog.config.yml` — each a single file stat.

  **Deliberate narrowing:** a backlog root nested _below_ the workspace root (e.g.
  `packages/foo/backlog/`) no longer **eager**-activates. It still activates as soon as the Taskwright
  board view is opened, which VS Code triggers from the contributed webview view. A regression test
  (`src/test/unit/activationEvents.test.ts`) fails the build if a glob is reintroduced.

- **Board and verify doctors run just after activation** rather than inside it, as part of the same
  deferred bootstrap. Both remain silent when the board is clean.

## [1.6.1] — 2026-07-12

The **stable MCP registration** release: Taskwright's MCP server no longer randomly disappears from
new Claude Code sessions.

### Fixed

- **The Taskwright MCP server randomly dropped out of new Claude Code sessions** (a window reload
  brought it back). The user-scope registration is a **single global entry** in `~/.claude.json`,
  shared by every window and every running session — but `deactivate()` **removed** it, and
  `activate()` re-added it. Since `deactivate` runs per _window_, reloading or closing **any**
  Taskwright window deleted the server for every **other** open window too, and any session started
  before that window's next activation silently had no Taskwright tools. Two narrower races made it
  worse: re-registration was an unconditional `mcp remove` **then** `mcp add` (a window in which the
  entry does not exist), and both are read-modify-writes of the same `~/.claude.json` that live
  sessions write to, so a concurrent write could drop the entry.

  The registration is now **version-stable and permanent**. Claude Code is registered against a
  launcher in the extension's `globalStorage` — a path keyed by extension **id**, not version
  (`src/core/globalMcpLauncher.ts`) — which resolves the current build from a sibling pointer file
  refreshed on each activation. Because the registered path can no longer rot across an extension
  update, `deactivate()` no longer removes anything (`src/extension.ts`), and registration is
  idempotent: `ensureTaskwrightMcpRegistered` (`src/core/claudeMcp.ts`) reads the current entry and
  rewrites `~/.claude.json` **only** when it is missing or stale.

  This also fixes the stale version-pinned entry it was originally working around — registrations
  pointing at a deleted install directory (`Cannot find module …taskwright-0.0.1\dist\mcp\server.js`)
  are impossible now that the registered path is version-independent. Coverage:
  `src/test/unit/{globalMcpLauncher,claudeMcp}.test.ts`.

## [1.6.0] — 2026-07-11

The **Agent-authoring ergonomics** release: `create_task` takes a task's full field set in one call,
the session-start convention no longer nags for a task on standalone requests, and plans authored
mid-execution are attached to their task.

### Added

- **`create_task` full field parity with `edit_task`.** The `create_task` MCP tool now accepts the
  same body and reference fields as `edit_task` — `acceptanceCriteria`, `definitionOfDone`,
  `implementationPlan`, `implementationNotes`, `finalSummary`, and `references` — folded into a single
  write on both the task and draft paths (`src/core/createTaskCore.ts`, `src/mcp/handlers.ts`,
  `src/mcp/server.ts`). An author (human or agent) can seed a fully-specified task up front instead of
  following every `create_task` with an `edit_task`. The tool description and the `create-task` skill
  now instruct filling in as many fields as possible to avoid ambiguity.

### Changed

- **Scoped the "which task?" clarification to task-work requests.** The agent session-start convention
  (the AGENTS.md/CLAUDE.md blocks in `src/core/agentConvention.ts` and the MCP server instructions in
  `src/mcp/instructions.ts`) now asks which task to work on **only** when the user asked to work on a
  board task without naming one. A standalone request — a code review, a question, an ad-hoc change —
  proceeds without an active task instead of prompting for one.
- **Plans authored mid-execution are attached to their task.** The `execute-task` skill gains
  `attach_plan` (and `writing-plans`) plus an explicit step: any spec or plan written while running a
  task is linked to the task with `attach_plan`, so its checkbox progress surfaces on the board and
  survives a handoff. `orchestrate-board` documents that this happens via `/execute-task`.

### Docs

- **Clarified MCP registration scope.** The README's "MCP registration lifecycle" section now
  explains why **user scope** is the general path (the server binary ships in the extension and roots
  at whatever project you open, so any Taskwright-initialized project works with one registration)
  versus the **project-scope** `.mcp.json` + `scripts/taskwright-mcp.cjs` path, which only applies
  inside the Taskwright source checkout and its worktrees (the launcher needs a built `dist/`).
  Includes how to resolve a `taskwright` scope conflict when developing Taskwright itself.

## [1.5.0] — 2026-07-11

The **Cross-Agent Skills & Security-Hardening** release: Taskwright's workflow skills now install as
native, progressively-disclosed skill packages for both Claude Code and Codex (with a distributable
Codex plugin); the rendered-Markdown surfaces neutralize unsafe link/image targets; a reviewed-baseline
dependency-audit gate guards CI against regressions; and the dev/release automation is fully
cross-platform with a Windows + Linux CI matrix.

### Added

- **Native cross-agent skills + `.codex-plugin` bundle.** The four user-facing workflow skills
  (`create-task`, `execute-task`, `index-codebase`, `orchestrate-board`) now render for **both agents
  from one versioned source** (`dist/skills`): Claude Code keeps its `.claude/skills` install, and Codex
  now receives them as native `SKILL.md` packages under `<root>/.agents/skills/<name>/` — its canonical
  progressive-disclosure discovery surface — replacing the capability-reducing "custom prompt"
  approximation. A new pure core (`src/core/agentSkills.ts`: `installAgentSkills` / `discoverAgentSkills` /
  scoped `uninstallAgentSkills`) drives the Codex install, and `setUpCodexIntegration` now installs skills
  (its command is retitled "MCP + skills"). A new **distributable Codex plugin** is built to
  `dist/codex-plugin/` (`src/core/codexPlugin.ts` + `scripts/build.ts` `bundleCodexPlugin`): a valid
  `.codex-plugin/plugin.json` manifest, the plugin's own bare-map `.mcp.json`, and a repo-scoped
  marketplace descriptor, bundling the skills alongside the Taskwright MCP server so a teammate can
  install the whole workflow in one step. It ships as a **separate distribution artifact** (excluded from
  the VSIX). New `docs/codex-plugin.md` documents the install/update/uninstall flows.

### Security

- **Centralized Markdown URL sanitization.** Every rendered task/document Markdown surface now routes
  through one dependency-free policy (`src/core/sanitizeUrl.ts`) that neutralizes unsafe link and image
  targets — `javascript:`, `data:`, and `vbscript:` schemes, including mixed-case, whitespace-,
  control-char-, and HTML-entity-obfuscated variants — while preserving safe `http`/`https`/`mailto` and
  workspace-relative links. The choke point runs in `parseMarkdown.ts` after `marked.parse` (unsafe
  `href`/`src` attributes are dropped, leaving inert text), raw HTML stays disabled, and the three webview
  markdown click handlers import the **same** policy for defense-in-depth at click time — one policy, no
  drift. Covered by 24 adversarial unit cases plus end-to-end and Playwright link-activation tests.
- **Reviewed-baseline dependency-audit CI gate.** A new gate (`src/core/auditGate.ts` +
  `scripts/audit-gate.ts` + `security/audit-allowlist.json`) fails CI on any non-allowlisted advisory at
  or above the `high` threshold, or on any expired exception, while reporting lower-severity findings
  only. It is **churn-resilient**: the green baseline is the curated, time-bounded allowlist rather than a
  raw `bun audit` count, so a genuinely new high/critical advisory forces human triage instead of silently
  flipping a number. The accompanying triage (`security/dependency-audit.md`) confirmed the shipped VSIX
  carries only bundled `dist/` (no `node_modules`), so every current advisory is a dev/build/test
  transitive that never reaches users; no dependency versions changed. Wired into
  `.github/workflows/ci.yml` and the `audit` / `audit:gate` / `ci` scripts.

### Changed

- **Cross-platform dev & release automation + Windows/Linux CI matrix.** The five bash tooling wrappers
  (license generation/check, e2e, CDP, screenshots) are ported to portable `bun`-run TypeScript
  (`scripts/*.ts` with shared `scripts/lib/{platform,run}.ts`), so no `package.json` script shells out to
  `bash` anymore. A detection bug that funnelled Git-Bash/Windows into `xvfb` is fixed — `xvfb-run` now
  wraps display-driven suites on **headless Linux only**. CI's portable verification core (install,
  engines, lint, typecheck, depcheck, audit, test, build, license check) now runs on **`ubuntu-24.04` and
  `windows-latest`**, with the display / apt / VS-Code-download suites kept Linux-only. The docs gain a
  Platform-support / prerequisites section and drop the stale "≈22 POSIX tests fail on Windows" note.

### Fixed

- **Repository formatting & webview accessibility debt.** The whole repo is back under `prettier --check`
  (68 pre-existing debt files reformatted; `.prettierrc` uses `endOfLine: auto` to avoid CRLF/LF churn).
  Webview accessibility oversights are resolved without changing intended visuals: a global
  `:focus-visible` outline restores the focus ring for the many `all: unset` controls; `aria-label`s were
  added to title-/placeholder-only icon buttons and form controls across the board (tabs, tree-canvas
  zoom, popovers, checklists, config, list filters, create-task, task header); modals and menus became
  proper `role=dialog` / `role=group` with focus management and Escape handling; and drag-only mutations
  retain keyboard equivalents. The webview build now emits **0 accessibility warnings**, guarded by a new
  `e2e/accessibility.spec.ts`.
- **Documentation & release-metadata drift reconciled.** Codex now installs the workflow skills as
  native `.agents/skills/` SKILL.md packages, so the README, the `taskwright.dispatchAgent` setting
  description, the Codex setup prompt/comments, and the Codex dispatch template no longer describe the
  retired "custom prompt" mechanism. The Marketplace `description`/`keywords` now name Codex alongside
  Claude Code. The MCP server advertises the real package version (was a stale `0.0.1` placeholder)
  by deriving it from `package.json`. A new `releaseMetadata` unit test keeps the CHANGELOG's newest
  version, the MCP server version, and the agent keywords reconciled with `package.json`
  automatically.

## [1.4.0] — 2026-07-11

The **Hidden-Worktree Board Home** release: an opt-in third sync mode, `git-auto`, that moves the
board out of the code tree into a hidden worktree of the `taskwright-board` branch and makes
versioning + sharing automatic — event-driven, never a poll loop, with a migration hardened for
every prior board state.

### Added

- **`sync.mode: git-auto` — the board in a hidden worktree.** The board's one physical home becomes
  a linked worktree of the `taskwright-board` branch at `.taskwright/board/`; `config.yml`, `docs/`,
  and `decisions/` stay in the repo `backlog/` (they version with the code). Structural wins: task
  files can never be wrongly tracked on a code branch, board edits can never dirty a code tree or
  collide with a merge, and the board gets real git history. `off` and `git` keep their exact
  previous behavior.
- **Event-driven auto-sync engine.** Board writes are debounce-committed (staging pathspec-limited
  to the five board state dirs, so a board commit can never carry a stray path older clients would
  refuse); on events — activation, write bursts, `request_merge` boundaries (also from headless MCP
  sessions), and the manual commands — a single-flight pass runs commit → fetch (explicit refspec) →
  union-merge fold of a diverged remote as a real two-parent commit → `reset --keep` → best-effort
  push, under a cross-process lock. Offline or push-rejected states accumulate locally and surface in
  the status bar; a sync failure never blocks a board write or a git operation, and same-task
  conflicts always resolve by newer `updated_date` and are always surfaced.
- **Guarded migration via the Enable Board Sync mode picker.** `taskwright.enableSync` now offers
  `off | git | git-auto` and performs the migration itself (hand-flipping the setting is documented
  as unsupported). The migration classifies and handles every prior state: fresh repos, git-ignored
  boards, boards **tracked on code branches** (untracks them and upgrades stale gitignore blocks that
  predate `backlog/milestones/`), existing `git`-mode refs with diverged remotes (the seed continues
  the ref's history so the remote push stays fast-forward), v1 leftovers (`board.materialized`
  markers), fresh clones, and repeated runs (idempotent). Ordering is the safety argument: a ref
  snapshot is taken first, every file is byte-verified in the new home **before** its primary copy is
  removed, and the mode only flips after the verified move. Switching back out of `git-auto` moves
  the board into `backlog/` again (the branch is kept as the durable store).
- **Fresh-clone bootstrap + split-brain healing.** Activation in `git-auto` recreates a missing
  board worktree from the local or remote branch (a teammate cloning the repo gets the board
  automatically) and folds any stray board files a stale writer left in the repo `backlog/` back
  into the board. Three new board-doctor findings with one-click repairs cover the failure states:
  `board-worktree-missing` (e.g. after `git clean -dfx` — committed history survives on the branch),
  `board-strays-in-primary`, and `board-mode-mismatch` (the board "looks empty" because the mode was
  flipped by hand — restore or return).
- **UX + escape hatches.** The Board Sync status-bar item shows the Auto state, last sync, and
  conflicts; its quick-pick gains **Sync Board Now** and **Switch Sync Mode…**. `push_board` /
  `pull_board` (MCP tools and commands) remain available in `git-auto` — they run the same sync pass.

### Changed

- Language providers (completion, links, hover) now also cover `backlog/milestones/` files.
- **Known divergence (documented):** upstream Backlog.md CLI tools expect `backlog/tasks` at the
  repo root and therefore do not see the board while `git-auto` is active; `off`/`git` keep full
  upstream compatibility.

## [1.3.0] — 2026-07-11

The **Pipeline Refinement & Multi-Agent Support** release: a tunable, observable, resumable merge
gate; health checks with one-click repairs for the board and the verify commands; per-session claim
identity; and first-class Codex support alongside Claude Code.

### Added

- **Configurable verify timeout + machine-readable merge aborts.** The merge gate's hardcoded
  10-minute verify cap is now the `taskwright.mergeVerifyTimeoutMinutes` setting (default 10), and an
  agent that measured its suite can raise it per call via the `request_merge` tool's
  `verifyTimeoutMinutes` parameter (clamped by `taskwright.mergeVerifyTimeoutMaxMinutes`, default
  uncapped). A killed command now aborts with an actionable reason — "verify timed out after Ns on
  `cmd` (raise `taskwright.mergeVerifyTimeoutMinutes` or pass `verifyTimeoutMinutes`)" — never a
  generic "Verification failed". Every `request_merge` abort also carries a machine-readable `code`
  (`verify_timeout` | `verify_failed` | `dirty_worktree` | `dirty_primary` | `rebase_conflict`) so
  `/orchestrate-board` can branch on outcomes instead of parsing prose.
- **Verify-command doctor.** A pure core (`src/core/verifyDoctor.ts`) detects the repo type (node
  with package manager and scripts, python with uv, rust, go) and flags configured verify commands
  that provably cannot run (`bun run test` with no such script), suggesting runnable replacements
  (`<pm> run test|lint|typecheck` from existing scripts, `uv run pytest -q`, `cargo test`,
  `go test ./...`). Runs at activation (notifies only when the gate is misconfigured) and from the
  setup command (confirms a healthy gate out loud); a one-click "Apply suggested commands" persists
  durably — the doctor never rewrites anything silently.
- **`request_merge` unpinned from the agent process.** The MCP server now emits progress
  notifications during verify (command name, i/n, elapsed) and the queue wait (position, approval
  state) so clients that reset tool timeouts on progress survive long suites and slow reviews. A new
  `waitMinutes` parameter bounds the wait: on expiry the call returns
  `{ status: "pending", queuePosition, ticket }` instead of blocking forever — the queue entry and
  board status are kept, and a later `request_merge` for the same task (+ `ticket`) resumes
  idempotently (no re-enqueue, no duplicate verify when the base didn't move; a reviewer Send-back
  while parked returns `sent_back`). The fully-blocking default is unchanged, and the `/execute-task`
  and `/orchestrate-board` skills document the poll-or-park handling of `pending`.
- **Per-session claim identity.** `claim_task` derives a stable `@agent/<branch>` identity from the
  worktree instead of the generic `@agent`, so after a restart a session can tell "my claim" from
  someone else's: re-claiming your own task is an idempotent no-op, a live foreign claim returns
  `surrendered`/`heldBy` instead of silently overwriting, and legacy `@agent` claims upgrade in
  place. The kanban badge and tree popover show the short identity (full identity + worktree in the
  tooltip). Works for any agent brand — identity comes from the worktree, not the tool.
- **Board doctor.** `diagnoseBoard` (`src/core/boardDoctor.ts`) detects accumulated board drift —
  dangling active-task pointer, stale handoff files for Done tasks, orphaned worktree dirs, in-flight
  tasks with no claim and no worktree, claims whose worktree vanished, mangled category values, and
  dangling folded-frontmatter continuation lines — and offers per-finding one-click repairs routed
  through the existing writers (nothing is deleted without confirmation). Runs silently-when-clean at
  activation, on demand via the new **`taskwright.doctor`** command, and read-only via the new
  **`board_doctor`** MCP tool so `/orchestrate-board` can pre-flight the board.
- **Codex integration scaffolding.** The new **`taskwright.setupCodexIntegration`** command registers
  the Taskwright MCP server in Codex's `~/.codex/config.toml` (idempotent, content-preserving upsert;
  reuses the same `scripts/taskwright-mcp.cjs` launcher so worktrees resolve the primary build
  exactly as with Claude) and installs the four user-facing skills (create-task, execute-task,
  index-codebase, orchestrate-board) as Codex custom prompts rendered from the same SKILL.md sources.
  The AGENTS.md convention block is now agent-neutral and names both registration surfaces.
- **Agent-agnostic dispatch.** The new `taskwright.dispatchAgent` setting (`claude` | `codex`,
  default `claude`) selects a dispatch profile — per-agent prompt template and suggested terminal
  command, kept as data (`src/core/dispatchProfiles.ts`), never a fork of the pipeline; both
  templates carry the identical worktree / `bun install` / no-root-commit / `request_merge` contract.
  The terminal-launch guardrail generalizes from `claude -p` only to a headless deny-list
  (`claude -p`/`--print`, `codex exec`, generic `--headless`/`--non-interactive`) applied regardless
  of the selected agent — subscription safety is a principle, not a Claude feature. A custom
  `taskwright.dispatchTemplate` still wins untouched.

### Changed

- **Queue-head re-verify is skipped when the base didn't move.** The verify suite used to run twice
  per merge — pre-enqueue and again at queue head — even when `main` never advanced during the wait.
  The pre-enqueue verify now records the worktree HEAD SHA (persisted on the queue entry, so the skip
  also works across a `pending` resume); at queue head, an unchanged HEAD after the post-wait rebase
  proves the verified tree is byte-identical to the tree being merged and the second run is skipped.
  Halves merge wall-time in the common single-agent case; any unresolvable HEAD fail-safes to
  re-verify.
- **Primary-dirty abort relaxed to real collisions.** `request_merge` used to abort on ANY
  uncommitted change in the primary tree outside `backlog/` — including unrelated untracked files —
  which drove agents to stash WIP or hand-edit git excludes. It now blocks only files that actually
  intersect the merge footprint (`git diff --name-only base..branch` vs the primary's porcelain
  paths), names exactly which files block, and merges cleanly past unrelated WIP. A failed footprint
  diff falls back to the previous strict check.

### Fixed

- **`merge-config.json` no longer clobbered on activation.** `syncMergeConfig` rewrote the shared
  `<commonDir>/taskwright/merge-config.json` wholesale from VS Code settings on every activation —
  `cfg.get()` returns package.json defaults for unset keys, so any agent/CLI fix (e.g. corrected
  verify commands in a non-bun repo) was silently reverted on the next extension restart. It now
  republishes only keys the user explicitly set (via `cfg.inspect()`), merged over the existing file
  (explicit setting > file > default); missing/corrupt files still materialize full defaults.
- **Folded-scalar claim corruption.** A full task rewrite (gray-matter, `lineWidth` 80) could fold a
  long `worktree:` value into a `>-` block, and the surgical claim removers only filtered the key
  line — orphaning the indented continuation onto the next frontmatter field (observed as mangled
  `category` values). Removal is now continuation-safe (`removeFieldLines` sweeps folded scalars and
  block sequences), and the writer collapses the Taskwright surgical keys (`claimed_by` / `worktree`
  / `claimed_at` / `plan`) back to a single line on rewrite. The board doctor detects and repairs the
  historical damage.
- **Indicator-badge overflow at long claim identities.** A 95-char `claimed_by` could spill past the
  kanban card: every indicator badge (claim / merge / active / readonly) now clips and its label
  shrink-ellipsizes, and the tree DetailPopover shows the short claim identity instead of a 4-line
  raw identity + worktree blob (full identity in the tooltip). Pinned by Playwright regression tests.

## [1.2.1] — 2026-07-08

### Fixed

- **`request_merge { worktree }` on Windows (drive-letter case).** The worktree-target validation
  compared paths with a strict `===` after `path.resolve`, which normalizes separators but NOT the
  Windows drive-letter case. `git worktree list` reports `C:\…` while the session-derived
  `primaryRoot` can be `c:\…`, so a primary-rooted close aborted with "not a linked worktree." Path
  comparison is now case-insensitive on Windows (`isSamePath`). This is the second half of the 1.2.0
  primary-tree fix — together they make `request_merge { worktree }` actually work from a
  primary-rooted session on Windows.

## [1.2.0] — 2026-07-08

Conflict-safe orchestration, plus a fix to the from-any-session merge close.

### Added

- **Conflict-safe parallel batching for `/orchestrate-board`.** `next_ready_tasks` gains a
  `parallelSafe` option that returns only ready tasks whose attached-plan file footprints are
  pairwise disjoint (a task with no plan / unknown footprint comes back solo), so the orchestrator
  can dispatch a parallel batch that won't collide at merge time. New pure core `src/core/planFiles.ts`
  (`extractPlanFiles` / `selectDisjointBatch`); the `/orchestrate-board` skill's parallel mode pulls the
  batch this way and documents that any conflict which still slips through is the dispatched agent's to
  resolve during `request_merge`'s rebase.

### Fixed

- **`request_merge { worktree }` from the primary tree.** `gitFacts` resolved git's relative `.git`
  output (what `git rev-parse --git-dir` / `--git-common-dir` return from the primary tree) against the
  MCP process cwd instead of the session root, so a primary-rooted close wrongly reported the target
  "is not a linked worktree." Now resolved against the exec cwd — correct for both the primary tree's
  relative output and a linked worktree's absolute output; the two merge-queue lookups got the same fix.
- **Docs:** corrected the CLAUDE.md "~22 Windows unit-test failures" note — the suite is
  path-separator-agnostic (TASK-4) and the Windows baseline is 0 failures.

## [1.1.0] — 2026-07-08

The **Orchestration & UX Polish** release: run the full task cycle from any Claude session (not only a board dispatch), drive the whole board autonomously, fix the skill-scaffolding packaging, and repair two board-view UX regressions.

### Added

- **Run `/execute-task` from any session** — a primary-rooted session (not just a board-dispatched worktree) can now take a task end to end. New MCP tool **`start_task`** bootstraps (or reuses) the task's `.worktrees/<branch>`, seeds its active task, clears any stale cancellation marker, and returns a relaunch hint. **`request_merge`** gains an optional `worktree` target so the close (rebase → verify → merge queue → fast-forward → Done → cleanup) can be driven for an explicit linked worktree from a primary-rooted session, validated by four gates (containment under `.worktrees/`, real linked worktree, non-detached, clean). The `/execute-task` skill now detects linked-vs-primary rooting and either proceeds directly (dispatched), or bootstraps via `start_task` and relaunches into the worktree / continues single-session and closes with `request_merge { worktree }`.
- **`/orchestrate-board` skill** — an autonomous board runner: pulls the ready set and takes each task to Done, either self-driven sequentially or via parallel in-session `Task` subagents (each bootstrapping its own worktree and running `/execute-task`), with a capped fan-out, claim-before-work anti-collision, merge-queue-serialized merges, and stop conditions (drained / all-blocked / user budget / no-progress). Subscription-safe — parallelism is in-session subagents, never `claude -p`.
- **`next_ready_tasks` MCP tool** — returns the tasks ready to execute now (every dependency Done, unclaimed / non-stale, unblocked, not already in the merge queue), ordered by priority then ordinal, with `category` / `milestone` / `limit` filters.
- **Broader "Set Up Claude Code Integration" scaffolding** — installs a fourth skill (`orchestrate-board`), injects an `AGENTS.md` convention block (in addition to `CLAUDE.md`), and can optionally write a project-local `.mcp.json` plus copy the committed `taskwright-mcp.cjs` launcher into the repo (opt-in via `taskwright.setupWritesProjectMcpJson`, default off). `visual-proof` / `agent-browser` remain dev-only and are never installed.

### Fixed

- **Skill install shipped broken in packaged builds** — `.claude/skills/**` was excluded from the VSIX and never bundled, so "Set Up Claude Code Integration" silently no-op'd on a published install (it worked only from a dev checkout). Skills are now bundled to `dist/skills/` at build time and installed from there, and a missing source is logged instead of silently skipped.
- **Kanban board and list view now scroll on both axes** — a board taller than a narrow sidebar was clipped with no vertical scrollbar (`.kanban-board` had `overflow-x` only, and `body.tasks-page` clipped the overflow). `#kanban-app` is now the single both-axes scroll container; milestone/label-grouped and nested boards keep their own horizontal scroll; the list and archived views scroll too.
- **Trackpad pan/zoom on the tree canvas** — the earlier mouse-wheel-zoom change had inverted trackpad gestures (a two-finger scroll zoomed, a pinch panned). A wheel classifier now routes correctly: two-finger scroll pans, pinch (and Ctrl/⌘+scroll) zooms, and the mouse wheel still zooms at the cursor.

## [1.0.0] — 2026-07-04

Taskwright 1.0 is the first stable release of the agentic task board for VS Code. It began as a fork of [vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT) and grew into a full platform for triaging work onto a git-native board and dispatching isolated Claude Code sessions per task.

### Tech-tree (flagship)

The **Tree tab** is a spatial dependency graph that replaces flat lists with a canvas where lanes = categories and bands = milestones/ages.

- **Layout engine** (`treeLayout`) — lane/band/depth/subRow derivation from the task graph; cycle detection and dependency gating via `treeGate`; config-driven priority ordering.
- **Canvas** (`TechTreeCanvas.svelte`) — pan/zoom with level-of-detail (LOD) scaling; sticky lane labels and age-band headers; `TreeNode` cards with status/claim/priority styling; `EdgeLayer` SVG overlay for prerequisite/blocking/bug edges; toolbar with fit-to-screen and zoom controls.
- **Interaction shell** — state-aware `DetailPopover` on node click (claim, dispatch, quick-edit); ephemeral active-task via popover open/close; `MilestonePopover` with file-backed release checklist; `InFlightPanel` showing active and merge-queue tasks; `TreeNavigator` sidebar with filterable minimap and click-to-jump; promote draft nodes per-node or "Promote all proposed."
- **Create surface** — unified `CreateTaskForm` (full / quick / bug modes) triggered from keyboard shortcuts (`Ctrl/Cmd-N`, `Ctrl/Cmd-Shift-N`), the TabBar `+`, or the **Report bug** popover action; shared `createTaskWithTreeFields` core with parity between human UI and MCP `create_task`.
- **Drag surface** — drag-to-connect (left handle = needs, right handle = unlocks) with green/red target validation and client-side cycle detection; drag-to-reslot (vertical = category, horizontal = milestone, in-cell = ordinal); edge removal via close hit-path; drop-on-empty-canvas opens the create form pre-linked; click-in-place infers lane/band from the clicked cell.
- **AI authoring (`/create-task` skill)** — turns a brief into a set of PR-sized, dependency-linked draft tasks slotted into lanes/milestones; new MCP read tools (`list_categories`, `list_milestones`, `get_board`, `search_tasks`) and write tools (`create_category`, `promote_drafts` with dependency-edge remap); drafts render on the canvas for human review before promotion.
- **Execute task (`/execute-task` skill)** — loads one task end-to-end in its worktree: verify worktree root, claim, adaptive strategy (attached plan -> SDD; independent subtasks -> subagent-driven; else TDD), record progress, mandatory cancellation checkpoint, `request_merge`.
- **Codebase indexing (`/index-codebase` skill)** — bootstraps an initial tree over an existing repo via git forensics (tags, churn, module structure, docs); mines `TODO`/`FIXME` gaps; emits draft nodes (never auto-promotes).
- **Status-carrying drafts** — drafts are orthogonal to completion status: a Done baseline can be a draft; `promoteDraft`/`demoteTask` preserve status; legacy `status: Draft` migrates on read.
- **`create_milestone` MCP tool** — creates milestone bands; idempotent on name; band order = creation order (not a stored ordinal).

### Agentic task board

The core workflow that makes Taskwright "agentic": a session pulls its task from the board, claims it, works, and reports back.

- **Advisory claiming** — `claimed_by` / `worktree` / `claimed_at` frontmatter written surgically; claim badge on kanban cards and tree nodes; `claim_task` / `release_task` commands and MCP tools; staleness detection (`isClaimStale`, default 12 h); conflict resolution on foreign-claim override.
- **Taskwright MCP server** — stdio JSON-RPC server (`src/mcp/server.ts`, bundled to `dist/mcp/server.js`); 20+ tools: `get_active_task`, `claim_task`, `release_task`, `create_task`, `edit_task`, `create_subtask`, `promote_draft`, `demote_task`, `complete_task`, `archive_task`, `restore_task`, `attach_plan`, `create_category`, `create_milestone`, `get_board`, `search_tasks`, `list_categories`, `list_milestones`, `promote_drafts`, `push_board`, `pull_board`; routes `console.log` to stderr so stdout stays clean JSON-RPC.
- **Active-task handoff** — pull-based via `<root>/.taskwright/active-task.json` (git-ignored, per-worktree); set ephemerally by tree-node popover open/close or by dispatch; `get_active_task` returns full context including plan, plan progress, subtasks, and parent task.
- **Subscription-safe dispatch** — `dispatchTask` renders a paste-ready prompt and copies it to the clipboard; **never** spawns `claude -p`; configurable template (`taskwright.dispatchTemplate`) with `{{placeholder}}` substitution; defaults to `bun install && /execute-task` in the worktree.
- **"Categorize with Claude" intake** — captures raw notes from the active editor, renders a paste-ready prompt constrained by the board's labels/statuses/priorities; subscription-safe.
- **Superpowers bridge** — `attach_plan` MCP tool links a task to its implementation plan/spec; `planProgress` parses `- [ ]`/`- [x]` checkboxes from the plan file; detail-panel plan banner with progress bar and Open/Detach/Attach actions.

### Merge queue

A shared FIFO merge queue so multiple agents can integrate safely without colliding.

- **Queue core** — file-backed JSON queue (`.taskwright/merge-queue.json`); enqueue/dequeue with position tracking; `request_merge` orchestrator (rebase onto base branch -> run verify commands -> enqueue -> wait for turn -> fast-forward merge or open PR -> mark task Done -> remove worktree).
- **Merge-review board status** — mode-named status columns (`In Review`, `Approved`, `Changes Requested`); approve/send-back commands with per-task status; **In-Flight panel** on the tree canvas showing active and queued tasks with Approve/Send back controls.
- **Worktree isolation guard** — pre-commit hook blocks commits in the repo root (shared with other agents); `request_merge` is the only integration path.

### Board Sync v2

Replaced the v1 live-CAS engine (which kept N copies of the board and a poll loop trying to reconcile them) with a single-shared-board architecture.

- **Single board root** — exactly one physical board (the primary checkout's `backlog/`), resolved from any worktree via `resolveBoardRoot()`; no per-worktree copies, no poll loop, no CAS.
- **Atomic writes** — `atomicWriteFileSync` (write-temp-then-rename) for all board mutations; `claim_task`/`release_task` are direct surgical writes.
- **Push/pull** — `push_board` / `pull_board` MCP tools and command-palette commands snapshot the board onto a `taskwright-board` ref (isolated index — never touches the user's HEAD/index/branch); union-merge divergence via `mergeBoards()` (per-file: only-one-side keeps it, both-sides-edited resolves by newer `updated_date` with conflict surfaced, never silently dropped).
- **Opt-in hooks** — `pre-push` and `post-merge` git hooks (`taskwright.sync.installHooks`) automate push/pull; degrade gracefully (log, never abort the git op).
- **Status-bar UX** — shows sync mode, last-sync time, and conflict count; conflict notifications always offer an "Open" action.
- **Config migration** — legacy `local`/`github` sync modes auto-remap to `off`/`git`; `taskwright.enableSync` idempotently seeds the ref and migrates settings.

### Build & infrastructure

- **Build-independent MCP in worktrees** — `.mcp.json` launches the MCP server via the committed `scripts/taskwright-mcp.cjs`, which resolves the primary checkout and runs its already-built `dist/mcp/server.js` in-process; no per-worktree build needed.
- **Claude Code integration** — `Taskwright: Set Up Claude Code Integration` registers the MCP server at user scope and writes the agent convention to `CLAUDE.md`; auto-refreshes on activation; best-effort removes on deactivation.
- **Cancellation protocol** — `cancelDispatch` writes a presence-only cancellation marker **first** (before release/reset/remove), so a `git worktree remove --force` that sweeps `.taskwright/` can't resurrect the directory and defeat isolation.
- **Commit format** — `@` prefix convention (`@ Add feature` / `@ Fix bug`) for agent-authored commits.
- **Testing** — four-tier strategy: Vitest unit tests, Playwright webview UI tests, VS Code extension e2e tests, CDP cross-view integration tests; comprehensive coverage across all feature areas.

### v0.1.0 (initial fork)

- Imported and rebranded from [vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT).
- Kanban board with drag-and-drop, task list, detail editor, Markdown/Mermaid rendering, frontmatter autocomplete.
- `BacklogParser` / `BacklogWriter` for reading and writing Backlog.md task files.

[1.9.0]: https://github.com/ChronoVortex07/taskwright/releases/tag/v1.9.0
[1.0.0]: https://github.com/ChronoVortex07/taskwright/releases/tag/v1.0.0
