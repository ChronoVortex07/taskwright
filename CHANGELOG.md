# Changelog

All notable changes to Taskwright are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial **Taskwright** project, derived from
  [vscode-backlog-md](https://github.com/ysamlan/vscode-backlog-md) (MIT). Inherits the editor-tab
  Kanban board, task list, detail editor, Markdown/Mermaid rendering, frontmatter autocomplete, and
  cross-branch task loading on a [Backlog.md](https://github.com/MrLesk/Backlog.md) backbone.
- `taskwright.dispatchTerminalCommand` setting: an optional shell command (templated on
  `{{handoffFile}}`) run in the dispatch worktree terminal after dispatch. Commands invoking
  `claude -p`/`--print` (headless/metered) are refused to keep dispatch subscription-safe.

### Changed

- Rebranded the extension identity to Taskwright (`v0.0.1`).
- Dispatch now creates an isolated git worktree by default (`taskwright.dispatchCreateWorktree`
  defaults to `true`; set `false` to opt out), so parallel sessions never share a working directory.
  Falls back to the workspace root when not in a git repository.
