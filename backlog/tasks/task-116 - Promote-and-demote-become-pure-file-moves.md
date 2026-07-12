---
id: TASK-116
title: Promote and demote become pure file moves
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 16:42'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-115
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/core/BacklogWriter.ts
priority: high
category: 'Core Board'
claimed_by: '@agent/task-116-promote-and-demote-become-pure-file-moves'
worktree: task-116-promote-and-demote-become-pure-file-moves
claimed_at: '2026-07-13 07:02'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 4 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

Modify `src/core/BacklogWriter.ts:400-462` (`promoteDraft`) and `:464-513` (`demoteTask`).

**This is the payoff of the whole feature.** With drafts carrying task IDs (TASK-115), promote and demote collapse to pure file moves: the ID never changes, the status is preserved, and there is nothing to remap. A reference written against a draft — structurally *or in prose* — stays valid forever.

`promoteDraft` returns the **unchanged** ID for a stable-ID draft, and a fresh `TASK-M` for a **legacy** `DRAFT-N` draft (the legacy path stays). `promoteDrafts` (TASK-113) already handles both — it remaps only when `from !== to`.

Preserve CRLF/LF on the move (the existing `detectCRLF` / `normalizeToLF` / `restoreLineEndings` sandwich in `promoteDraft` is there for a reason — this repo is developed on Windows and a line-ending flip corrupts the whole file in git).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `promoteDraft` on a stable-id draft is a PURE MOVE: same id returned, file relocated drafts/ → tasks/, status preserved, old file gone.
- [ ] #2 A Done draft promotes to a Done task (status preserved, not reset to the board default — P6/D2d).
- [ ] #3 LEGACY path intact: a `DRAFT-N` draft still re-ids to a fresh `TASK-M` on promotion.
- [ ] #4 `demoteTask` is likewise a pure move: same id, same status, file relocated tasks/ → drafts/.
- [ ] #5 CRLF/LF is preserved across both moves.
- [ ] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
