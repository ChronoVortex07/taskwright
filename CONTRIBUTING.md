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

> **Known issue (Windows):** ~22 upstream unit tests assert POSIX-style paths (`/repo/...`) and fail on
> Windows, where the (cross-platform-correct) code returns `C:\...`. They pass on Linux/CI. Prefer
> running the full suite on Linux/WSL until these assertions are made platform-aware.

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
