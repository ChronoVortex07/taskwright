---
id: TASK-59
title: Fix broken/unstyled attachment chips rendering in Task Detail panel
type: bug
status: Done
assignee: []
created_date: '2026-07-04 11:34'
updated_date: '2026-07-04 12:21'
labels:
  - ui
  - task-detail
dependencies: []
priority: medium
category: Tree
caused_by: TASK-19
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The plan/spec/notes attachment section on the Task Detail panel looks broken — as if it "did not render in properly" rather than showing tidy chips.

`AttachmentChips.svelte` is the component responsible (used exactly once, in `TaskDetail.svelte:402-438`); it renders plan/spec/notes attachments as expandable chips. Audit its markup/CSS for the actual rendering defect (e.g. missing/incorrect class, broken conditional, layout overflow, unstyled expanded state) and fix it so the chips render as intended.

While in this file, also note an asymmetry worth checking as a related contributing bug: `MetaSection` is force-remounted on task switch via `{#key task.id}` (`TaskDetail.svelte:344-369`), but `AttachmentChips` is not — it only resets its own `expanded` state via an internal `$effect` keyed on `taskId` (`AttachmentChips.svelte:40-46`). If any other internal state doesn't get reset by that effect, it would silently persist across task switches. Confirm whether this contributes to the reported visual breakage or is a separate latent issue, and fix if so.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Plan/spec/notes attachments in the Task Detail panel render as clean, correctly styled chips matching the surrounding UI, not broken/unstyled markup.
- [ ] #2 Expanding/collapsing a chip shows its content correctly (no overflow, missing styles, or layout breakage).
- [ ] #3 Switching between tasks that have different attachment sets shows the correct attachments each time, with no stale state left over from the previous task.
<!-- AC:END -->
