---
id: TASK-16
title: >-
  Surface board config (config.yml) editing — statuses, labels, milestones, and
  defaults
status: To Do
assignee: []
created_date: '2026-07-01 10:34'
updated_date: '2026-07-01 10:34'
labels: []
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Taskwright currently **reads** `backlog/config.yml` but offers no in-app way to **edit** it. Every project-level setting must be hand-edited in the raw file. Upstream Backlog.md exposes these via its `backlog config` CLI/TUI, so this is the main not-yet-surfaced gap found in a settings/command audit (2026-07-01).

Note the distinction: VS Code *extension* settings (`taskwright.*` in `package.json` → `contributes.configuration`) are complete and correct. This task is about the **board's own project config** stored in `backlog/config.yml`, which is separate.

The audit also confirmed (no action needed): every `taskwright.*` setting read in code is declared in the manifest; all task operations (promote/demote/archive/restore/complete/create-subtask/edit) are reachable via the detail panel + MCP; the only palette-absent commands (`filterByStatus`, `filterByLabel`, `openRawMarkdown`) are internal-by-design.

## Goal

Give users a command and/or lightweight editor to manage the board vocabulary and project options without hand-editing YAML, writing changes through a config writer that preserves Backlog.md's line-by-line `config.yml` format byte-compatibly (mirror how `BacklogWriter` preserves frontmatter).

## Scope (config.yml fields to cover)

- **Board vocabulary (highest value):** statuses (add / rename / reorder / remove), labels, milestones (a `createMilestone` command already exists — align with it)
- **Defaults:** `default_status`, `definition_of_done`, `default_assignee` / `default_reporter`
- **ID/format:** `task_prefix`, `zero_padded_ids`, `date_format`
- **Git/board behavior:** `auto_commit`, `check_active_branches` / `active_branch_days`, `remote_operations`, `bypass_git_hooks`

## Acceptance Criteria

- [ ] A `taskwright.editBoardConfig` command (palette + a control in the board/settings UI) opens config editing.
- [ ] Users can add / rename / reorder / remove statuses; changes propagate to kanban columns without a manual reload.
- [ ] Users can add / remove labels and milestones.
- [ ] Users can set default_status, definition_of_done, and the git/behavior flags (auto_commit, check_active_branches, active_branch_days, remote_operations, bypass_git_hooks).
- [ ] Writes go through a dedicated config writer (new `ConfigWriter` or extend `BacklogWriter`) that round-trips the existing `config.yml` byte-for-byte except for the changed keys — verified against a fixture matching upstream Backlog.md output.
- [ ] Invalid edits are rejected (e.g. removing a status still used by tasks warns/blocks; renaming a status offers to migrate affected tasks).
- [ ] Unit tests cover the config writer round-trip and validation; behavior aligns with upstream `backlog config` where it exists.

## Notes / open questions

- Research upstream `backlog config` behavior first (per AGENTS.md behavior-alignment policy) before finalizing UX.
- Likely warrants breakdown into subtasks (writer core → board vocabulary editor → defaults/flags editor). Consider `create_subtask` once the approach is chosen.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
