---
id: TASK-123
title: >-
  enableSync git-auto verification: report why files fail, tolerate EOL
  normalization, fold a drifted board worktree
type: bug
status: To Do
assignee: []
created_date: '2026-07-12 16:48'
updated_date: '2026-07-12 16:48'
labels:
  - bug
  - board-sync
dependencies: []
priority: high
category: 'Board sync'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
In some repos "Enable Board Sync" (git-auto) permanently aborts, naming a few task files and giving NO reason, so the user cannot debug it. Repro repo: asterra-game (123 board files: 118 identical, 0 absent, 4 differ by line endings only, 1 by content).

Three defects, all in the git-auto migration's verify-before-delete step:

1. NO REASON REPORTED (the user-facing complaint). `verifyMove` (src/core/boardHomeMigration.ts:60) returns bare paths — it string-compares and never records WHY a file differs. extension.ts:527 then prints only `missing.length` and `missing[0]`. The user sees which tasks, never why, and "re-run to retry" never helps because the failure is deterministic.

2. EOL NORMALIZATION IS THE PERMANENT BLOCKER. asterra-game has `.gitattributes: * text=auto` and `core.autocrlf=true`. `snapshotBoardToRef` stages with NO_EOL_CONVERT (`-c core.autocrlf=false -c core.eol=lf`), but an IN-TREE `.gitattributes` overrides config — so a board file whose on-disk bytes are CRLF normalizes to LF in the blob; the board worktree (whose branch carries no `.gitattributes`) checks it out as LF; the raw string compare fails forever. The "round-trip byte-for-byte" claim at src/core/boardRef.ts:36 is false in any repo with `text=auto`. 4 of asterra-game's task files were blocked this way.

3. A DRIFTED BOARD WORKTREE IS COMPARED STALE. `ensureBoardWorktree` (src/core/boardWorktree.ts:73) short-circuits on an existing worktree (`created:false, seeded:'existing'`) WITHOUT resetting its working tree to the freshly-seeded ref tip. A failed migration leaves that worktree behind, so every retry compares the live board against stale working files: any task edited since (e.g. one an agent claimed mid-migration) fails verification. In asterra-game this was task-88, in flight in a .worktrees/ dir.

Manual unblock applied to asterra-game 2026-07-13 (normalize the 4 files to LF; `git worktree remove .taskwright/board`, which was clean and at the ref tip). The code must make that unnecessary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 verifyMove returns classified failures ({ path, reason: 'absent' | 'eol-only' | 'content-drift' }) instead of bare paths; existing callers (executeVerifiedMove, foldPrimaryStrays) keep working.
- [ ] #2 An EOL-only difference verifies as OK: git's own text=auto policy produced it, no content is lost, and the board becomes canonically LF. The primary copy is safe to delete in that case.
- [ ] #3 A pre-existing board worktree whose working tree has drifted from the live board no longer aborts the migration: the drift is folded (union merge, conflicts surfaced) or the worktree is synced to the freshly-seeded ref tip before verification — a repo cannot get permanently stuck by one failed attempt.
- [ ] #4 The abort notification lists EVERY failing file with its per-file reason (not just the count and missing[0]) and offers a details/output-channel action; it does not tell the user to 're-run to retry' when the failure is deterministic.
- [ ] #5 Unit tests in src/test/unit/boardHomeMigration.test.ts cover: eol-only verifies OK, absent vs content-drift are distinguished, and a drifted pre-existing board worktree completes instead of aborting.
- [ ] #6 bun run test && bun run lint && bun run typecheck all pass.
<!-- AC:END -->
