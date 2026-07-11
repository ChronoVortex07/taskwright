---
id: TASK-82
title: Fix request_merge worktree-target drive-letter-case mismatch on Windows
type: bug
status: Done
assignee: []
created_date: '2026-07-08 08:25'
updated_date: '2026-07-08 08:31'
labels: []
dependencies: []
priority: high
category: Orchestration
caused_by: TASK-74
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Second Windows bug in request_merge { worktree } (found dogfooding TASK-81, after TASK-80 fixed the relative-git-dir resolution). resolveWorktreeTarget Gate 2 compares `path.resolve(e.path) === abs` with strict ===. path.resolve normalizes separators but NOT the Windows drive-letter case: `git worktree list --porcelain` reports `C:/…` while primaryRoot (derived from deps.root/TASKWRIGHT_ROOT) can be lowercase `c:` → strict === fails → aborts "not a linked worktree". Fix: case-insensitive path comparison on win32 (isSamePath helper, injectable platform flag for cross-platform tests); use it in Gate 2. Confirmed: `c:` vs `C:` fails strict ===, passes case-insensitive. Patch 1.2.1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Second Windows bug in request_merge{worktree}, found dogfooding TASK-81's live demo. resolveWorktreeTarget Gate 2 compared path.resolve(e.path) === abs strictly; path.resolve normalizes separators but NOT the Windows drive-letter case, so git worktree list's C:\ vs a c:\-derived primaryRoot missed → aborted "not a linked worktree". Fix: new exported isSamePath(a,b,winLike) — case-insensitive on win32, exact on POSIX — used in Gate 2; cross-platform unit tests. Verified 1671 vitest + lint/typecheck/build green. Released 1.2.1, fast-forwarded to main. Together with TASK-80's relative-git-dir fix, request_merge{worktree} now works from a primary-rooted session on Windows.
<!-- SECTION:FINAL_SUMMARY:END -->
