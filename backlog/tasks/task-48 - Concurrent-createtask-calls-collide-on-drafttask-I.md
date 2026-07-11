---
id: TASK-48
title: >-
  Concurrent create_task calls collide on draft/task ID and silently clobber a
  file
type: bug
status: Done
assignee: []
created_date: '2026-07-04 04:39'
updated_date: '2026-07-04 09:36'
labels: []
dependencies: []
priority: medium
category: Bugs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DISCOVERED LIVE while AI-authoring the Board Sync v2 drafts (2026-07-04). Two create_task(draft:true) MCP calls issued in the same parallel batch EACH returned id DRAFT-17. The two files had different title slugs (…Board-ref-snapshotmaterialize… and …Retire-live-CAS…) but the same `draft-17` number; the second create silently removed/replaced the first, so a whole draft (the snapshot/materialize task) vanished until it was manually recreated as DRAFT-19. No error was surfaced.

Reproduction:
- Fire ≥2 create_task calls concurrently (parallel tool calls, or two MCP clients). Observe duplicate assigned IDs and a lost file. Sequential creation does NOT trigger it (the workaround used for the rest of the batch).

Likely root cause:
- ID/number allocation is not atomic across concurrent creates. The next-N is computed from a scan of tasks/drafts (possibly via the mtime-cached BacklogParser), so interleaved calls read a stale max and pick the same N.
- The writer then overwrites/replaces a file that shares the computed `draft-N`/`TASK-N` prefix even when the title differs, instead of refusing or reallocating.
- Affects the shared core used by BOTH the MCP createTaskHandler and the TasksController create path (src/core/createTaskCore.ts createTaskWithTreeFields / createDraft; BacklogWriter next-id).

Fix directions (pick per investigation):
- Serialize allocate+write behind a per-board lock/mutex, OR allocate-then-write with O_EXCL and retry on collision, OR allocate-verify-unique-retry.
- Invalidate/settle the parser cache between the max-scan and the write.
- Never replace an existing task/draft file whose id differs from the one being written.

Acceptance:
- A regression test fires N concurrent create_task calls and asserts N distinct IDs and N files (no clobber).
- Duplicate-ID allocation is impossible (or self-heals with a retry) under concurrency.
- No create silently deletes/overwrites a pre-existing task or draft.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
