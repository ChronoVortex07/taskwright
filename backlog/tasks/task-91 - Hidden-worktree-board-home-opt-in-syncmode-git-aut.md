---
id: TASK-91
title: >-
  Hidden-worktree board home — opt-in sync.mode 'git-auto' with event-driven
  auto-sync
status: Done
assignee: []
created_date: '2026-07-10 11:43'
updated_date: '2026-07-11 01:36'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-87
  - TASK-88
priority: high
category: Sync
plan: docs/superpowers/plans/2026-07-11-hidden-worktree-board-home.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make a hidden worktree at <git-common-dir>/taskwright/board (checked out on the taskwright-board branch) the board's ONE physical home: resolveBoardRoot() returns it, so every reader/writer (MCP server + extension host) repoints with one change. This keeps the v2 invariant that killed v1 (one copy, nothing to reconcile) while making sharing automatic instead of a button nobody presses (push_board/pull_board: ~0 real calls in transcript forensics).

Structural wins: the board leaves every code working tree, so task files can never be wrongly tracked (gitignore machinery becomes legacy-migration only), backlog-file rebase conflicts disappear, ffMergeToBase's backlog/ special-casing simplifies, and the board gets real git history.

Auto-sync design (v1 lessons are load-bearing):
- Writes land directly in the hidden worktree — NO materialized copy, no CAS, no poll loop.
- Debounced auto-commit after MCP/UI writes (5-10s); pull --rebase + push triggered by EVENTS (activation, before/after request_merge, after a write burst), single-flight mutex (FETCH_HEAD race lesson), explicit refspecs.
- Pull merges via the existing boardMerge.ts union-merge on conflict; NEVER reset --hard/checkout-over; conflicts always surfaced (status bar + notification).
- Sync failure degrades to a status-bar warning; never blocks a board write; offline accumulates local commits.

Scope also includes: enableSync migration (move backlog/{tasks,drafts,completed,archive,milestones} into the hidden worktree; decide config.yml/docs placement), FileWatcher repoint, keep discrete push_board/pull_board as the manual escape hatch, mode set becomes off | git | git-auto (syncConfig.ts migration), docs + e2e fixtures. Accepted divergence: upstream Backlog.md CLI expects backlog/ at repo root — do NOT reach for a Windows junction (rejected before: worktree remove --force follows reparse points).

