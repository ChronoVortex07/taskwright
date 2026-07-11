# Contributing to Taskwright

Taskwright is a VS Code extension — an agentic task board on a [Backlog.md](https://github.com/MrLesk/Backlog.md)
backbone. It is derived from [vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT).

## Development setup

### Prerequisites

- Node.js **≥ 22** and [Bun](https://bun.sh). The repo includes `mise.toml` / `.node-version` pinning
  the versions — `mise install` sets them up automatically if you use [mise](https://mise.jdx.dev/).
- VS Code `^1.110.0`.
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI is **optional**. Taskwright's own `BacklogWriter` handles all task reads and writes natively; the CLI is only needed if you use the cross-branch board view.
- On Windows: `git config --global core.longpaths true` (Backlog.md task filenames can exceed `MAX_PATH`).

### Getting started

```bash
bun install
bun run build        # build:css + compile:webview + compile
# Press F5 in VS Code to launch an Extension Development Host
```

Package a local `.vsix` for real-install testing:

```bash
bun run build && bun run package
code --install-extension "taskwright-$(node -p "require('./package.json').version").vsix" --force
```

## Project structure

```
src/
├── extension.ts   # Extension entry point
├── core/          # BacklogParser/Writer, BacklogCli, GitBranchService, FileWatcher, AgentIntegrationDetector, and services for claims, plans, worktrees, board sync, and tree layout
├── providers/     # Webview views (Kanban, task list/detail/preview)
├── language/      # Completion, hover, document links
└── test/          # Vitest unit + integration tests
```

## Testing

```bash
bun run test            # Vitest unit tests
bun run lint            # ESLint
bun run typecheck       # tsc --noEmit
bun run test:playwright # Webview UI tests
```

### Platform support

Development and release automation is **cross-platform** — every `package.json` script runs on
Windows, macOS, and Linux with no `bash` required. The scripts are TypeScript run via `bun` (the old
`scripts/*.sh` wrappers were ported); the shared platform branching lives in `scripts/lib/platform.ts`
and is unit-tested. CI runs the portable verification core (install, lint, typecheck, depcheck, audit
gate, unit tests, build, license check) on **both Windows and Linux**.

The unit suite (`bun run test`) passes fully on Windows, Linux, and CI — **0 failures on all three**
(the historical ~22 POSIX-path assertions were made path-separator-agnostic in TASK-4; don't
reintroduce POSIX-only path assertions).

**Unavoidable platform prerequisites:**

- **All platforms:** Node **≥ 22** and [Bun](https://bun.sh).
- **Windows:** `git config --global core.longpaths true` (Backlog.md task filenames can exceed
  `MAX_PATH`).
- **Headless Linux (CI, devcontainers):** the display-driven suites — `bun run test:e2e`,
  `bun run test:cdp`, and `bun run screenshots` — need **`xvfb`** installed (`apt-get install -y
xvfb`); the scripts detect a headless Linux host and wrap the run in `xvfb-run` automatically. On
  Windows and macOS they run against the native display with no extra setup. If `xvfb-run` is missing
  on a headless Linux host, the script fails with an actionable "command not found" message rather
  than hanging.
- **`bun run test:e2e` / `bun run test:cdp`:** download a VS Code build into `.vscode-test/` on first
  run (the CDP launcher and CI provision the platform-appropriate binary).

## Code style

- ESLint + Prettier (`bun run format`). Husky runs lint-staged on commit.
- Use [Lucide icons](https://lucide.dev/) (inline SVG), not emojis, in webviews.
- Support Light, Dark, and High Contrast themes.

## Visual proof

UI changes should include a short before/after. The repo ships a `visual-proof` Claude Code skill
(`.claude/skills/visual-proof/`) that captures screenshots of the extension.

## Tasks

This project dogfoods Backlog.md for its own task tracking — see `backlog/tasks/` once initialized.

## Publishing

Marketplace/Open VSX publishing is **not configured yet** (no publisher registered, no release
workflow). When ready, register a VS Marketplace publisher, set the `publisher` field, and add a
release workflow with the appropriate secrets.

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
