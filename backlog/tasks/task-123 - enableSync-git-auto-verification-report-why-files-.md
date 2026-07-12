---
id: TASK-123
title: >-
  enableSync git-auto verification: report why files fail, tolerate EOL
  normalization, fold a drifted board worktree
type: bug
status: In Progress
assignee: []
created_date: '2026-07-12 16:48'
updated_date: '2026-07-12 17:10'
labels:
  - bug
  - board-sync
dependencies: []
priority: high
category: Board sync
claimed_by: '@agent/task-123-enablesync-git-auto-verification-report-why-files-fail-tolerate-eol-normalization-fold-a-drifted-board-worktree'
worktree: task-123-enablesync-git-auto-verification-report-why-files-fail-tolerate-eol-normalization-fold-a-drifted-board-worktree
claimed_at: '2026-07-13 00:59'
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
- [x] #1 verifyMove returns classified failures ({ path, reason: 'absent' | 'eol-only' | 'content-drift' }) instead of bare paths; existing callers (executeVerifiedMove, foldPrimaryStrays) keep working.
- [x] #2 An EOL-only difference verifies as OK: git's own text=auto policy produced it, no content is lost, and the board becomes canonically LF. The primary copy is safe to delete in that case.
- [x] #3 A pre-existing board worktree whose working tree has drifted from the live board no longer aborts the migration: the drift is union-merge folded (conflicts surfaced) before the verified move — a repo cannot get permanently stuck by one failed attempt.
- [x] #4 The abort notification lists EVERY failing file with its per-file reason behind a 'Show details' output channel, and does not tell the user to 're-run to retry' when the failure is deterministic.
- [x] #5 Unit tests cover eol-only verifying OK, absent vs content-drift, and a drifted worktree completing; integration tests reproduce BOTH field shapes against real git (text=auto normalization; stale worktree).
- [x] #6 bun run test && bun run lint && bun run typecheck all pass (2097 tests).
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Diagnosed against the live repro repo (asterra-game) rather than from code alone: re-running verifyMove's comparison over its 123 board files gave 118 identical, 0 absent, 4 EOL-only, 1 content-drift — which named all three defects at once.

1. **No reason** (the reported symptom). `verifyMove` returned `string[]`; extension.ts:527 printed `missing.length` + `missing[0]`. Now returns `{ ok, blocking: MoveFailure[], eolOnly: MoveFailure[] }` with reason `absent | eol-only | content-drift`, and `showMigrationBlockers` lists every blocker with its reason + remedy behind a "Show details" output channel.

2. **EOL normalization was the permanent blocker.** `.gitattributes: * text=auto` (+ core.autocrlf=true) normalizes CRLF→LF into the blob on `git add`. Crucially, an IN-TREE attribute overrides config, so `NO_EOL_CONVERT` (`-c core.autocrlf=false -c core.eol=lf`) cannot prevent it — the "round-trip byte-for-byte" claim at boardRef.ts:36 is false in any such repo. The board worktree (whose branch carries no .gitattributes) then checks the file out as LF, and byte equality fails forever. An EOL-only difference is now VERIFIED: git's own declared policy produced it, no content is lost, and the board becomes canonically LF. (Rejected alternative: rewriting the user's primary files to LF before snapshot — that mutates their working tree to satisfy our check.)

3. **Stale worktree comparison.** `ensureBoardWorktree` short-circuits on an existing worktree (`seeded:'existing'`) WITHOUT resetting its working tree to the newly-seeded ref tip; an aborted migration leaves exactly such a worktree behind. So each retry compared the live board against stale working files and re-aborted on anything edited since — self-perpetuating. New `moveBoardIntoWorktree` core: classify → if blocking, union-merge the drift forward with `mergeBoards` (newer `updated_date` wins, conflicts surfaced, EOL-equal files excluded from the merge so they cannot raise phantom conflicts) → commit → verified move. `foldPrimaryStrays` now delegates to it, so the activation split-brain heal and the board-doctor repair inherit the same tolerance.

Both field shapes are covered by integration tests against REAL git — a hand-rolled fixture cannot fake `text=auto` normalization or a stale worktree's working files.

asterra-game was also unblocked by hand this session (4 files normalized to LF; the clean, at-tip board worktree removed so it is recreated from a fresh snapshot). The code change makes that manual step unnecessary.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
"Enable Board Sync" can no longer wedge a repo, and when it does refuse it says why. EOL-only differences (git's own text=auto normalization) verify instead of blocking forever; a board worktree that drifted from the live board is union-merge folded rather than aborted against; and every blocker is listed with its reason and remedy. Verified: 2097 unit tests, plus real-git integration tests reproducing both field shapes; lint and typecheck clean.
<!-- SECTION:FINAL_SUMMARY:END -->
