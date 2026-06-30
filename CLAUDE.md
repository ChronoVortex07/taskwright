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

## Taskwright additions (in progress — see the project plan)

- **Advisory claiming**: `claimedBy` / `worktree` / `claimedAt` frontmatter + staleness; UI badges.
- **Taskwright MCP**: `get_active_task` / `claim_task` / `release_task` (active-task is pull-based —
  there is no API to push context into a running agent session).
- **Subscription-safe dispatch**: generate a paste-ready prompt; **never** spawn `claude -p`.
- **Superpowers bridge**: attach specs/plans to tasks; surface the progress ledger.

## Conventions

- Use [Lucide icons](https://lucide.dev/) (inline SVG), not emojis, in webviews; support all themes.
- TDD: write the failing test first (the repo has comprehensive Vitest coverage).

@AGENTS.md
