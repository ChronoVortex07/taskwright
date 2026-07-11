---
id: TASK-81
title: Verify request_merge worktree-target live (1.2.0 fix)
status: Done
assignee: []
created_date: '2026-07-08 08:15'
updated_date: '2026-07-08 08:38'
labels: []
dependencies: []
priority: low
category: Misc
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Live end-to-end verification that request_merge { worktree } closes a task from a primary-rooted session after the 1.2.0 gitFacts relative-git-dir fix. Uses an empty commit so it exercises validation → rebase → verify gate → merge queue → ff-merge → Done → worktree removal without changing any files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Live verification of request_merge{worktree} from a primary-rooted session after the 1.2.0+1.2.1 Windows fixes. Result: the pre-fix abort ("not a linked worktree") is GONE — the call now passes worktree-target validation and runs the full close pipeline (validate → rebase → verify gate → merge queue → ff-merge guard). It stopped only at ffMergeToBase's legitimate primary-cleanliness guard (a pre-existing untracked non-backlog file, .husky/post-checkout, left untouched), which is working as designed. Fix confirmed end-to-end. Demo worktree/empty-commit discarded (not merged).
<!-- SECTION:FINAL_SUMMARY:END -->
