---
id: TASK-116
title: Promote and demote become pure file moves
status: In Progress
assignee: []
created_date: '2026-07-12 16:42'
updated_date: '2026-07-12 23:09'
labels:
  - stable-task-ids
milestone: Stable Task IDs
dependencies:
  - TASK-115
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/core/BacklogWriter.ts
priority: high
category: Core Board
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
- [x] #1 `promoteDraft` on a stable-id draft is a PURE MOVE: same id returned, file relocated drafts/ → tasks/, status preserved, old file gone.
- [x] #2 A Done draft promotes to a Done task (status preserved, not reset to the board default — P6/D2d).
- [x] #3 LEGACY path intact: a `DRAFT-N` draft still re-ids to a fresh `TASK-M` on promotion.
- [x] #4 `demoteTask` is likewise a pure move: same id, same status, file relocated tasks/ → drafts/.
- [x] #5 CRLF/LF is preserved across both moves.
- [x] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

**`src/core/BacklogWriter.ts`**
- New exported module-level helper **`idHasPrefix(id, taskPrefix)`** — the ONE legacy-draft predicate. It tests the board's configured prefix (case-insensitive, numeric suffix required), never the literal string `DRAFT-`, so a custom-`task_prefix` board (`STORY-4`) correctly classifies its own drafts as stable rather than legacy. **TASK-118's migration MUST import this same predicate** — if the two disagreed, a draft could be re-id'd by one and left in place by the other.
- **`promoteDraft` is now a pure move** for a stable-id draft: `drafts/` → `tasks/` rename, id and status ride along untouched, `updated_date` is the only frontmatter mutation. Zero padding is carried by slicing the numeric part off the existing id (`task.id.slice(lastIndexOf('-')+1)`), so `STORY-001` promotes to `story-001 - Title.md`, not `story-1`.
- **LEGACY path kept**: a draft failing `idHasPrefix` (an old `DRAFT-N` file, or one written by the upstream Backlog.md CLI) still re-ids to a fresh `TASK-M` via `getNextTaskId`, and a synthetic/blank `status: Draft` still resets to the board default. Only that branch consumes a fresh id.
- **`demoteTask` is now a pure move**: same id, same status, `tasks/` → `drafts/`. The `getNextTaskId(backlogPath, 'draft')` call that TASK-115 marked `LEGACY (TASK-115)` is **deleted**, as is the `DRAFT-N` id synthesis. Before this, demote re-id'd `TASK-11` → `DRAFT-9` and remapped *nothing*, so every inbound `dependencies: [TASK-11]` dangled the instant you demoted. That bug is gone (covered by a test that demotes a dependency target and asserts the dependent still resolves).
- Promotion no longer burns an id: a covering test asserts the next `createTask` after an in-place promote gets `TASK-2`, not `TASK-3`.

**`src/mcp/server.ts` + `src/mcp/handlers.ts`** — the `promote_draft` / `promote_drafts` / `demote_task` tool descriptions and handler JSDoc promised "a new TASK-N id" / "new DRAFT-N id". That is now false, and these are the agent-facing surface for the behavior I changed, so leaving them would have actively misled every agent between this merge and TASK-120. Rewritten to state: the id does NOT change, promote/demote are pure file moves, status is preserved, legacy DRAFT-N still re-ids. **TASK-120 (agent-facing docs) can treat these three MCP descriptions as already done** and focus on SKILL.md / CLAUDE.md / AGENTS.md.

## Key decisions

- **The `from !== to` filter in `promoteDrafts` is now a genuine no-op for new boards** — as the handoff predicted. I did NOT remove it (TASK-118 needs `remapIds` for the legacy migration), and I added a positive assertion to the bulk-promote test that pins the new reality: `basePromotedId === base.id` and `res.remapped === []`. Promotion of a stable draft rewires nothing because nothing moved.
- **Did NOT touch `restoreArchivedTask`'s `taskId.startsWith('DRAFT-')` branch** — that is TASK-117's job (archive/restore route by folder). It remains the last id-prefix branch in the codebase.
- CRLF/LF preservation: kept the existing `detectCRLF` / `normalizeToLF` / `restoreLineEndings` sandwich on **both** moves, and added an explicit round-trip test for each (write the file CRLF, move it, assert `\r\n` survives with no mixed endings).

## Tests

New real-fs suite **`src/test/unit/BacklogWriter.pureMove.test.ts`** (16 tests, no `fs` mock — the contract under test is where the file physically lands and what bytes survive, which a mocked `fs` cannot prove; mirrors the `BacklogWriter.idAllocation.test.ts` temp-board pattern): `idHasPrefix` (4), promote pure move / Done-preserved / no-id-burned / legacy re-id / legacy synthetic-Draft reset / custom-prefix + zero-padding / CRLF (7), demote pure move / no-DRAFT-written / inbound-dependency-survives / CRLF / create→demote→promote round-trip (5).

Two existing tests asserted the OLD contract and were repointed (strengthened, not weakened): `BacklogWriter.drafts.test.ts` demote (now asserts `TASK-5` kept + the exact rename target + no `DRAFT-` in the file) and `mcpWriteHandlers.test.ts` demote (now asserts id kept, status preserved, file present in `drafts/`, `tasks/` empty).

Verify gate: **2184 tests pass, lint clean, typecheck clean.**
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Promote and demote are now pure file moves — the payoff of the Stable Task IDs chain.

`promoteDraft` on a stable-id draft returns the SAME id: `drafts/` → `tasks/` is a rename, status and zero-padding ride along, and there is nothing to remap because nothing changed. `demoteTask` is the exact mirror, and the `getNextTaskId(backlogPath, 'draft')` re-id call that TASK-115 flagged as legacy is deleted — which incidentally kills a real bug, since demote used to re-id `TASK-11` → `DRAFT-9` while remapping nothing, dangling every inbound reference instantly.

The legacy `DRAFT-N` path survives, gated by one new exported predicate `idHasPrefix(id, taskPrefix)` that tests the board's configured prefix rather than the literal string `DRAFT-` (so a `STORY`-prefixed board classifies its own drafts as stable). TASK-118's migration must reuse that same predicate.

Also corrected the `promote_draft` / `promote_drafts` / `demote_task` MCP tool descriptions + handler JSDoc, which still promised agents "a new TASK-N id" / "new DRAFT-N id" — false as of this change, and the agent-facing surface for the exact behavior it alters.

16 new tests in a real-fs `BacklogWriter.pureMove.test.ts` (pure moves, Done-status preservation, legacy re-id, custom prefix + zero padding, CRLF round-trips on both moves, create→demote→promote id round-trip, and a demoted dependency target whose dependent still resolves). Two tests asserting the old DRAFT-N contract were repointed and strengthened. Gate: 2184 tests, lint, typecheck all pass.
<!-- SECTION:FINAL_SUMMARY:END -->
