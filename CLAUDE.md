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

## Taskwright features

All features below are complete. Design docs live in `docs/superpowers/specs/`.

### Board & data model

- **Advisory claiming** — `claimed_by`/`worktree`/`claimed_at` per-task; per-session `@agent/<branch>`
  identity so restarts recognize their own claims; stale-claim expiry (default 12h).
- **Stable task IDs (one ID space)** — drafts get a real `TASK-N` and keep it for life;
  `folder === 'drafts'` is the sole draftness marker; promote/demote are pure file moves (id and
  status preserved). Legacy draft-id boards auto-migrate. **Every agent-facing surface must say a
  draft's id is final** — a surface promising the legacy id shape fails the build
  (`idSpaceContract.test.ts`).
- **Atomic writes** — all board mutations are write-temp-then-rename.
- **Status-carrying drafts** — drafts are orthogonal to completion status; a Done baseline draft is
  legitimate; promote/demote preserve status.

### Sync & versioning

- **Single shared board** (Board Sync v2) — exactly one physical board at the primary checkout,
  resolved from any worktree. `sync.mode`: `off` (default) | `git` (manual push/pull) | `git-auto`
  (event-driven auto-commit + sync to a hidden `.taskwright/board/` worktree of the
  `taskwright-board` ref). Migration is **only** via the `taskwright.enableSync` mode picker.
- **Union-merge** — same-task edit on both sides resolves by newer `updated_date`, always surfaced as
  a conflict, never silently dropped.
- **git-auto invariants** — EOL-only differences verify OK (`.gitattributes: * text=auto` is git's
  own policy); drifted board worktrees are folded forward, not aborted against.

### Tech-tree canvas

- **Tree tab** (default view) — dependency graph where lanes = categories, bands = milestones/ages.
  Pan/zoom, level-of-detail scaling, `treeGeometry.ts` layout engine.
- **Drag surface** — drag-to-connect (needs/unlocks handles, client-side cycle detection),
  drag-to-reslot (vertical = category, horizontal = milestone, in-cell = ordinal), edge removal.
  Right-click empty canvas → create-in-place; left-click empty canvas does NOT create (so
  focus-the-panel doesn't author a task).
- **Find bar** (`/` or Ctrl/Cmd-F) — matches id + title + description in spatial order. Find, not
  filter — never narrows a write. `$derived` acyclicity invariant: `findResults` depends ONLY on
  `navFilterDimmedIds`/`hiddenIds`, never on the composed `dimmedIds`/`fadedIds`.
- **Create form** — unified full/quick/bug modes; human and MCP share `createTaskWithTreeFields` core
  (parity).
- **Backburner invariant** — must appear exactly once and last in `bandOrder`; the webview keys bands
  by name, so a duplicate is a Svelte `each_key_duplicate` that blanks the canvas.

### Agent workflow

- **Dispatch** — subscription-safe: renders a paste-ready prompt, copies to clipboard, **never**
  spawns `claude -p`. Worktree isolation on by default.
- **Execute task (`/execute-task` skill)** — adaptive strategy (plan > independent-subtasks > TDD);
  mandatory cancellation checkpoint; `request_merge` close.
- **Orchestrate board (`/orchestrate-board` skill)** — round-robin over `next_ready_tasks`; parallel
  in-session subagents with `parallelSafe` conflict-avoidance; claim-before-work anti-collision.
- **Create task (`/create-task` skill)** — brief → PR-sized dependency-linked draft proposals.
- **Index codebase (`/index-codebase` skill)** — git forensics → Done baseline drafts + TODO gaps;
  never auto-promotes.
- **Cancellation protocol** — presence-only marker written first, so `git worktree remove --force`
  can't silently resurrect isolation.
- **Worktree entry invariant** — Taskwright worktrees are plain `git worktree add` dirs under
  `.worktrees/`; the harness `EnterWorktree` tool can NEVER open one. Every agent-facing surface must
  forbid it by name and say `cd`/`git -C` instead (`worktreeEntryContract.test.ts` fails the build
  otherwise).

### MCP + MCP server

- **Taskwright MCP server** — stdio JSON-RPC, 20+ tools, `console.log` → stderr. Build-independent
  in worktrees via committed `scripts/taskwright-mcp.cjs` (resolves primary checkout's
  `dist/mcp/server.js`). MCP root is fixed at launch — cannot re-root mid-session.
- **Rootedness** follows from "did this session call `start_task`" (not a shell probe). A
  primary-rooted `request_merge` aborts with `wrong_root` — a misuse, not a cancellation. Always
  close with `request_merge { taskId, worktree }` from a primary-rooted session.
- **Stable user-scope registration** — launcher path keyed by extension **id**, not version.
  Deactivate must **never** unregister (it's shared by every window).
- **Superpowers bridge** — `attach_plan` links task→spec; checkbox progress from plan file.

### Merge queue

- **Serialized verify (verify slot)** — the queue serializes the _merge_; the verify slot
  (`src/core/verifySlot.ts`) serializes the _verify_. One `request_merge` runs its suite at a time,
  repo-wide, via an O_EXCL lock file in the git common dir (cross-process: concurrent subagents AND
  separate MCP servers). Held only for the run and released **before** the queue wait — so no
  slot→queue→slot deadlock; stealable on a dead pid / expired lease / torn write, so a crashed
  holder can't wedge every future merge. Without it, N orchestration subagents ran N CPU-saturating
  `bun run test`s at once and flaked each other (`verify_failed` with every test green in isolation).
- **Configurable verify** — `taskwright.mergeVerifyTimeoutMinutes` (default 20), per-call
  `verifyTimeoutMinutes`, machine-readable abort codes (`verify_timeout`|`verify_failed`|
  `dirty_worktree`|`dirty_primary`|`rebase_conflict`). `verify_failed` (red exit) and
  `verify_timeout` (killed) must stay unmistakable in prose, not just in the code — agents were
  reading flakes as timeouts and blind-retrying. Vitest's per-test `testTimeout` (20s, not the 5s
  default) is the _other_ timeout that matters: it, not the harness cap, is what load actually blew.
- **Resumable** — `request_merge { waitMinutes }` returns `{ status: "pending", queuePosition,
ticket }` on expiry; resume with the same taskId + ticket. Queue-head re-verify skipped when base
  didn't move.
- **Verify doctor** — classifies repo type, flags provably unrunnable commands; never rewrites
  silently.
- **Durable merge-config** — only explicitly-set settings republished; agent fixes survive restarts.

### Multi-agent

- **Codex support** — native `.agents/skills/` SKILL.md packages (same as Claude Code gets),
  `.codex-plugin/` distributable, MCP server in `$CODEX_HOME/config.toml`.
- **Agent-agnostic dispatch** — profiles as data; headless deny-list applies regardless of agent
  brand.

### Performance & startup

- **No glob activation events** — plain `workspaceContains:` paths only (build fails if a glob
  returns).
- **Deferred bootstrap** — git subprocesses run ~2s after activation, never inline.
- **Edge hover** — base group + highlight overlay (2 DOM writes per hover, not 117).
- **Zoom crispness** — `will-change: transform` is gesture-scoped, dropped at rest.

### Health

- **Board doctor** — typed findings with one-click repairs; runs silently-when-clean at
  activation; `board_doctor` MCP tool for pre-flight checks.
- **Intake** — "Categorize with Claude" captures editor notes, renders paste-ready prompt;
  subscription-safe.

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
