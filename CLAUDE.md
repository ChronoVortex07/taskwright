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

- `src/core/` — `BacklogParser`/`BacklogWriter` (read/write task files), `BacklogCli` (shells out to the
  `backlog` CLI), `CrossBranchTaskLoader` + `GitBranchService` (cross-branch task view), `FileWatcher`,
  `AgentIntegrationDetector`.
- `src/providers/` — webview views (Kanban, task list/detail/preview).
- `src/language/` — completion, hover, document links.

## Coupling rules (important)

- **Read** task data by parsing `backlog/tasks/*.md` directly. **Write** via the `backlog` CLI
  (`BacklogCli.execute`) to keep IDs/frontmatter format valid. Only Taskwright's own new fields
  (claims) are written directly.
- Don't reimplement Backlog.md CRUD — the `backlog` MCP server (`.mcp.json`) already exposes it.

## Taskwright additions (see the project plan)

- **Advisory claiming** ✅ (Phase 2): `claimed_by` / `worktree` / `claimed_at` frontmatter written
  surgically by `src/core/claims.ts` + `ClaimService` (Backlog.md's canonical frontmatter round-trips
  untouched). Claim badge on kanban cards; Claim/Release control in the detail panel; `backlog.claimTask`
  / `backlog.releaseTask` commands. Staleness helper exists (`isClaimStale`); auto-expiry is Phase 5.
- **Active task + Taskwright MCP** ✅ (Phase 2): pull-based handoff via `<root>/.taskwright/active-task.json`
  (`src/core/activeTask.ts`, git-ignored, per-worktree). MCP server `src/mcp/server.ts` (stdio, bundled to
  `dist/mcp/server.js`, registered in `.mcp.json`) exposes `get_active_task` / `claim_task` / `release_task`;
  handlers in `src/mcp/handlers.ts`. "Set active" control in the detail panel + `backlog.setActiveTask` /
  `backlog.clearActiveTask`. MCP server reuses only vscode-free `src/core` and routes stray `console.log`
  to stderr (stdout is the JSON-RPC channel).
- **Subscription-safe dispatch** ✅ (Phase 3): `backlog.dispatchTask` renders a paste-ready prompt and copies
  it to the clipboard — **never** spawns `claude -p`. Pure cores: `src/core/dispatchPrompt.ts` (configurable
  template + `{{placeholder}}` substitution; `backlog.dispatchTemplate` setting), `src/core/WorktreeService.ts`
  (optional `.worktrees/<branch>` isolation, `backlog.dispatchCreateWorktree`), `src/core/handoff.ts`
  (`.taskwright/handoff/<id>.md`). Orchestration in `src/providers/dispatchActions.ts` (sets active task on the
  session root, optional terminal); "Dispatch" control in the detail panel. Visual proof + behavior coverage of
  the agentic banners (claim / set-active / dispatch) lives in `e2e/dispatch.spec.ts` — `bun run proof` builds
  and runs it, writing screenshots to `e2e/__screenshots__/dispatch/` (git-ignored).
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

## Conventions

- Use [Lucide icons](https://lucide.dev/) (inline SVG), not emojis, in webviews; support all themes.
- TDD: write the failing test first (the repo has comprehensive Vitest coverage).

@AGENTS.md
