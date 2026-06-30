---
id: TASK-1
title: Migrate extension namespace from backlog.* to taskwright.*
status: Done
assignee: []
created_date: '2026-06-30 11:38'
updated_date: '2026-06-30 13:40'
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
- [x] #1 All contributed commands, views, viewsContainers, and configuration properties use the taskwright.* namespace
- [x] #2 registerCommand calls and internal code references are updated to match
- [x] #3 Legacy backlog.* user settings are migrated or aliased so existing configs keep working
- [x] #4 No backlog.* command or config identifiers remain in package.json contributes (Backlog.md data fields excepted)
- [x] #5 typecheck, lint, and unit tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a read-time settings shim: pure `resolveConfigWithFallback` (src/core/configFallback.ts) + vscode wrapper `getTaskwrightConfig`/`affectsTaskwrightConfig` (src/config.ts) that read `taskwright.*` and fall back to legacy `backlog.*` via inspect().\n2. Route all config read sites through the shim (claimActions, intakeActions, dispatchActions, TasksController, extension.ts config-change watcher).\n3. Rename package.json contributes: configuration property keys, command IDs, menus when-clause, viewsContainers id, views key + view ids — all backlog.* -> taskwright.*.\n4. Update extension.ts registerWebviewViewProvider/registerCommand/executeCommand/statusbar refs (incl .focus). Leave setContext + globalState keys as backlog.* (runtime/persisted state, not contributed identifiers, no collision).\n5. Update providers (TasksController, TaskPreviewViewProvider, TasksViewProvider, TaskCreatePanel) and language/BacklogDocumentLinkProvider command/view refs.\n6. Update unit + CDP tests to the new namespace.\n7. typecheck + lint + unit tests green.\n\nOut of scope (follow-up): AgentIntegrationDetector still checks mcpServers.backlog / BACKLOG.MD markers — separate concern (MCP-name detection + guidelines writer), not the VS Code contribution surface.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Migrated the VS Code contribution surface from the inherited `backlog.*` namespace to `taskwright.*`.

Settings shim (read-time alias, not a rewrite of user settings.json):
- `src/core/configFallback.ts` — pure `resolveConfigWithFallback(primary, legacy, default)` (unit-tested in configFallback.test.ts; ignores the contributed `defaultValue`, only an explicit user/workspace/folder override counts, folder>workspace>global, new namespace wins over legacy).
- `src/config.ts` — `getTaskwrightConfig(key, default)` inspects `taskwright.*` then falls back to `backlog.*`; `affectsTaskwrightConfig(event, key)` matches either namespace. VS Code's inspect() surfaces user-set values even for now-unregistered `backlog.*` keys, so legacy configs keep working.
- Read sites routed through the shim: claimActions, intakeActions, dispatchActions, TasksController.getTasksViewSettings, extension.ts onDidChangeConfiguration.

package.json contributes: all 7 configuration property keys, all command IDs, the view/title menu when-clause, viewsContainers id (`backlog`->`taskwright`), the views map key, and both webview view ids (`taskwright.kanban`, `taskwright.taskPreview`).

Code refs updated: registerCommand/registerWebviewViewProvider/executeCommand/.focus, statusbar command, language DocumentLink `command:taskwright.openTaskDetail` URI, and webview panel viewTypes (taskDetail/createTask/contentDetail/tasksEditor) for coherence (no serializers registered, safe). Internal commands not in contributes (filterByStatus/filterByLabel/openRawMarkdown) renamed with their executeCommand callers.

Intentionally LEFT as backlog.* (not contributed identifiers, no activation collision, renaming would lose persisted state or is churn): context.globalState keys (viewMode/showingDrafts/milestoneGrouping/collapsedColumns/collapsedMilestones/integrationBannerDismissed/activeBacklogPath), setContext runtime keys (`backlog.viewMode`, no `when` consumers), on-disk `backlog/` data paths + activationEvents, `backlog.config.yml`, and the `backlog.md` CLI/package name.

Tests: reworked TasksViewProvider settings tests to stub inspect() + added a legacy-fallback case; updated command/view-id assertions across TasksController/TaskPreview/TaskCreate/TaskDetail/TasksPanel/BacklogDocumentLink unit tests and the CDP cdp-helpers keybinding/label maps, cross-view.test, wait-helpers.

Verification: `bun run typecheck` and `bun run lint` clean; `bun run compile` builds extension.js + mcp/server.js. `bun run test` = 1041 passed; the 22 failures are the pre-existing Windows POSIX-path tests documented in CLAUDE.md (confirmed identical 22 on clean main via stash), not introduced here.

Out of scope (follow-up): AgentIntegrationDetector still detects `mcpServers.backlog` / `<!-- BACKLOG.MD MCP GUIDELINES -->` markers; the real MCP server name is `taskwright` (claudeMcp.ts), so detection of a set-up Taskwright MCP is currently a latent miss. That's a separate concern (detector + the setup writer + guidelines markers), not the contribution-surface namespace this task covers.
<!-- SECTION:NOTES:END -->
