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
3. **Dispatch** an isolated session per task. Each task gets its own git worktree (the default) so parallel sessions never collide; the agent claims it,
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
- **Dispatch** — copies a paste-ready prompt and carves an isolated git worktree (the default) for a task. Never spawns
  `claude -p`.
- **"Categorize with Claude"** intake — turn a raw bug dump into labeled, prioritized tasks.
- **Superpowers bridge** — attach a plan/spec to a task (`attach_plan`) and see its checkbox progress.
- **Board sync (GitHub-only, optional)** — run **Taskwright: Enable Board Sync** to move board tasks
  **off your code branches** onto a dedicated `taskwright-board` ref. This eliminates the read-only
  cross-branch "ghost" cards that transient worktree branches produce, and — in `github` mode — shares
  the board through your existing git remote (no server, no account) for near-real-time, **collision-proof
  claims**: two people or agents can't both claim the same task, because a claim is an atomic `git push`.
  Uses your existing push credentials; the board ref is created, seeded, healed, and compacted
  automatically. See `docs/superpowers/specs/2026-07-01-github-synced-board-design.md`.

## Requirements

- VS Code `^1.110.0`
- Node `>=22` and [Bun](https://bun.sh) to build from source
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI is **optional** — Taskwright reads and writes tasks itself (the latter via its MCP server). The CLI is only needed for the cross-branch board view, which otherwise degrades to local-branch tasks.
- On Windows: `git config --global core.longpaths true` (Backlog.md task filenames can exceed `MAX_PATH`)

## Setup commands

Two command-palette commands set up _different_ integrations — run the one that matches what you need:

| Command                                                          | What it does                                                                                                                     | When to run it                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Taskwright: Set Up Backlog.md CLI**                            | Installs the optional [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI (if missing) and runs `backlog init`.               | Only if you want the **cross-branch board view**. Taskwright reads and writes tasks without the CLI, so most users can skip this.                                                                                               |
| **Taskwright: Set Up Claude Code Integration (MCP + CLAUDE.md)** | Registers the bundled **Taskwright MCP server** with Claude Code (user scope) and adds the agent convention to your `CLAUDE.md`. | If you dispatch tasks to **Claude Code** and want a fresh session to pull its task via `get_active_task` / `claim_task` / `release_task`. Taskwright offers this automatically the first time it detects an un-integrated repo. |

In short: **Set Up Backlog.md CLI** is about the optional upstream CLI; **Set Up Claude Code Integration** is about wiring Claude Code to Taskwright's MCP server.

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

Auto versioning

```bash
bunx @vscode/vsce publish patch    # 0.0.1 → 0.0.2
bunx @vscode/vsce publish minor    # 0.0.1 → 0.1.0
bunx @vscode/vsce publish major    # 0.0.1 → 1.0.0
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
