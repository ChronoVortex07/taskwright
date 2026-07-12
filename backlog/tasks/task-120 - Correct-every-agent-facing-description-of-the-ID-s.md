---
id: TASK-120
title: Correct every agent-facing description of the ID space
status: To Do
assignee: []
created_date: '2026-07-12 16:43'
updated_date: '2026-07-12 16:43'
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
category: 'Docs & Branding'
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
- [ ] #1 No MCP tool description promises `DRAFT-N` any more; the `draft` param, `promote_draft`, `promote_drafts`, and `demote_task` all describe the one ID space and state that promotion never changes the ID.
- [ ] #2 `.claude/skills/create-task/SKILL.md` and `.claude/skills/index-codebase/SKILL.md` state that a draft's returned ID is FINAL and safe to reference.
- [ ] #3 CLAUDE.md carries a "Stable task IDs (one ID space)" bullet recording the folder-is-the-marker rule, the shared lock namespace, folder-routed archive/restore, and the auto-migration.
- [ ] #4 AGENTS.md states a draft's ID is final.
- [ ] #5 A grep for `DRAFT-` across src/, .claude/skills/, CLAUDE.md, and AGENTS.md surfaces only deliberate legacy//migration references — no surviving promise that drafts are minted as DRAFT-N.
- [ ] #6 bun run test, bun run lint, bun run typecheck all pass.
<!-- AC:END -->
