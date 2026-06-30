# Taskwright

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**An agentic task board for VS Code.** Triage bugs and improvements onto a git-native board, then
dispatch a fresh, isolated Claude Code session per task — so unrelated work never pollutes a single
session. Built on a [Backlog.md](https://github.com/MrLesk/Backlog.md) backbone (plain Markdown tasks
in git), so the data stays human- and agent-readable with or without this extension installed.

## Why

VS Code lacks a task system that scales to many tasks across categories, with first-class support for
delegating work to AI agents. Taskwright's workflow:

1. **Capture** bugs / improvements as you find them.
2. **Categorize** them onto the board (labels, priority) — with help from Claude.
3. **Dispatch** an isolated session per task. Each task maps to a branch/worktree; the agent claims it,
   works with only that task's context, and reports progress back onto the board.

Dispatch is **subscription-safe**: Taskwright generates a paste-ready prompt for a Claude Code session
rather than spawning headless `claude -p`, so it never risks switching your usage to API billing.

## Features

Inherited from the fork: editor-tab Kanban with drag-and-drop, task list, detail editor,
Markdown/Mermaid rendering, frontmatter autocomplete, cross-branch task loading.

Taskwright additions (all implemented):

- Advisory **task claiming** — claimant / worktree / staleness, with conflict prompts and
  stale-claim expiry, surfaced as badges on the board.
- **Active task + Taskwright MCP** (`get_active_task` / `claim_task` / `release_task`) plus a
  `CLAUDE.md` convention, so a fresh session pulls its task context. Auto-registers with Claude Code.
- **Dispatch** — copies a paste-ready prompt (and an optional git worktree) for a task. Never spawns
  `claude -p`.
- **"Categorize with Claude"** intake — turn a raw bug dump into labeled, prioritized tasks.
- **Superpowers bridge** — attach a plan/spec to a task (`attach_plan`) and see its checkbox progress.

## Requirements

- VS Code `^1.110.0`
- Node `>=22` and [Bun](https://bun.sh) to build from source
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI on PATH for writes and cross-branch features
- On Windows: `git config --global core.longpaths true` (Backlog.md task filenames can exceed `MAX_PATH`)

## Development

```bash
bun install
bun run build      # build:css + compile:webview + compile
# then press F5 in VS Code to launch an Extension Development Host
```

To install Taskwright into your own VS Code (no dev host), or to publish it:

```bash
bun run package    # builds, then emits taskwright-<version>.vsix
code --install-extension taskwright-0.0.1.vsix
```

See **[`docs/building-and-publishing.md`](docs/building-and-publishing.md)** for the full build,
install, and Marketplace-publishing guide.

## Attribution

Taskwright is a derivative of **[vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md)**
by ysamlan and contributors, used under the MIT License. The original copyright notice is retained in
[`LICENSE`](LICENSE). Backlog.md itself is a separate MIT project by
[MrLesk](https://github.com/MrLesk/Backlog.md).

## License

MIT — see [LICENSE](LICENSE).
