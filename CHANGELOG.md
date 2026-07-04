# Changelog

All notable changes to Taskwright are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/ChronoVortex07/taskwright/releases/tag/v1.0.0
