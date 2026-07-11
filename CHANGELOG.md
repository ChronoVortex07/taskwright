# Changelog

All notable changes to Taskwright are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed

- **Documentation & release-metadata drift reconciled.** Codex now installs the workflow skills as
  native `.agents/skills/` SKILL.md packages, so the README, the `taskwright.dispatchAgent` setting
  description, the Codex setup prompt/comments, and the Codex dispatch template no longer describe the
  retired "custom prompt" mechanism. The Marketplace `description`/`keywords` now name Codex alongside
  Claude Code. The MCP server advertises the real package version (was a stale `0.0.1` placeholder)
  by deriving it from `package.json`. A new `releaseMetadata` unit test keeps the CHANGELOG's newest
  version, the MCP server version, and the agent keywords reconciled with `package.json`
  automatically.

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

[1.0.0]: https://github.com/ChronoVortex07/taskwright/releases/tag/v1.0.0
