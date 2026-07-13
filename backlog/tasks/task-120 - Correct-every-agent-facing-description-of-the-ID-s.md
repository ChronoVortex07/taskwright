---
id: TASK-120
title: Correct every agent-facing description of the ID space
status: In Progress
assignee: []
created_date: '2026-07-12 16:43'
updated_date: '2026-07-13 00:01'
labels:
  - stable-task-ids
  - docs
milestone: Stable Task IDs
dependencies:
  - TASK-116
references:
  - docs/superpowers/plans/2026-07-12-stable-task-ids.md
  - src/mcp/server.ts
  - CLAUDE.md
  - AGENTS.md
priority: medium
category: Docs & Branding
claimed_by: '@agent/task-120-correct-every-agent-facing-description-of-the-id-space'
worktree: task-120-correct-every-agent-facing-description-of-the-id-space
claimed_at: '2026-07-13 07:48'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Task 8 of the Stable Task IDs plan** — `docs/superpowers/plans/2026-07-12-stable-task-ids.md`.

The MCP tool descriptions currently promise `DRAFT-N`. **Agents read these.** Leaving them stale means agents keep writing draft-flavored references into specs and handoffs — the exact failure this whole feature exists to prevent.

- `src/mcp/server.ts:302` — the `draft` param description becomes: a draft is a provisional task in `drafts/` that a human reviews and promotes; it carries a **normal task ID (TASK-N) from birth**; drafts and tasks share one ID space; promoting **never changes the ID**, so it is safe to reference a draft by ID in specs, handoffs, and dependencies.
- `:404-405, :415, :419, :430` — the `promote_draft` / `promote_drafts` / `demote_task` descriptions. Replace the `["DRAFT-1","DRAFT-2"]` example with `["TASK-111","TASK-112"]` and state that promotion moves a task out of `drafts/` **without changing its ID**.
- `.claude/skills/create-task/SKILL.md` and `.claude/skills/index-codebase/SKILL.md` — both wire dependencies between drafts by ID. They get *simpler*: state that the ID `create_task` returns for a draft is **final**.
- `CLAUDE.md` — add a "Stable task IDs (one ID space)" bullet to the Taskwright-additions list (the plan carries the exact text).
- `AGENTS.md` — one line under the task-workflow section: a draft's ID is final, reference it freely.

The motivating evidence is fossilized in this repo's own board: `TASK-77`'s description still says *"Wire the new worktree-bootstrap tool (DRAFT-3) and the request_merge worktree-target override (DRAFT-4)"* — and DRAFT-3/DRAFT-4 no longer exist.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 No MCP tool description promises `DRAFT-N` any more; the `draft` param, `promote_draft`, `promote_drafts`, and `demote_task` all describe the one ID space and state that promotion never changes the ID.
- [x] #2 `.claude/skills/create-task/SKILL.md` and `.claude/skills/index-codebase/SKILL.md` state that a draft's returned ID is FINAL and safe to reference.
- [x] #3 CLAUDE.md carries a "Stable task IDs (one ID space)" bullet recording the folder-is-the-marker rule, the shared lock namespace, folder-routed archive/restore, and the auto-migration.
- [x] #4 AGENTS.md states a draft's ID is final.
- [x] #5 A grep for `DRAFT-` across src/, .claude/skills/, CLAUDE.md, and AGENTS.md surfaces only deliberate legacy/migration references — no surviving promise that drafts are minted as DRAFT-N.
- [x] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Swept every agent-facing surface and added a build-time guard so the old ID story cannot come back.

**New contract test — `src/test/unit/idSpaceContract.test.ts` (17 tests).** Modeled on the TASK-122 `worktreeEntryContract` pattern. It reads the agent-facing surfaces as text (`src/mcp/server.ts`, all four shipped SKILL.md files, CLAUDE.md, AGENTS.md, README.md, `TASKWRIGHT_AGENTS_CONVENTION`, both dispatch templates) and fails the build if any LINE contains a `DRAFT-<n|N|{N}>` token unless that same line is explicitly about the legacy/migration path (`/legacy|migrat/i`). The regex is case-SENSITIVE on `DRAFT-` so JSON-Schema's `draft-07` and lowercase legacy fixture filenames are not false positives. It also asserts the positive contract: the `draft` flag's describe says TASK-N / NEVER changes the id / FINAL; both authoring skills say the returned ID is **final**; CLAUDE.md carries the "Stable task IDs (one ID space)" bullet; AGENTS.md says "A draft's ID is final" and describes promote/demote as ID-preserving.

