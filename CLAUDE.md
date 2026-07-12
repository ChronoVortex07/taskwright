# Taskwright — agent guide

Taskwright is a VS Code extension: an **agentic task board** where you triage bugs/improvements onto a
git-native board, then dispatch a **fresh, isolated Claude Code session per task** so unrelated work
never pollutes one session. Storage backbone is [Backlog.md](https://github.com/MrLesk/Backlog.md)
(plain Markdown tasks in git). Derived from
[vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT).

## Build & test

- Requires Node **≥ 22** and [Bun](https://bun.sh). `bun install` → `bun run build` → press F5 to launch.
- `bun run test` (Vitest), `bun run lint`, `bun run typecheck`.
- **Windows note:** the unit suite is path-separator-agnostic (TASK-4) and passes **fully on Windows**,
  Linux, and CI — the current baseline is **0 failures** on all three. (Historically ~22 upstream tests
  asserted POSIX paths and failed on Windows; that was fixed — just don't reintroduce POSIX-only path
  assertions.)
- **Cross-platform automation (TASK-101):** every `package.json` script runs on Windows/macOS/Linux
  with no `bash` — the old `scripts/*.sh` wrappers were ported to TypeScript run via `bun`
  (`scripts/generate-licenses.ts`, `check-licenses.ts`, `run-e2e.ts`, `run-cdp-tests.ts`,
  `screenshots/run.ts`). The shared, unit-tested platform branching is `scripts/lib/platform.ts`
  (`shouldUseXvfb`/`withXvfb`): display-driven suites (`test:e2e`, `test:cdp`, `screenshots`) auto-wrap
  in `xvfb-run` on **headless Linux only** and run against the native display on Windows/macOS. CI
  (`.github/workflows/ci.yml`) matrixes the portable core over `ubuntu-24.04` + `windows-latest`; the
  xvfb/apt/VS-Code-download suites stay Linux-only. Prereqs live in `CONTRIBUTING.md` (Platform
  support). When adding a script, don't shell out to `bash` — write a `bun`-run `.ts` and reuse
  `scripts/lib/`.

## Architecture (inherited)

- `src/core/` — `BacklogParser`/`BacklogWriter` (read/write task files), `BacklogCli` (shells out to the optional `backlog` CLI — used only for the cross-branch board view), `GitBranchService`, `FileWatcher`,
  `AgentIntegrationDetector`.
- `src/providers/` — webview views (Kanban, task list/detail/preview).
- `src/language/` — completion, hover, document links.

## Coupling rules (important)

- **Read** task data by parsing `backlog/tasks/*.md` directly. **Write** through Taskwright's own
  `BacklogWriter` (`src/core/BacklogWriter.ts`), which reproduces Backlog.md's frontmatter
  byte-for-byte; agents reach it via the Taskwright MCP write tools (`create_task`, `edit_task`,
  …). The external `backlog` CLI is no longer required for task CRUD.
- Don't reimplement Backlog.md CRUD — the Taskwright MCP server (`.mcp.json`) already exposes it.

## Taskwright additions (see the project plan)

- **Advisory claiming** ✅ (Phase 2): `claimed_by` / `worktree` / `claimed_at` frontmatter written
  surgically by `src/core/claims.ts` + `ClaimService` (Backlog.md's canonical frontmatter round-trips
  untouched). Claim badge on kanban cards; Claim/Release control in the tree-node popover; `backlog.claimTask`
  / `backlog.releaseTask` commands. Staleness helper exists (`isClaimStale`); auto-expiry is Phase 5.
- **Active task + Taskwright MCP** ✅ (Phase 2): pull-based handoff via `<root>/.taskwright/active-task.json`
  (`src/core/activeTask.ts`, git-ignored, per-worktree). MCP server `src/mcp/server.ts` (stdio, bundled to
  `dist/mcp/server.js`, registered in `.mcp.json`) exposes `get_active_task` / `claim_task` / `release_task`;
  handlers in `src/mcp/handlers.ts`. Active is **ephemeral** via tree-node popover open/close — there is no
  "Set active" control (the `backlog.setActiveTask` / `backlog.clearActiveTask` commands remain).
  MCP server reuses only vscode-free `src/core` and routes stray `console.log`
  to stderr (stdout is the JSON-RPC channel).
- **Subscription-safe dispatch** ✅ (Phase 3): `backlog.dispatchTask` renders a paste-ready prompt and copies
  it to the clipboard — **never** spawns `claude -p`. Pure cores: `src/core/dispatchPrompt.ts` (configurable
  template + `{{placeholder}}` substitution; `backlog.dispatchTemplate` setting), `src/core/WorktreeService.ts`
  (`.worktrees/<branch>` isolation, **on by default** via `taskwright.dispatchCreateWorktree`; set `false` to opt out — but the `false` opt-out is incompatible with the P5 `/execute-task` auto-close flow (worktree required), so a no-worktree dispatch prepends an in-place manual-TDD NOTE to the prompt and warns the human), `src/core/handoff.ts`
  (`.taskwright/handoff/<id>.md`). Orchestration in `src/providers/dispatchActions.ts` (sets active task on the
  session root, optional terminal); "Dispatch" control in the tree-node popover. Visual proof + behavior coverage of
  the kept plan banner lives in `e2e/dispatch.spec.ts` (the claim / set-active / dispatch actions moved to the
  tree-node popover — covered by `e2e/tree-popover.spec.ts` + the CDP suite) — `bun run proof` builds
  and runs it, writing screenshots to `e2e/__screenshots__/dispatch/` (git-ignored).
  Opt-in `taskwright.dispatchOpenTerminal` + `taskwright.dispatchTerminalCommand` run a command (templated on `{{handoffFile}}`) in the worktree terminal; the command is refused if it uses `claude -p` (subscription-safe — `resolveTerminalLaunch` / `commandUsesClaudePrintMode` in `src/core/dispatchPrompt.ts`).
- **Build-independent MCP in worktrees** ✅: a dispatched `.worktrees/<branch>` has no git-ignored `dist/`, so
  `.mcp.json`'s old relative `node dist/mcp/server.js` never started and the agent lost every `taskwright` MCP
  tool. `.mcp.json` now launches the server via the committed, dependency-free `scripts/taskwright-mcp.cjs`,
  which resolves the **primary** checkout (via `git rev-parse --git-common-dir`) and runs its already-built,
  standalone `dist/mcp/server.js` in-process with the worktree as `TASKWRIGHT_ROOT` — so MCP tools are live at
  session start with no per-worktree build (pure `resolveMainServerPath` is unit-tested; the standalone bundle
  needs no `node_modules`). Caveat: the running server reflects the **primary** build, so a task editing the MCP
  server itself won't exercise its changes live until merged and the primary is rebuilt. For build/test, the
  worktree still needs deps: the dispatch prompt tells the session to `bun install` in its worktree on demand.
  (A `node_modules` junction was rejected — `request_merge`'s `git worktree remove --force` follows the reparse
  point and wipes the **shared** install.) Design:
  `docs/superpowers/specs/2026-07-01-buildable-worktrees-and-shared-mcp-design.md`.
- **Intake — "Categorize with Claude"** ✅ (Phase 3): `backlog.categorizeWithClaude` captures the raw notes in
  the active editor (selection, else whole doc), renders a paste-ready prompt constrained by the board's
  labels/statuses/priorities, and copies it to the clipboard for a session to create tasks via the Backlog.md
  MCP. Pure core `src/core/intakePrompt.ts` (+ shared `src/core/templateRender.ts`); glue in
  `src/providers/intakeActions.ts`; `backlog.intakeTemplate` setting. Subscription-safe — never spawns `claude -p`.
- **Superpowers bridge** ✅ (Phase 4): link a task to its implementation plan/spec and surface checkbox
  progress. Taskwright-only `plan` frontmatter field written surgically (`src/core/PlanService.ts` +
  generic `src/core/frontmatterEdit.ts`, shared with claims); `src/core/planProgress.ts` parses
  `- [ ]`/`- [x]` steps (superpowers 6.x format) and `src/core/loadPlanProgress.ts` reads the linked file.
  MCP `attach_plan` tool + `plan`/`planProgress` in `get_active_task` (`src/mcp/`). Detail-panel plan banner
  (progress bar, Open/Detach/Attach) wired via `src/providers/planActions.ts`; `backlog.attachPlan` /
  `backlog.detachPlan` commands. Plan paths are repo-root-relative. Note: superpowers 6.x tracks progress via
  checkboxes **inside** the plan file — there is no separate `.superpowers/sdd/progress.md`.
- **Multi-session polish** ✅ (Phase 5): `src/core/claimResolution.ts` (`resolveClaimAction`) drives
  claim-conflict surfacing (confirm before overriding a live foreign claim) and stale-claim expiry
  (claims older than `backlog.claimStalenessHours`, default 12h, are reclaimable without a prompt).
  Kanban cards show an active-task indicator and a stale-claim badge (amber), enriched in
  `TasksController` (`isActiveTask`/`claimStale`). Proof: `e2e/board-indicators.spec.ts`. (Cross-branch
  scanning was later made unconditionally inert by Board Sync v2, below.)
- **Board Sync v2 — single shared board + discrete push/pull** ✅: replaced the v1 GitHub live-CAS
  engine (which kept N copies of the board and a poll loop trying to reconcile them — root cause of
  silent rollbacks, file desyncs, and a blank Tree tab). v2 collapses to **exactly one physical
  board** (the primary worktree's `backlog/`), resolved from any worktree by `resolveBoardRoot()`
  (`src/core/boardRoot.ts`, parses `git worktree list --porcelain`) and used unconditionally by the MCP
  server (`resolveWorkspaceBacklogRoot`) and the extension host (`BacklogWorkspaceManager`) — there is
  nothing to reconcile because there is nothing to desync. Writes are atomic (`atomicWriteFileSync`,
  write-temp-then-rename, `src/core/atomicWrite.ts`); claims (`claim_task`/`release_task`) are direct
  surgical writes via `ClaimService`, no CAS. `check_active_branches` is effectively inert —
  `BacklogParser.getTasksWithCrossBranch` is unconditionally local-only, so there are no cross-branch
  ghost cards regardless of the setting.
  **Versioning is a separate, discrete layer**, not a live loop: `taskwright.sync.mode` is `off`
  (default; local git-ignored board, no versioning) | `git` (legacy `local`/`github` values migrate
  automatically to `off`/`git` on read, `src/core/syncConfig.ts`). When `git`, `push_board`/`pull_board`
  (MCP tools and `taskwright.pushBoard`/`taskwright.pullBoard` commands, one shared core
  `src/core/boardPushPull.ts`) snapshot the board onto a `taskwright-board` ref (reusing
  `src/core/boardRef.ts`'s isolated-index `snapshotBoardRoot`/`materializeToBoardRoot`, which never
  touch the user's HEAD/index/branch), union-merge divergence via the pure `mergeBoards()`
  (`src/core/boardMerge.ts` — per-file: only-one-side keeps it, both-sides-edited resolves by newer
  frontmatter `updated_date` with the conflict surfaced, never silently dropped), and push/materialize.
  A status-bar item + command palette (`src/core/boardSyncUx.ts`) surface mode/last-sync/conflicts;
  conflict notifications always offer an "Open" action. Opt-in, Windows-safe `pre-push`/`post-merge`
  git hooks (`taskwright.sync.installHooks`, `scripts/board-sync-hook.cjs`) call the identical
  push/pull core, `--no-verify` to avoid recursion, and degrade gracefully (log, never abort the git
  op) — never auto-installed. `taskwright.enableSync` is repurposed to idempotently ensure the
  gitignore/untrack migration, remap the mode to `git`, and seed the ref — it never pushes to a
  remote itself. `backlog/milestones/` is included in the versioned/snapshotted paths.
  Design: `docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md`; runbook:
  `docs/superpowers/plans/2026-07-04-board-sync-v2-execution-handoff.md`. The prior GitHub-only CAS
  design (`docs/superpowers/specs/2026-07-01-github-synced-board-design.md` and its
  `2026-07-01-synced-board-phase-{1..4}-*.md` plans) is superseded — kept for history only.
- **Hidden-worktree board home — sync.mode `git-auto` (TASK-91)** ✅: a third, opt-in mode. The
  board's ONE physical home moves out of the code tree into a linked worktree of the
  `taskwright-board` branch at `<primary>/.taskwright/board/` (`boardWorktreePathFor`;
  `resolveBoardRoot`/`resolveWorkspaceBacklogRoot` are mode-aware via `boardHomeFor` — the split
  root keeps `config.yml`/`docs`/`decisions` in the repo `backlog/`, and
  `BacklogParser.getPrimaryRoot()` replaced every `dirname(backlogPath)` repo-root derivation). A
  small **event-driven** engine (`src/core/autoSync.ts` — never a poll loop, the v1 postmortem is
  binding) debounce-commits board writes (pathspec-limited to the five state dirs so old v2 clients'
  non-board-path pull guard never trips) and on events (activation, write burst, `request_merge`
  boundaries in the MCP server, manual push/pull/Sync-Now) runs commit → staged-ref fetch →
  `mergeBoards()` two-parent fold → `reset --keep` → best-effort push under a cross-process lock;
  failures degrade to the status bar and never block a board write or git op. Migration is **only**
  via the `taskwright.enableSync` mode picker (never a hand-flip — the setting description warns):
  the S0–S6 prior-state matrix (`src/core/boardHomeMigration.ts` — fresh, ignored,
  TRACKED-on-code-branch incl. stale 4-dir gitignore blocks, existing v2 ref ± remote, v1
  `board.materialized` leftovers, fresh clones, re-runs) is classified and executed with a pre-move
  ref snapshot and a per-file verify-before-delete move; the mode flips only after the verified
  move; reverse migration (git-auto → git/off) is supported. Activation in git-auto bootstraps
  fresh clones (`ensureBoardWorktree`, branch seeded local-ref > remote > empty root) and heals
  split-brain strays (`foldPrimaryStrays`); board doctor gains `board-worktree-missing` /
  `board-strays-in-primary` / `board-mode-mismatch` repairs. Upstream Backlog.md CLI root-layout
  compat is dropped in git-auto only (documented). Coverage:
  `src/test/unit/{boardWorktree,autoSync,boardHomeMigration,gitAutoIntegration,boardDoctor,boardRoot,syncConfig,boardSyncUx}.test.ts`.
  Design: `docs/superpowers/specs/2026-07-10-hidden-worktree-board-home-design.md`; plan:
  `docs/superpowers/plans/2026-07-11-hidden-worktree-board-home.md`.
- **Tech-tree canvas (P2a)** ✅: a **Tree** tab (now the default view) renders the board as a dependency
  tech-tree. Pure core `src/webview/lib/treeGeometry.ts` computes node/edge geometry from the task graph
  (lanes = categories, bands = milestones/ages); the extension pushes layout via the `treeLayoutUpdated`
  message (`laneOrder`/`bandOrder`/`warnings`). Chrome: `TechTreeCanvas.svelte` host with `TreeNode`,
  `EdgeLayer`, `LaneBand`/`AgeBandHeader` band-lane scaffolding, plus pan/zoom and level-of-detail (LOD)
  scaling. Coverage: `e2e/tree-canvas.spec.ts`.
- **Tech-tree interaction shell (P2b)** ✅: node-centric actions replace the old detail-panel banners.
  `DetailPopover.svelte` surfaces state-aware claim / dispatch actions on a tree node and drives an
  **ephemeral** active task via popover open/close (`popoverActiveChanged` message) — there is no
  "Set active" control (the `backlog.setActiveTask` / `backlog.clearActiveTask` commands remain).
  **Promote** lives on draft `TreeNode`s and the canvas "Promote all proposed" button, **not** the
  popover. `src/core/cancelDispatch.ts`
  (v1) tears a dispatch down. `MilestonePopover.svelte` + `src/core/milestoneReleaseChecklist.ts` show a
  release checklist; `InFlightPanel.svelte` lists active/merge-queue tasks. A `TreeNavigatorProvider`
  WebviewView (`TreeNavigator.svelte`, `navigator*` messages) gives a filterable lane/band minimap. Details
  reworked (DoD dropped from the UI, `AttachmentChips.svelte` for plan/spec/notes). Coverage: the CDP
  tree-popover suite + `e2e/tree-popover.spec.ts`, on a restored test-workspace fixture.
- **Tech-tree create surface (P3a)** ✅: a **human** authors tasks from the board via one unified
  `CreateTaskForm.svelte` (full / quick / bug modes), hosted at the `Tasks.svelte` root so it works from
  any tab. Triggers: in-webview `Ctrl/Cmd-N` & bare `n` (full), `Ctrl/Cmd-Shift-N` (quick), the TabBar
  `+`, the repointed `taskwright.createTask` / new `taskwright.quickCapture` commands (`contributes.keybindings`,
  scoped to the board via `activeWebviewPanelId`/`focusedView`), and a **Report bug** popover action
  (`onCreateInPlace({bugMode,causedBy})`). Every path posts one locked `createTask` message. The MCP
  `createTaskHandler` and the `TasksController` `createTask` case both call the shared vscode-free core
  `src/core/createTaskCore.ts` (`createTaskWithTreeFields`) — one writer sequence for human and agent
  (parity). `linkTo` post-create dependency wiring is built here (P3b's drop-on-empty reuses it). The
  legacy `TaskCreatePanel` is retired. Coverage: `src/test/unit/createTaskCore.test.ts`,
  `e2e/tree-authoring.spec.ts`, `src/test/cdp/tree-authoring.test.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p3a-create-surface.md`.
- **Tech-tree drag surface (P3b)** ✅: the canvas is a spatial editor. **Drag-to-connect** —
  two connect handles per node (left = needs, right = unlocks) drag a dashed line
  (`DragLayer.svelte`, world coords); a valid target glows green, a self/dupe/cycle red
  (client-side `wouldCreateCycle` imported from `src/core/treeGate.ts`); drop over a node posts
  `addDependency`, drop on empty canvas opens the create form pre-linked (reuses P3a
  `createTask.linkTo`); a plain empty-canvas **click** opens the form with the clicked cell's
  lane/band inferred (click-in-place). **Drag-to-reslot** — vertical → `category` (`reslotTask`),
  horizontal → `milestone` (`reslotTask`), in-cell → `ordinal` (`reorderTasks` + `ordinalUtils`);
  bugs are reorder-only (never `reslotTask`). **Edge removal** — a ✕ on the edge hover hit-path or a popover prereq
  chip posts `removeDependency`. One pointer-event gesture machine in `TechTreeCanvas.svelte`
  disambiguates connect / node-body / empty-canvas via a `DRAG_THRESHOLD` (no HTML5 DnD); the
  geometry inverse (`screenToWorld`/`laneAtY`/`bandAtX`/`cellAt`/`reslotTargets`) lives in
  `src/webview/lib/treeGeometry.ts`. `TasksController` re-validates `wouldCreateCycle` before every
  dependency write and routes category via `TreeFieldService`, milestone/dependencies via
  `BacklogWriter.updateTask` — one writer path for human and agent (parity), **no stored
  coordinates**. Also lands the P2b carry-in debt (minimap drag-to-pan → `navigatorMinimapPan`;
  filter-aware Promote-all). Coverage: `src/test/unit/treeGeometry.test.ts`,
  `src/test/unit/TasksController.test.ts`, `e2e/tree-drag.spec.ts`, `src/test/cdp/tree-reslot.test.ts`.
  Design: `docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p3b-drag-surface.md`.
- **Tech-tree AI authoring (P4)** ✅: a `/create-task` **skill** (`.claude/skills/create-task/SKILL.md`)
  turns a brief into a set of PR-sized, dependency-linked tasks slotted into lanes/milestones and
  commits them as **draft proposals** the human reviews and promotes on the canvas (parity: every
  tool is one a human can drive via P3; subscription-safe — no `claude -p`). New read MCP tools
  `list_categories` / `list_milestones` / `get_board` / `search_tasks` (built on
  `loadTreeBoardFromParser` for canvas parity; `search_tasks` core `src/core/searchTasks.ts`) and write
  tools `create_category` (surgical `config.yml` edit, `src/core/categoriesConfig.ts` mirroring
  `mergeStatusConfig.ts`) + `promote_drafts` (bulk, `src/core/promoteDrafts.ts` — validate → dep-first
  topo → per-draft `promoteDraft` → **remap** inbound `dependencies`/`caused_by`). Closes three gaps that
  made the draft-review loop live: **drafts render on the canvas** (`loadTreeBoardFromParser` +
  `TasksController` tree-tab union drafts; `TreeNode` `folder==='drafts'` styling), **draft-create carries
  all fields** (`createTaskWithTreeFields` folds priority/milestone/labels/assignee into the same
  `updateTask`; `draft`+`status` → error), and **promote keeps edges** (single `promote_draft` + bulk
  `promote_drafts` + the canvas "Promote all proposed" button all route through the remapping core; the
  button posts one `promoteDrafts` message). Coverage: `src/test/unit/{promoteDrafts,searchTasks,categoriesConfig,mcpReadHandlers}.test.ts`,
  `src/test/cdp/tree-promote.test.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p4-create-task-skill-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p4-create-task-skill.md`.
- **Tech-tree execute skill + cancellation protocol (P5)** ✅: an `/execute-task` **skill**
  (`.claude/skills/execute-task/SKILL.md`) executes one task end-to-end in its worktree — load once
  (`get_active_task`, hold the ID) → **verify** worktree-rooted + `bun install` → `claim_task` →
  adaptive strategy (attached plan → `superpowers:executing-plans`; independent subtasks →
  `subagent-driven-development`; else `test-driven-development`; precedence plan > independent-subtasks
  > TDD, independence judged via `get_board` rows) → record via `edit_task` → **mandatory cancellation
  > checkpoint** → `request_merge` (parity with the P2 board actions; subscription-safe — in-session,
  > never `claude -p`). The **cancellation protocol** P2's Cancel-dispatch popover triggers lands here: a
  > new pure core `src/core/cancellationMarker.ts` (mirrors `activeTask.ts`; **presence-only**
  > `isCancelled`, never parses the marker) is written **first** in `cancelDispatch`
  > (`marker → releaseClaim → setStatus → removeWorktree → disposeTerminal`) so a `git worktree remove
--force` that sweeps `.taskwright/` can't resurrect the dir and silently defeat isolation on the next
  > dispatch; dispatch clears any stale marker on seed (`clearCancellationMarker`, `dispatchActions.ts`).
  > Detection is **presence-only OR worktree-vanished** (co-equal — POSIX deletes the marker with the
  > worktree, Windows may keep it and leak the worktree until re-dispatch reuses it). `get_active_task`'s
  > summary now surfaces `subtasks`/`parentTaskId` (so the SDD branch can fire), and the **Cancel-dispatch
  > affordance** is gated on worktree-dir existence (`TasksController` `dispatchedWorktree` =
  > `fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)))`; popover shows it when
  > `dispatchedWorktree || hasWorktree`) so a dispatched-but-unclaimed task is teardownable — no new
  > frontmatter (`dispatched_at` deliberately **not** added). `DEFAULT_DISPATCH_TEMPLATE` now says **launch
  > inside `.worktrees/<branch>` and run `/execute-task`** (guardrails kept; the inline workflow prose moved
  > into the skill) — users with a custom `taskwright.dispatchTemplate` keep their own and won't pick up the
  > repoint. The MCP root is fixed at launch (`server.ts`) and cannot re-root mid-session, so
  > `/execute-task` runs from **any** session: dispatched (already worktree-rooted) it proceeds
  > directly; primary-rooted it bootstraps the task's worktree via `start_task` and either relaunches
  > into it or continues single-session and closes with `request_merge { worktree }`
  > (DRAFT-7 — `docs/superpowers/plans/2026-07-08-execute-task-from-any-session.md`).
  > Coverage: `src/test/unit/{cancellationMarker,cancelDispatch,dispatchActions,dispatchPrompt,toSummary,TasksController}.test.ts`,
  > `e2e/tree-popover.spec.ts`. Design:
  > `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md`; plan:
  > `docs/superpowers/plans/2026-07-03-tech-tree-p5-execute-task-skill.md`.
- **Tech-tree codebase indexing + status-carrying drafts (P6)** ✅: an `/index-codebase` **skill**
  (`.claude/skills/index-codebase/SKILL.md`) bootstraps an initial tree over an **existing** repo — git
  forensics (tags/churn/chronology, module structure, docs) reconstruct the built foundation as **Done
  `baseline` drafts** in the age they were built and mine `TODO`/`FIXME` gaps as **To-Do drafts**, applied
  as **draft nodes** (confirm-before-write reconstruction summary; deduped against the live board via
  `get_board`/`search_tasks`; ages created oldest-first so creation order = left→right bands; AC via a
  follow-up `edit_task`; **never promotes** — the human does; parity + subscription-safe, no `claude -p`).
  One new write MCP tool **`create_milestone`** (`{ name, description? }` → wraps the existing
  `BacklogWriter.createMilestone` writing `backlog/milestones/m-N`; **idempotent** on name like
  `create_category`; reserved-guard **`Backburner` only**; **no `order`** — band order is creation order;
  `createMilestoneHandler` in `src/mcp/handlers.ts` + `src/mcp/server.ts` registration via `runTool`;
  `invalidateMilestoneCache` after the file write). Foundation change **status-carrying drafts (D2)**: a
  draft is a provisional/discardable state **orthogonal to completion status** (the provisional marker is
  `folder === 'drafts'`, not a synthetic `status: Draft`), so a **Done baseline can be a draft** —
  `createDraft` / `createTaskWithTreeFields` accept and write the real status (default
  `config.default_status ?? 'To Do'`), `getDrafts` / `getTask` reflect it (legacy on-disk `status: Draft`
  migrates-on-read to the board default), and `promoteDraft` / `demoteTask` **preserve** status (Done
  draft → Done task) instead of resetting to the board default. Coverage:
  `src/test/unit/{mcpWriteHandlers,BacklogParser,BacklogWriter,createTaskCore,treeGate}.test.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p6-codebase-indexing-design.md`; plan:
  `docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md`.
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
  **Conflict-safe parallel batching (TASK-80):** dependency-independence ≠ file-independence, so the
  parallel batch is pulled via `next_ready_tasks { parallelSafe: true, limit: cap }` — only tasks whose
  attached-plan "File Structure" footprints are pairwise disjoint are co-dispatched (unknown-footprint
  tasks run solo); pure core `src/core/planFiles.ts` (`extractPlanFiles` / `selectDisjointBatch`). The
  orchestrator AVOIDS conflicts; an unavoidable one is the dispatched agent's to rebase away.
- **Broadened Claude-integration scaffolding (5b)** ✅: `setUpClaudeIntegration`
  (`src/extension.ts`) now wires a fresh repo end-to-end. It injects the Taskwright
  convention into **AGENTS.md** too (`injectAgentsConvention` +
  `TASKWRIGHT_AGENTS_CONVENTION` in `src/core/agentConvention.ts`, same marked-block
  pattern as the CLAUDE.md block), installs **four** user-facing skills
  (`TASKWRIGHT_SKILL_NAMES` in `src/core/skillInstaller.ts`: create-task,
  execute-task, index-codebase, orchestrate-board — visual-proof/agent-browser stay
  internal), and — **opt-in** via `taskwright.setupWritesProjectMcpJson` (default
  off) — writes a project-local `.mcp.json` (pure `src/core/mcpProjectConfig.ts`:
  `extractTaskwrightServer` from the shipped template + idempotent
  `upsertTaskwrightMcpServer` preserving other servers) and copies the committed
  `scripts/taskwright-mcp.cjs` launcher into the repo. Both assets ship in the VSIX
  (`.vscodeignore` un-ignores `scripts/taskwright-mcp.cjs` and `.mcp.json`). The
  launcher resolves the primary checkout's built `dist/mcp/server.js` via
  `git rev-parse --git-common-dir`, so the project-local path targets Taskwright
  checkouts and their worktrees; user-scope registration remains the general path.
  Coverage: `src/test/unit/{agentConvention,skillInstaller,mcpProjectConfig}.test.ts`.
  Plan: `docs/superpowers/plans/2026-07-08-broaden-claude-integration-scaffolding.md`.
- **Merge-gate configurability + resumable `request_merge` (m-10: TASK-84/85/86/87/88)** ✅: the merge
  gate is tunable, durable, observable, and resumable. **Timeout + abort codes (84):** `MergeConfig`
  gained `verifyTimeoutMs` (default 10 min, was a hardcoded cap) + optional `verifyTimeoutMaxMs`,
  published from `taskwright.mergeVerifyTimeoutMinutes` / `mergeVerifyTimeoutMaxMinutes`; the
  `request_merge` tool accepts a per-call `verifyTimeoutMinutes` (clamped to the repo max); a killed
  verify aborts with an actionable "verify timed out…" reason, and every abort carries a
  machine-readable `code` (`verify_timeout | verify_failed | dirty_worktree | dirty_primary |
rebase_conflict`) so `/orchestrate-board` branches without parsing prose. **Durable merge-config
  (85):** `syncMergeConfig` republishes only explicitly-set settings (`cfg.inspect()` via the pure
  `publishMergeConfig`/`explicitSettingValue` in `src/core/mergeConfig.ts`, explicit > file > default),
  so agent/CLI fixes to `merge-config.json` survive restarts; missing/corrupt files still materialize
  defaults. **Verify doctor (86):** pure `src/core/verifyDoctor.ts` classifies the repo
  (node/python/rust/go) and flags only provably-unrunnable script commands, suggesting runnable
  replacements; surfaced at activation + setup with one-click "Apply suggested commands" — never a
  silent rewrite. **Friction fixes (87):** the queue-head re-verify is skipped when the post-wait
  rebase is a no-op (verified-HEAD-SHA comparison — halves merge wall-time), and the primary-dirty
  abort blocks only porcelain paths intersecting the merge footprint (`collidingWipPaths`), naming the
  exact blockers. **Unpinned close (88):** the MCP server forwards `MergeProgress` as
  `notifications/progress` (verify command/elapsed, queue position/approval) when the client sends a
  progressToken, and `request_merge` accepts `waitMinutes` — on expiry it returns
  `{ status: 'pending', queuePosition, ticket }` keeping the queue entry; a later call resumes
  idempotently (`verifiedHeadSha` persisted on the entry skips duplicate verify; `sent_back` detects a
  reviewer send-back while parked). Blocking default unchanged; `/execute-task` + `/orchestrate-board`
  document poll-or-park. Coverage:
  `src/test/unit/{mergeConfig,verifyDoctor,finishTaskActions,requestMerge,mergeQueue,mcpMergeHandlers}.test.ts`.
- **Claim identity — per-session `claimed_by` (TASK-89)** ✅: `claim_task` derives a stable
  `@agent/<branch>` identity from the worktree (explicit arg > `.worktrees/<branch>` segment > git
  branch; pure `src/core/claimIdentity.ts` — `agentClaimIdentity`/`worktreeBranchFromPath`/
  `shortClaimIdentity`), so a restarted session can tell "my claim" from a foreign one: re-claiming
  your own task is an idempotent no-op, a live foreign claim returns `surrendered`/`heldBy`, legacy
  `@agent` claims upgrade in place (`claimResolution.ts`). Same PR fixed the **folded-scalar claim
  corruption**: removal is continuation-safe (`removeFieldLines`, `src/core/frontmatterEdit.ts`) and
  `BacklogWriter` collapses the surgical keys (`claimed_by`/`worktree`/`claimed_at`/`plan`) back to
  one line on rewrite (`collapseFoldedSurgicalFields`) — no more orphaned continuations mangling
  `category`. Reopened scope hardened every kanban indicator badge (claim/merge/active/readonly)
  against flex `min-width:auto` overflow and repointed the DetailPopover "Claimed by" line at
  `shortClaimIdentity` (full identity + worktree in the tooltip). Identity is agent-brand-neutral —
  it comes from the worktree, not the tool. Coverage: claims/claimIdentity/claimResolution unit
  tests + `e2e/board-indicators.spec.ts`, `e2e/tree-popover.spec.ts`.
- **Board doctor (TASK-90)** ✅: pure `src/core/boardDoctor.ts` — `diagnoseBoard` returns typed
  findings (dangling-active-task, stale-handoff, orphaned-worktree, in-flight-no-claim,
  claim-worktree-vanished, malformed-category, dangling-continuation), each with a declared repair;
  `gatherDoctorFacts` reads `.taskwright/` + `.worktrees/`; one shared `runBoardDoctor` assembly for
  extension and MCP (parity). Glue `src/providers/doctorActions.ts`: silent-when-clean activation
  check, warning → multi-select quick-pick, repairs routed through the existing writers
  (activeTask/claimActions/TreeFieldService/marker-first `removeWorktree`; strip-continuations is a
  CRLF-safe surgical rewrite) — nothing deleted without confirmation. On-demand via the
  `taskwright.doctor` command; read-only via the `board_doctor` MCP tool so `/orchestrate-board` can
  pre-flight. Coverage: `src/test/unit/boardDoctor.test.ts` + `mcpReadHandlers.test.ts`.
- **Multi-agent scaffolding — Codex + agent-agnostic dispatch (TASK-92/93)** ✅: Taskwright is no
  longer Claude-only. **Codex integration (92):** `setUpAgentIntegration` dispatches per-agent
  adapters `{claude, codex}`; the Codex adapter upserts `[mcp_servers.taskwright]` into
  `$CODEX_HOME/config.toml` (pure `src/core/codexConfig.ts`, idempotent + content-preserving,
  absolute path to `scripts/taskwright-mcp.cjs` so worktrees resolve the primary build) and renders
  the four user-facing skills as Codex custom prompts from the same bundled SKILL.md sources
  (`src/core/codexPrompts.ts`, mirrors `skillInstaller.ts`); `AgentIntegrationDetector` gained
  `~/.codex` detection; new `taskwright.setupCodexIntegration` command + one-time activation offer;
  the AGENTS.md convention block is agent-neutral. **Agent-agnostic dispatch (93):** dispatch
  profiles are DATA (`src/core/dispatchProfiles.ts` — `DISPATCH_PROFILES`, `resolveDispatchProfile`;
  `taskwright.dispatchAgent` setting, default `claude`), both templates carrying the identical
  worktree/`bun install`/no-root-commit/`request_merge` contract (contract-marker test); the terminal
  guardrail generalized to `commandUsesHeadlessMode` (deny-list: `claude -p`/`--print`, `codex exec`,
  generic `--headless`/`--non-interactive`) applied regardless of agent — subscription safety is a
  principle, not a Claude feature. A custom `taskwright.dispatchTemplate` still wins untouched.
  Coverage: `src/test/unit/{codexConfig,AgentIntegrationDetector,dispatchProfiles,dispatchPrompt,dispatchActions}.test.ts`.
  (The Codex custom-prompt renderer `src/core/codexPrompts.ts` was **superseded by TASK-98** — Codex
  now gets native `.agents/skills/` SKILL.md packages instead of `~/.codex/prompts/*.md`.)
- **Native cross-agent skills + Codex plugin (TASK-98)** ✅: replaced the Codex custom-prompt
  approximation with **native SKILL.md packages** under Codex's canonical `.agents/skills/`
  discovery surface — the same full, progressively-disclosed skill directories Claude Code gets in
  `.claude/skills/`, from the one bundled source (`dist/skills/`), so neither agent's capabilities are
  reduced. New pure cores: `src/core/agentSkills.ts` (`installAgentSkills` / `discoverAgentSkills` /
  `uninstallAgentSkills` into `<root>/.agents/skills`, idempotent + clean scoped uninstall) and
  `src/core/codexPlugin.ts` (renders a valid `.codex-plugin/plugin.json` manifest bundling
  `skills: './skills/'` + `mcpServers: './.mcp.json'`, the plugin's bare-map `.mcp.json`, and a
  repo-scoped `.agents/plugins/marketplace.json`; `scripts/build.ts` assembles the distributable
  bundle into `dist/codex-plugin/`). `setUpCodexIntegration` now calls `installAgentSkills`;
  `codexPrompts.ts` removed. `TASKWRIGHT_AGENTS_CONVENTION` stays a concise pointer under a documented
  char budget (`TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS`), deferring detail to the skills. Repaired the
  unusable visual-proof reference (`.claude/skills/agent-browser` is a broken text pseudo-symlink →
  repointed to the real `.agents/skills/agent-browser/SKILL.md`). Install/update/uninstall flows in
  `docs/codex-plugin.md`. Coverage:
  `src/test/unit/{agentSkills,codexPlugin,agentConvention,visualProofSkill}.test.ts`.
- **Stable user-scope MCP registration (1.6.1)** ✅: the Claude Code user-scope entry is registered
  against a launcher in the extension's `globalStorage` (`src/core/globalMcpLauncher.ts`) — a path keyed
  by extension **id**, not version — which resolves the current build from a sibling pointer file that
  activation refreshes. **Do not reintroduce an unregister-on-deactivate**: `~/.claude.json` holds ONE
  global `taskwright` entry shared by every window and every running session, while `deactivate` runs per
  _window_, so removing it there deleted the server for all other windows and made Taskwright vanish from
  new sessions until a reload (the 1.6.1 bug). For the same reason registration is idempotent —
  `ensureTaskwrightMcpRegistered` (`src/core/claudeMcp.ts`) rewrites `~/.claude.json` only when the entry
  is missing or stale, because live sessions write that file too. Coverage:
  `src/test/unit/{globalMcpLauncher,claudeMcp}.test.ts`.

- **Board performance + startup cost (m-11: TASK-107/108/109, 1.7.0)** ✅: three independent
  perf defects, each measured before it was fixed. **Hover repaint storm (107):** `EdgeLayer.svelte`
  derived a `class:incident`/`class:faded` per edge path from the hovered node, so ONE `pointerenter`
  rewrote every edge — a `MutationObserver` on a 120-node board counted **117 mutated elements per
  hover** — and each path carried `transition: opacity 0.12s`, so all of them animated on every hover
  in and out. Amplified by the single composited layer (below), that repainted the whole canvas. The
  edge layer is now a **base group** (every dependency edge, rendered once, never touched by hover) +
  a **highlight overlay** (only the active node's incident edges, drawn opaque on top); the dim is one
  `.has-active` class on the group with CSS doing the fade — **zero per-edge DOM writes, 117 → 2**. A
  bug→cause edge has no base path (it only exists while incident), so the overlay is its one
  incarnation and keeps the canonical `tree-edge-{from}-{to}` test id, while a dependency edge's
  overlay stroke is the `-hl-` twin. **Zoom blur (108):** `.tree-surface` carried a permanent
  `will-change: transform`, which pins the layer to a cached raster so a `scale()` magnifies the OLD
  bitmap instead of re-rasterizing text — the hint is now **gesture-scoped** (`panning || wheeling`,
  wheel settling on a 180ms idle timer) and dropped at rest, which is when the browser re-rasters
  crisply. NOTE: this cannot be proven by screenshot — capturing one forces a re-raster, so stale-raster
  blur never appears in the image; the tests assert the _property_ (absent at rest, present mid-gesture,
  released after settle). **Startup cost (109):** the board was NOT the problem (98 tasks parse in 40ms
  cold / 2ms warm); Taskwright was the last eager extension, gating `Eager extensions activated`. Two
  causes: every `activationEvents` entry was a **glob** (VS Code stats a plain `workspaceContains:` path
  but runs a full workspace SEARCH for a glob one) — now plain paths only, with
  `src/test/unit/activationEvents.test.ts` failing the build if a glob returns, at the cost of a
  deliberate narrowing (a nested backlog root no longer eager-activates; it activates on board-view
  open) — and a burst of git subprocesses inline in `activate()` (worktree guard, post-checkout warn,
  board hooks, merge-config + verify doctor, sync-config publish, status bar, git-auto bootstrap + its
  network fetch/push, board doctor), now run once ~2s later via the pure
  `src/core/deferredBootstrap.ts` (`createDeferredRunner` — at-most-once, cancellable, pull-forward-able,
  never rejects into activation), preserving the ordering the git-auto engine depends on. Coverage:
  `e2e/{tree-hover-perf,tree-zoom-raster}.spec.ts`,
  `src/test/unit/{deferredBootstrap,activationEvents}.test.ts`.

## Conventions

- Use [Lucide icons](https://lucide.dev/) (inline SVG), not emojis, in webviews; support all themes.
- TDD: write the failing test first (the repo has comprehensive Vitest coverage).

@AGENTS.md

<!-- TASKWRIGHT:BEGIN -->

## Taskwright

This project is managed with [Taskwright](https://github.com/ChronoVortex07/taskwright). At the **start of a task session**:

1. Call the `taskwright` MCP tool **`get_active_task`** to load your assigned task and its full context (description, acceptance criteria, plan). Work from that — do not infer the task from the file tree.
2. Call **`claim_task`** with your task ID to mark it in progress, so parallel sessions in other worktrees don't collide. Claiming is advisory.
3. When you finish or hand off, call **`release_task`**.

The active task is set ephemerally by opening a tree-node popover on the Taskwright board, or by a dispatch. If `get_active_task` reports none is set, ask which task to work on rather than assuming.

<!-- TASKWRIGHT:END -->
