---
id: TASK-1
title: Migrate extension namespace from backlog.* to taskwright.*
status: To Do
assignee: []
created_date: '2026-06-30 11:38'
labels:
  - refactor
  - bug
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
All contributed commands, configuration keys, the activity-bar view container id, and views are still in the inherited backlog.* namespace from vscode-backlog-md. Two problems: (1) activation collision - identical command IDs plus identical activationEvents mean that if both extensions are installed they both activate and the second registerCommand throws command already exists, breaking activation; (2) branding incoherence - the product and config section title are Taskwright but the keys are backlog.*. Rename the contribution surface to taskwright.* and add a settings-migration shim that still reads legacy backlog.* values.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All contributed commands, views, viewsContainers, and configuration properties use the taskwright.* namespace
- [ ] #2 registerCommand calls and internal code references are updated to match
- [ ] #3 Legacy backlog.* user settings are migrated or aliased so existing configs keep working
- [ ] #4 No backlog.* command or config identifiers remain in package.json contributes (Backlog.md data fields excepted)
- [ ] #5 typecheck, lint, and unit tests pass
<!-- AC:END -->
