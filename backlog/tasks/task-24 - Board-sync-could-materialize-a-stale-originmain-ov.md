---
id: TASK-24
title: >-
  Board sync could materialize a stale origin/main over the repo root
  (FETCH_HEAD race)
type: bug
status: Done
assignee: []
created_date: '2026-07-03 12:57'
updated_date: '2026-07-04 00:42'
labels:
  - bug
  - sync
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Root cause of the recurring "root flush" that reverted the repo root throughout the tech-tree run (run-notes INCIDENTs 1-3 + recurrences; also the Jul 2 "reviewer reverted the root" incident — the reviewer was exonerated).

`fetchRef` (src/core/boardRef.ts) resolved the fetched tip via `git rev-parse FETCH_HEAD`. FETCH_HEAD is a single unlocked file shared by every fetch in the repo: a concurrent full `git fetch` (VS Code `git.autofetch`, GitKraken) rewrites it with `main`'s stale tip (dd4da0b, 2026-07-01) as the for-merge line. When that landed between the board poll's fetch and its rev-parse, `refreshBoard` setLocalRef'd `taskwright-board` to the full July-1 code tree and `checkout-index --all --force` wrote all 335 files over the repo root (cwd = repoRoot). Proof: every dd4da0b insertion in `git reflog show taskwright-board` matches a flush timestamp to the second (Jul 2 18:58:17, 23:14:08; Jul 3 19:26:44, 20:33:05, ...), all on the 20s poll lattice.

Fix (commit dd5e4e2): (1) fetchRef now fetches into a private staging ref `refs/taskwright/fetch/<ref>` with a forced refspec and rev-parses that — FETCH_HEAD is never read; (2) materializeRefToWorktree refuses any tree containing paths outside backlog/{tasks,drafts,completed,archive}, so a poisoned ref can never write outside the board dirs again. Regression tests: FETCH_HEAD-poisoning race, compacted-ref fetch, non-board-tree refusal.

Residual open bug (separate): `.taskwright/board.materialized` is frozen at 2026-07-01 21:59 — refreshBoard appears to throw after checkout-index and before writeMaterialized on every poll, so the board re-materializes every tick and poll errors are swallowed (console.error only).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
