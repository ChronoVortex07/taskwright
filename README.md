# Taskwright

> ⚠️ **Early development.** Taskwright is being built on top of an imported fork — most of the
> agentic features described in the vision are not implemented yet. See
> [`docs/phase-0-findings.md`](docs/phase-0-findings.md) and the project plan for status.

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

## Status / roadmap

Inherited from the fork (working today): editor-tab Kanban with drag-and-drop, task list, detail
editor, Markdown/Mermaid rendering, frontmatter autocomplete, cross-branch task loading.

Planned (the Taskwright additions):

- Advisory **task claiming** (claimant / worktree / staleness) to prevent duplicate agent work.
- **Active-task** MCP tool + `CLAUDE.md` convention so a session pulls its task context.
- **Dispatch** panel: optional worktree + paste-ready prompt (no `claude -p`).
- **Superpowers bridge**: attach specs/plans to tasks; surface the progress ledger.
- **"Categorize with Claude"** intake for turning a raw bug dump into labeled, prioritized tasks.

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

## Attribution

Taskwright is a derivative of **[vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md)**
by ysamlan and contributors, used under the MIT License. The original copyright notice is retained in
[`LICENSE`](LICENSE). Backlog.md itself is a separate MIT project by
[MrLesk](https://github.com/MrLesk/Backlog.md).

## License

MIT — see [LICENSE](LICENSE).
