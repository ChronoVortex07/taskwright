---
id: TASK-4
title: Make unit tests path-separator-agnostic so they pass on Windows
status: Done
assignee: []
created_date: '2026-06-30 11:39'
updated_date: '2026-06-30 15:19'
labels:
  - test
dependencies: []
priority: medium
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
About 21 unit tests hardcode POSIX paths such as /repo/backlog and fail on Windows where path methods produce backslashes. The production code is already cross-platform-correct and must not change. Normalize separators in the test assertions for BacklogParser, BacklogWriter, CrossBranchIntegration, and openWorkspaceFile so the suite is green on both Linux and Windows.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bun run test passes on Windows with zero failures
- [x] #2 Assertions compare path.sep-normalized paths rather than hardcoded forward slashes
- [x] #3 Tests still pass on Linux and CI
- [x] #4 No production source files are modified
- [x] #5 CrossBranchDemoSetupScript (a POSIX-shell-dependent test outside the 4 named files) is skipped on Windows; it still runs on Linux/CI
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reproduce the Windows failures with `bun run test` (22 failed across 5 files).
2. Add a shared test helper `src/test/helpers/paths.ts`: `toPosix()` (separator normalize) + `posixPath()` asymmetric matcher (normalizes separators + strips drive letter; usable in toEqual/toHaveBeenCalledWith/objectContaining).
3. BacklogParser (5): normalize incoming path in mock callbacks with `toPosix`; build the cache-invalidation key with `path.join`.
4. BacklogWriter (12): wrap path assertions in `posixPath`; `toBe(path)` -> `toEqual(posixPath(path))`; normalize createMilestone mock callbacks; build the restoreArchivedTask fixture filePath with `path.join`.
5. openWorkspaceFile (3): wrap the 3 path.resolve-based fsPath assertions in `posixPath`.
6. CrossBranchIntegration (1): replace POSIX backslash-escaped `git show` arg with portable double-quoting.
7. CrossBranchDemoSetupScript (out-of-scope 22nd failure): skip on win32 (unreliable bash resolution).
8. Verify: `bun run test` (0 failures), `bun run lint`, `bun run typecheck`.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Root cause: production builds paths with `path.*` (backslashes on Windows; `path.resolve` also adds a `C:` drive), but ~21 tests hardcoded POSIX expectations. Production was NOT changed.

Two failure shapes, two fixes: (a) mock callbacks doing `String(p).includes('/...')` -> normalize incoming path with `toPosix(String(p))`; (b) assertions comparing actual paths to hardcoded `/...` -> a `posixPath()` asymmetric matcher (normalizes separators + strips drive letter). The matcher is a plain object with `asymmetricMatch` (no expect.extend / type augmentation); confirmed it plugs into toEqual, toHaveBeenCalledWith, and nested expect.objectContaining.

Notable: BacklogWriter restoreArchivedTask failed because production `moveTaskToFolder` detects the archive folder via `task.filePath.includes(path.join('archive','tasks'))` -- correct in real use (BacklogParser emits native-separator filePaths) but the fixture used forward slashes, so isArchived was false on Windows and the file "moved" back into archive/tasks. Fixed the FIXTURE (path.join), not production.

New test-only file `src/test/helpers/paths.ts`. toPosix, posixPath, and the path.join-built fixtures/keys are identity/no-ops on POSIX, so Linux/CI is unchanged.

Scope: task named 4 files / "about 21" -- BacklogParser(5)+BacklogWriter(12)+openWorkspaceFile(3)+CrossBranchIntegration(1)=21, all fixed. The 22nd (CrossBranchDemoSetupScript) is a different category: execFileSync('bash', ...) resolves to WSL bash here, which mangles the Windows backslash script path; WSL vs Git Bash use incompatible path conventions, so no single path form works. Skipped on win32 (still runs on Linux/CI).

Verification (Windows): `bun run test` -> 1089 passed | 1 skipped | 0 failed; lint + typecheck clean.

Unrelated concurrent edits in the working tree (src/core/AgentIntegrationDetector.ts + test + package.json) are not mine and were excluded from the commit.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made the Windows-failing unit tests path-separator-agnostic without touching production code. Added a test-only helper (src/test/helpers/paths.ts) with toPosix() and a posixPath() asymmetric matcher, then normalized assertions/mock-callbacks in BacklogParser, BacklogWriter, openWorkspaceFile, and CrossBranchIntegration. bun run test now reports 0 failures on Windows (1 POSIX-shell-dependent test skipped on win32) and is unchanged on Linux/CI; lint and typecheck pass.
<!-- SECTION:FINAL_SUMMARY:END -->
