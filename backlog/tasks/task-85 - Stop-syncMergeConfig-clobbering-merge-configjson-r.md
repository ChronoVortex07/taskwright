---
id: TASK-85
title: >-
  Stop syncMergeConfig clobbering merge-config.json — republish only
  explicitly-set settings
status: Done
assignee: []
created_date: '2026-07-10 11:42'
updated_date: '2026-07-10 12:47'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: high
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
syncMergeConfig (src/extension.ts:200-218) unconditionally rewrites <commonDir>/taskwright/merge-config.json from VS Code settings on every activation. Any agent/CLI fix to the file (e.g. correcting stale `bun run test` verify commands in a pytest repo) is silently reverted on the next extension restart — documented as a durable trap in a claude-harness memory file, and observed forcing agents to contort package.json to satisfy wrong defaults instead.

Scope:
- Use cfg.inspect() to republish only keys the user explicitly set (workspace or global), merging over the existing file instead of overwriting it; merge-config.json remains the durable store for agent/CLI-made adjustments (including the new verifyTimeoutMs).
- Preserve current behavior for a missing/corrupt file (defaults still materialize).
- Unit-test the merge semantics: explicit setting wins over file; file wins over package.json default; corrupt file falls back.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 syncMergeConfig republishes only keys the user explicitly set (cfg.inspect(), workspace-folder > workspace > global), merged over the existing merge-config.json instead of overwriting it
- [x] #2 Agent/CLI-made adjustments in merge-config.json (verifyCommands, verifyTimeoutMs, ...) survive extension restarts when the corresponding VS Code setting is not explicitly set
- [x] #3 Missing or corrupt merge-config.json still materializes full defaults
- [x] #4 Unit tests cover: explicit setting wins over file; file wins over package.json default; corrupt file falls back
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause: syncMergeConfig (src/extension.ts) built a full MergeConfig from cfg.get() — which returns package.json defaults for unset keys — and wrote it wholesale, so any agent/CLI adjustment to <commonDir>/taskwright/merge-config.json was reverted on every activation/config change.

Fix (pure core in src/core/mergeConfig.ts, TDD):
- explicitSettingValue<T>(inspectResult): resolves a WorkspaceConfiguration.inspect() result to the user's explicit value (workspaceFolderValue > workspaceValue > globalValue); package.json defaultValue is never treated as explicit.
- publishMergeConfig(filePath, explicit, fsDeps): reads the existing file raw (missing/corrupt/non-object JSON -> {} so defaults still materialize), overlays only defined explicit keys, coerces the union through the existing resolveMergeConfigFromSettings, and writes atomically. Semantics: explicit > file > default.
- syncMergeConfig now feeds cfg.inspect()-derived explicit values (minutes->ms conversion applied only to explicit values; non-positive/invalid treated as not-set) into publishMergeConfig instead of resolve+writeMergeConfig.

Coverage: 10 new tests in src/test/unit/mergeConfig.test.ts (explicit precedence, file durability for agent-set verifyCommands/timeouts, corrupt/array payload fallback, coercion parity with readMergeConfig, atomic write path). Full suite 1695 passed; lint + typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
merge-config.json is now a durable store: syncMergeConfig republishes only explicitly-set VS Code settings (via cfg.inspect()) merged over the existing file through the new pure core publishMergeConfig/explicitSettingValue (src/core/mergeConfig.ts), so agent/CLI fixes (e.g. corrected verify commands in a non-bun repo) survive extension restarts. Missing/corrupt files still materialize defaults. 10 new unit tests; test/lint/typecheck green.
<!-- SECTION:FINAL_SUMMARY:END -->