**Surfaces corrected.**
- `src/mcp/server.ts` — the `create_task` `draft:` flag was the known-stale one ("Create as a draft (DRAFT-N in drafts/)"); it now says a draft is a provisional task in `drafts/` carrying a NORMAL task id (TASK-N) from birth, one shared id space, promotion NEVER changes the id, so the returned id is FINAL and safe to reference. Verified TASK-116 (`promote_draft`/`promote_drafts`/`demote_task`) and TASK-117 (`archive_task`/`restore_task`) descriptions were already correct — not redone.
- `.claude/skills/create-task/SKILL.md` — new bullet in step 4 (the ID a draft comes back with is **final**; safe to write straight into another task's `dependencies`/`causedBy`, a spec, or a plan); step 6 no longer claims "Promote all proposed … rewires the dependency edges" (nothing to rewire — IDs are stable); new rule of thumb.
- `.claude/skills/index-codebase/SKILL.md` — same, in the prerequisites-first write step + a rule of thumb.
- `AGENTS.md` — step 4 of the task workflow now states **A draft's ID is final** (one ID space; `drafts/` folder, never the ID, is the draftness marker; promotion is a pure move). Fixed three stale Backlog.md-reference sections that were outright lies: the folder-structure tree (`drafts/DRAFT-1 …` → `TASK-2 …`), the file-naming table (Draft row now the configurable task prefix, with a note on the one shared ID space and the upstream divergence), and Key Operations (**Draft vs Task** is folder-not-status, Promote/Demote are ID-preserving pure moves, Archive routes by source folder and IDs are NOT reused).
- `CLAUDE.md` — new "Stable task IDs (one ID space)" bullet (folder-is-the-marker, pure moves, global next-ID scan, one shared `backlog/.locks/` namespace and why a per-dir lock re-arms the TASK-48 clobber, folder-routed archive/restore, the auto-migration + `legacy-draft-ids` doctor finding, and the idSpaceContract guard).
- `src/mcp/handlers.ts` — `createTaskHandler` JSDoc states the returned draft id is final.
- `src/core/promoteDrafts.ts` — module header still described the OLD behavior as the normal case ("promoteDraft re-ids DRAFT-N → TASK-N"); rewritten so the pure move is the norm and the remap is explicitly the legacy-only path (`from !== to`).

**Dangling-ID fossils removed** (the exact failure mode this feature exists to prevent — the task description cites TASK-77's "DRAFT-3/DRAFT-4" as the motivating evidence): CLAUDE.md cited DRAFT-3/4/5/7 (dead draft IDs) for `start_task` / `request_merge {worktree}` / `next_ready_tasks` / execute-task-from-any-session — now named by tool/plan instead; `src/mcp/handlers.ts:353` cited "(DRAFT-4)" — now cites the plan path; `src/core/BacklogWriter.ts` cited "DRAFT-25" three times for the concurrent-create race, which the same file elsewhere calls the TASK-48 clobber — unified on TASK-48.

**Note for TASK-121 (acceptance test).** The guard test only checks that surfaces *say* the right thing; TASK-121 still owns proving the *behavior* end-to-end. If TASK-121 adds `src/test/unit/stableTaskIds.integration.test.ts`, add it to the coverage list in the CLAUDE.md "Stable task IDs" bullet (deliberately left out — I do not document a file that does not exist yet). Anything new TASK-121 writes into an agent-facing surface must clear `idSpaceContract` — a `DRAFT-N` may only appear on a line that also says legacy/migration.

Verification: `bun run test` 2250 passed (154 files), `bun run lint`, `bun run typecheck` all clean. AGENTS.md was run through prettier (it is the only changed file prettier touched); one unrelated pre-existing emphasis reflow (`*different*`) was reverted to keep the diff focused.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Every agent-facing description of the ID space now tells the truth: a draft is minted with a real, final TASK-N id in `drafts/`, the folder (never the id, never the status) is the draftness marker, and promote/demote are pure moves that preserve the id. Corrected the `create_task` `draft` flag description, both authoring skills, AGENTS.md (workflow step 4 + the three stale Backlog.md reference sections: folder tree, naming table, Key Operations) and CLAUDE.md (new "Stable task IDs (one ID space)" bullet), plus the `promoteDrafts` module header and the `createTaskHandler` JSDoc. Removed the dangling DRAFT-3/4/5/7/25 ID citations that were themselves instances of the bug this feature fixes. Added `src/test/unit/idSpaceContract.test.ts` (17 tests) — a build-time guard that fails if a DRAFT-N promise reappears in any agent-facing surface outside an explicit legacy/migration note, and that asserts the positive contract in each surface. test/lint/typecheck all green (2250 tests).
<!-- SECTION:FINAL_SUMMARY:END -->