Design ref: docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md (v1 postmortem in §1). Likely warrants a design spec + plan before execution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 sync.mode supports 'git-auto' end-to-end: package.json enum, syncConfig coerceMode pass-through, legacy 'local'/'github' coercions untouched; shared sync-config.json remains the cross-process truth
- [x] #2 In git-auto, resolveBoardRoot/resolveWorkspaceBacklogRoot return <primary>/.taskwright/board/backlog; off/git behavior byte-identical to v2
- [x] #3 boardWorktree.ts creates/repairs/locates the board worktree on branch taskwright-board (seeded from existing ref when present) with per-worktree core.autocrlf=false
- [x] #4 Primary-root accessor threaded everywhere: no consumer derives the primary root via path.dirname(backlogPath) (providers, doctor, active-task, MCP makePrimaryBoard); documentSelector gains milestones/
- [x] #5 enableSync gains a mode picker and handles the S0-S6 prior-state matrix idempotently: pre-move ref snapshot, verify-before-delete move, mode flip only after verified move, reload prompt
- [x] #6 S2 (tracked board files): untrack + fenced gitignore block upgraded to 5 dirs incl. milestones/, committed; uncommitted board edits survive (working tree is truth)
- [x] #7 S3 (v2 git mode): seed union-merges live board with existing local ref and reachable remote (mergeBoards, two-parent commit continuing ref history, ff-able push); conflicts surfaced never dropped
- [x] #8 S4 (v1 leftovers): board.materialized deleted opportunistically; legacy modes coerce; stale materialized copies inert
- [x] #9 S5 (fresh clone, mode=git-auto committed): activation bootstraps branch+worktree from origin ref without enableSync
- [x] #10 Auto-sync engine: debounced commit pathspec-limited to the five boardTrackedPaths (with identity fallback), event-driven single-flight sync (explicit-refspec fetch, mergeBoards fold, two-parent commit, reset --keep, best-effort push); no interval polling; degrades to status bar and never blocks a board write or git op
- [x] #11 Split-brain heal: stray state dirs in primary backlog/ under git-auto are folded via mergeBoards then removed, at activation and before sync
- [x] #12 Board doctor: new findings board-worktree-missing, board-strays-in-primary, board-mode-mismatch with one-click repairs; MCP board_doctor description updated; reverse migration (git-auto back to git/off) supported
- [x] #13 push_board/pull_board remain the manual escape hatch in git-auto (enqueue the same sync); status bar shows mode/last-sync/pending/conflicts
- [x] #14 Docs updated (CLAUDE.md/AGENTS.md sync sections, Backlog.md-CLI divergence in git-auto); ffMergeToBase backlog/ carve-out kept for off/git and covered as inert in git-auto
- [x] #15 Tests green on Windows: unit (mode-aware root, sync planner, debounce/lock, migration classifier, doctor) + integration (round-trip, divergence, offline, worktree-loss repair, S1-S6 migration matrix incl. idempotent re-run, reverse migration, stray fold, dirty board never blocks request_merge); bun run test && lint && typecheck clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented across 12 plan-task commits on the task branch (spec + plan committed first). Deviations from spec pass 2, all recorded in commit messages: (1) per-worktree line-ending safety uses per-command `-c core.autocrlf=false -c core.eol=lf` flags (the boardRef pattern) instead of persistent extensions.worktreeConfig — same byte-exactness, no repo-config mutation, avoids the core.bare migration caveat; (2) check 10 (board-mode-mismatch) keys on the leftover .taskwright/board DIRECTORY rather than the branch, which is the precise residue of a hand-flip and avoids false positives on fresh v2-git boards; (3) migrateToGitAuto folds the remote immediately after the verified move (when reachable) instead of waiting for the first post-reload sync. Engine safety properties verified structurally: pathspec-limited add guarantees old v2 clients' non-board-path materialize guard can never trip on an auto-committed ref; reset --keep only ever runs after commit-if-dirty under the same cross-process lock; runBoardAutoSync never throws. Full gates at close: 1930/1930 unit+integration tests, lint, typecheck — 0 failures on Windows.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the opt-in sync.mode 'git-auto': the board's one physical home moves into a hidden linked worktree of the taskwright-board branch at .taskwright/board (split root: config.yml/docs/decisions stay in repo backlog/), with an event-driven auto-commit/sync engine (debounced capture, staged-ref fetch, mergeBoards two-parent fold, reset --keep, best-effort push under a cross-process lock — no polling, degrades to the status bar, never blocks a write or git op). Migration is only via the enableSync mode picker and is hardened for every prior state (S0-S6: fresh repos/clones, ignored boards, board files tracked on code branches with stale 4-dir gitignore blocks, existing v2 refs with divergent remotes, v1 CAS leftovers, idempotent re-runs) using a pre-move ref snapshot and per-file verify-before-delete ordering; the mode flips only after the verified move, and reverse migration is supported. Activation bootstraps fresh clones and heals split-brain strays; the board doctor gained board-worktree-missing / board-strays-in-primary / board-mode-mismatch repairs; push_board/pull_board remain the manual escape hatch. New cores: boardWorktree.ts, autoSync.ts, boardHomeMigration.ts, mode-aware boardHomeFor/resolveBoardHome, BacklogParser.getPrimaryRoot (replacing 13 dirname(backlogPath) repo-root derivations). Coverage: 8 new/extended unit suites + an 11-scenario real-git integration suite.
<!-- SECTION:FINAL_SUMMARY:END -->
