---
id: TASK-70
title: Move src/hooks/ to scripts/hooks/ for clearer separation from library code
status: Done
assignee: []
created_date: '2026-07-04 14:20'
updated_date: '2026-07-04 14:35'
labels: []
dependencies: []
priority: low
category: Polish
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The src/hooks/ directory contains compiled git hook scripts (board-sync-hook.ts, worktree-guard.ts, worktree-warn.ts) that build to dist/hooks/. These are closer to standalone scripts than library code. Move them to scripts/hooks/ and update the build config accordingly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Moved src/hooks/ to scripts/hooks/:
- git mv: board-sync-hook.ts, worktree-guard.ts, worktree-warn.ts → scripts/hooks/
- Updated relative imports: ../core/ → ../../src/core/ (one extra level from new location)
- Updated scripts/build.ts entryPoints: src/hooks/ → scripts/hooks/
- Updated test import: boardSyncHook.test.ts → ../../../scripts/hooks/board-sync-hook
- Updated tsconfig.json: rootDir "." + include scripts/hooks/**/* (typecheck-only, --noEmit safe)
- Removed empty src/hooks/ directory
- Build output (dist/hooks/) unchanged — extension and launcher reference it at runtime
<!-- SECTION:NOTES:END -->
