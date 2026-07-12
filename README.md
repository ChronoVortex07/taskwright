# Taskwright

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**An agentic task board for VS Code.** Triage bugs and improvements onto a git-native board, then
dispatch a fresh, isolated agent session (Claude Code or Codex) per task — so unrelated work never
pollutes a single session. Built on a [Backlog.md](https://github.com/MrLesk/Backlog.md) backbone (plain Markdown tasks
in git), so the data stays human- and agent-readable with or without this extension installed.

## Why

VS Code lacks a task system that scales to many tasks across categories, with first-class support for
delegating work to AI agents. Taskwright's workflow:

1. **Capture** bugs / improvements as you find them.
2. **Categorize** them onto the board (labels, priority) — with help from Claude.
3. **Dispatch** an isolated session per task. Each task gets its own git worktree (the default) so parallel sessions never collide; the agent claims it,
   works with only that task's context, and reports progress back onto the board.

Dispatch is **subscription-safe**: Taskwright generates a paste-ready prompt for an interactive agent
session rather than spawning headless `claude -p` / `codex exec`, so it never risks switching your
usage to API billing.

## Features

Inherited from the fork: editor-tab Kanban with drag-and-drop, task list, detail editor,
Markdown/Mermaid rendering, frontmatter autocomplete.

Taskwright additions (all implemented):

### Tech-tree — spatial task canvas

The **Tree tab** (default view) renders the board as a dependency graph: lanes = categories,
bands = milestones/ages. Pan, zoom, and level-of-detail scaling make large boards navigable.

- **Drag surface** — drag-to-connect for dependency edges, drag-to-reslot to change category/milestone,
  drag-to-reorder within a cell; click empty canvas to create a task pre-slotted into that lane/band.
- **Create surface** — unified form (full / quick / bug modes) via keyboard shortcuts, the TabBar, or
  right-click; shared core ensures parity between human-authored and agent-authored tasks.
- **Interaction shell** — state-aware detail popover, milestone popover with release checklist, in-flight
  panel for active and merge-queue tasks, sidebar navigator with filterable minimap.

### Agentic workflow

- **Taskwright MCP server** — 20+ tools (`create_task`, `edit_task`, `claim_task`, `get_board`,
  `search_tasks`, `promote_drafts`, `push_board`, …); auto-registers with Claude Code, and can register
  with Codex too. Agents read and write the board through the same core as the UI — human and agent
  have parity.
- **Advisory claiming** — per-session claimant identity (`@agent/<branch>`, derived from the worktree,
  so re-claiming your own task is a no-op) / worktree / staleness, with conflict prompts and
  stale-claim expiry, surfaced as badges on the board and tree canvas.
- **Subscription-safe dispatch** — copies a paste-ready prompt and carves an isolated git worktree for a
  task; a `taskwright.dispatchAgent` setting targets Claude Code (default) or Codex. Never spawns
  headless sessions (`claude -p`, `codex exec`).
- **Merge queue** — shared FIFO queue with `request_merge` orchestrator (rebase → verify → enqueue →
  wait for turn → fast-forward merge or open PR); merge-review board status with Approve/Send back;
  configurable verify timeout, machine-readable abort codes, progress notifications, and bounded waits
  that park as `pending` and resume idempotently.
- **Doctors** — a startup board doctor (run just after activation, off the window-open critical path)
  detects and repairs board drift (dangling pointers,
  orphaned worktrees, stale claims; also `taskwright.doctor` / the `board_doctor` MCP tool), and a
  verify-command doctor flags merge-verify commands that can't run in your repo and suggests runnable
  replacements.
- **"Categorize with Claude"** intake — turn a raw bug dump into labeled, prioritized tasks.
- **Superpowers bridge** — attach a plan/spec to a task (`attach_plan`) and see its checkbox progress.

### Agent skills

Four bundled skills (`.claude/skills/`) that agents use in dispatched worktrees — installed for
Claude Code, and installed for Codex as native `.agents/skills/` SKILL.md packages by the Codex setup command:

