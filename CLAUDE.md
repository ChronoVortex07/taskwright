# Taskwright — agent guide

Taskwright is a VS Code extension: an **agentic task board** where you triage bugs/improvements onto a
git-native board, then dispatch a **fresh, isolated Claude Code session per task** so unrelated work
never pollutes one session. Storage backbone is [Backlog.md](https://github.com/MrLesk/Backlog.md)
(plain Markdown tasks in git). Derived from
[vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT).

## Build & test

- Requires Node **≥ 22** and [Bun](https://bun.sh). `bun install` → `bun run build` → press F5 to launch.
- `bun run test` (Vitest), `bun run lint`, `bun run typecheck`.
- **Windows note:** ~22 upstream unit tests assert POSIX paths and fail on Windows; the code is
  cross-platform-correct (uses `path.*`). They pass on Linux/CI — don't "fix" the code to match them.

## Architecture (inherited)

- `src/core/` — `BacklogParser`/`BacklogWriter` (read/write task files), `BacklogCli` (shells out to the optional `backlog` CLI — used only for the cross-branch board view), `CrossBranchTaskLoader` + `GitBranchService` (cross-branch task view), `FileWatcher`,
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
  handlers in `src/mcp/handlers.ts`. "Set active" control in the tree-node popover + `backlog.setActiveTask` /
  `backlog.clearActiveTask`. MCP server reuses only vscode-free `src/core` and routes stray `console.log`
  to stderr (stdout is the JSON-RPC channel).
- **Subscription-safe dispatch** ✅ (Phase 3): `backlog.dispatchTask` renders a paste-ready prompt and copies
  it to the clipboard — **never** spawns `claude -p`. Pure cores: `src/core/dispatchPrompt.ts` (configurable
  template + `{{placeholder}}` substitution; `backlog.dispatchTemplate` setting), `src/core/WorktreeService.ts`
  (`.worktrees/<branch>` isolation, **on by default** via `taskwright.dispatchCreateWorktree`; set `false` to opt out), `src/core/handoff.ts`
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
  `TasksController` (`isActiveTask`/`claimStale`). Cross-worktree board is inherited (Backlog.md
  `check_active_branches` via `CrossBranchTaskLoader`). Proof: `e2e/board-indicators.spec.ts`.
- **Synced board (GitHub-only, opt-in)** ✅: `taskwright.sync.mode` (`off` default | `local` |
  `github`) moves the board **off code branches** onto a dedicated `taskwright-board` ref, killing the
  read-only cross-branch "ghost" cards at the root (the board no longer lives on `task-*`/worktree
  branches, so there is nothing to cross-scan — `BacklogParser.getTasksWithCrossBranch` goes local-only
  when sync is on and excludes the board ref by name). Pure cores: `src/core/boardRef.ts` (isolated-index
  `snapshotBoardToRef`/`materializeRefToWorktree` — never touches the user's HEAD/index/branch),
  `src/core/boardSyncEngine.ts` (fetch→materialize→check→snapshot→**ff-only push** CAS loop:
  `claimTaskSynced`/`releaseTaskSynced`/`refreshBoard`; two racers can't both claim because `git push` is
  an atomic ref compare-and-swap), `src/core/boardLifecycle.ts` (`reconcileBoardRef` auto setup/heal +
  lease-guarded `compactBoardRef`), `src/core/syncConfig.ts` (shared `<commonDir>/taskwright/sync-config.json`,
  MCP-readable), `src/core/boardMigration.ts` (gitignore block + rm-cached paths). Wire-in:
  `BoardSyncController` (reconcile/poll/status bar), `publishSyncConfig` + `taskwright.enableSync` command
  (one-consent migration) in `extension.ts`, MCP `claim_task`/`release_task` and the UI `claimActions`
  both route through the engine when `mode !== 'off'`. Merge queue stays per-clone (documented boundary).
  Design: `docs/superpowers/specs/2026-07-01-github-synced-board-design.md`; plans: `docs/superpowers/plans/2026-07-01-synced-board-phase-{1..4}-*.md`.
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

The active task is chosen on the Taskwright board ("Set active") or set by a dispatch. If `get_active_task` reports none is set, ask which task to work on rather than assuming.

<!-- TASKWRIGHT:END -->