| Skill                | Purpose                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/create-task`       | Turn a brief into PR-sized, dependency-linked draft tasks slotted into lanes/milestones.                                                      |
| `/execute-task`      | Execute one task end-to-end: claim, adaptive strategy (plan → SDD; subtasks → subagent-driven; else TDD), record progress, `request_merge`.   |
| `/index-codebase`    | Bootstrap an initial tech-tree over an existing repo from git forensics; mines `TODO`/`FIXME` gaps as draft nodes.                            |
| `/orchestrate-board` | Drive the whole board autonomously: pull the ready set, run each task to Done (sequential or capped-parallel subagents), merge via the queue. |

### Board Sync (optional, git-native)

Opt-in sharing via a dedicated `taskwright-board` branch — no server, no CAS loop, no per-worktree
copies. A single shared board root avoids all desync. Three modes (`taskwright.sync.mode`, switched
via the **Taskwright: Enable Board Sync** command — never by editing the setting directly):

- **`off`** (default) — the board is local, git-ignored working files; no versioning.
- **`git`** — explicit versioning: `push_board` / `pull_board` snapshot the board onto the
  `taskwright-board` ref and union-merge divergence (same-task edits resolve by newer timestamp,
  always surfaced as a conflict). Opt-in `pre-push` / `post-merge` git hooks can automate this.
- **`git-auto`** — automatic versioning: the board lives in a hidden worktree of the
  `taskwright-board` branch at `.taskwright/board/` and commits/syncs itself on events (activation,
  write bursts, merge boundaries) — no polling, and sync failures never block a board write or a git
  operation. Enabling it runs a guarded migration (safety snapshot first, every file verified before
  anything is removed) that handles boards previously tracked on code branches, existing `git`-mode
  refs, and older Taskwright layouts; switching back moves the board into `backlog/` again. A fresh
  clone bootstraps the board automatically. Note: with the board out of the repo root, upstream
  Backlog.md CLI tools no longer see it in this mode.

Design docs: `docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md` (modes
`off`/`git`) and `docs/superpowers/specs/2026-07-10-hidden-worktree-board-home-design.md` (`git-auto`).

## Requirements

- VS Code `^1.110.0`
- Node `>=22` and [Bun](https://bun.sh) to build from source
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI is **optional** — Taskwright reads and writes tasks natively (via its MCP server and `BacklogParser`/`BacklogWriter`). The CLI is only needed if you want the upstream cross-branch board view.
- On Windows: `git config --global core.longpaths true` (Backlog.md task filenames can exceed `MAX_PATH`)

## Setup commands

Three command-palette commands set up _different_ integrations — run the one that matches what you need:

| Command                                                          | What it does                                                                                                                                                                                                                                                             | When to run it                                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Taskwright: Set Up Backlog.md CLI**                            | Installs the optional [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI (if missing) and runs `backlog init`.                                                                                                                                                       | Only if you want the **cross-branch board view**. Taskwright reads and writes tasks without the CLI, so most users can skip this.                                                                                               |
| **Taskwright: Set Up Claude Code Integration (MCP + CLAUDE.md)** | Registers the bundled **Taskwright MCP server** with Claude Code (user scope) and adds the agent convention to your `CLAUDE.md`.                                                                                                                                         | If you dispatch tasks to **Claude Code** and want a fresh session to pull its task via `get_active_task` / `claim_task` / `release_task`. Taskwright offers this automatically the first time it detects an un-integrated repo. |
| **Taskwright: Set Up Codex Integration (MCP + skills)**          | Registers the **Taskwright MCP server** in Codex's `~/.codex/config.toml` and installs the four skills as **native `.agents/skills/` SKILL.md packages** (Codex's canonical, progressively-disclosed discovery surface); offers the shared `AGENTS.md` convention block. | If you dispatch tasks to **Codex** (`taskwright.dispatchAgent: "codex"`). Taskwright offers this automatically when it detects an un-integrated Codex install.                                                                  |

In short: **Set Up Backlog.md CLI** is about the optional upstream CLI; the **Claude Code** and **Codex** setup commands wire the respective agent to Taskwright's MCP server.

Codex gets the four workflow skills as **native `.agents/skills/` SKILL.md packages** (the same full, progressively-disclosed packages Claude Code gets in `.claude/skills/`, from one source of truth). They can also be distributed together with the Taskwright MCP server as a **Codex plugin** — see [docs/codex-plugin.md](docs/codex-plugin.md) for the install / update / uninstall flows.

### MCP registration lifecycle

The **Set Up Claude Code Integration** command registers the MCP server at **user scope** (`claude mcp add taskwright -s user …`). The registered command is a small launcher Taskwright writes into its `globalStorage` directory — a path keyed by extension **id**, not version — which resolves the current build at run time from a pointer file beside it.

- **On activation**, Taskwright refreshes that pointer so the launcher always runs the current build. This is a plain file write; it does not touch `~/.claude.json`. The registration itself is only (re)written when it is missing or stale, so the steady state never rewrites the shared config a running Claude Code session might be writing to concurrently.
- **On deactivation**, the registration is deliberately **left in place**. It is one global entry shared by every window and every running session, while `deactivate` runs per window — removing it there would delete Taskwright's tools for every other open window too. Because the registered path is version-independent, it cannot go stale, so there is nothing to clean up.

> **Uninstall:** VS Code does not run an extension's `deactivate` hook on uninstall, and the entry is intentionally persistent, so uninstalling Taskwright leaves the user-scope `taskwright` entry behind. Remove it with:
>
> ```bash
> claude mcp remove taskwright -s user
> ```

**User scope vs. project scope — why the general path is user scope.** The server _binary_
(`dist/mcp/server.js`) ships **inside the extension**, not in your project; the board _data_
(`backlog/`) lives in each project you initialize. User-scope registration points at the extension's
bundled binary and roots it at whatever repo you open, so any of **your** Taskwright-initialized
projects gets a working board with one registration. There is a **second** path used only when
hacking on Taskwright's own source: this repo's committed `.mcp.json` launches the server via
`scripts/taskwright-mcp.cjs`, which resolves _this checkout's_ built `dist/mcp/server.js` (and works
in its `.worktrees/`). That launcher needs a built Taskwright source tree, so it only applies to the
Taskwright repo itself — an end-user project has no build for it to find. If you develop Taskwright
**and** have set up the user-scope entry, `claude mcp list` will flag a `taskwright` scope conflict;
keep the project-scope entry here and drop the user-scope duplicate with
`claude mcp remove taskwright -s user`.

## Development

```bash
bun install
bun run build      # build:css + compile:webview + compile
# then press F5 in VS Code to launch an Extension Development Host
```

To install Taskwright into your own VS Code (no dev host), or to publish it:

```bash
bun run package    # builds, then emits taskwright-<version>.vsix
code --install-extension taskwright-1.0.0.vsix
```

Auto versioning

```bash
bunx @vscode/vsce publish patch    # 1.0.0 → 1.0.1
bunx @vscode/vsce publish minor    # 1.0.0 → 1.1.0
bunx @vscode/vsce publish major    # 1.0.0 → 2.0.0
```

See **[`docs/building-and-publishing.md`](docs/building-and-publishing.md)** for the full build,
install, and Marketplace-publishing guide.

### Quality gates

The dev and release automation is fully cross-platform — no script shells out to `bash` — and the
portable verification core (lint, typecheck, unused-dependency check, unit tests, build, and license
check) runs on both **Linux and Windows** in CI. A **dependency-audit gate** (`bun run audit:gate`)
fails the build on any new advisory at or above `high` severity that isn't in a reviewed, time-bounded
allowlist, so a security regression surfaces as human triage rather than silently sliding in; lower
findings are reported only. Every rendered task/document Markdown surface is sanitized against unsafe
link/image schemes (`javascript:` / `data:` / `vbscript:`) through one shared policy.

## Attribution

Taskwright is a derivative of **[vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md)**
by ysamlan and contributors, used under the MIT License. The original copyright notice is retained in
[`LICENSE`](LICENSE). Backlog.md itself is a separate MIT project by
[MrLesk](https://github.com/MrLesk/Backlog.md).

## License

MIT — see [LICENSE](LICENSE).
