---
id: TASK-124
title: >-
  Tree canvas renders nothing when a task uses the reserved Backburner milestone
  (duplicate band key)
type: bug
status: In Progress
assignee: []
created_date: '2026-07-12 17:28'
updated_date: '2026-07-12 17:28'
labels:
  - bug
  - tree
dependencies: []
priority: high
category: Tree
claimed_by: '@agent/task-124-tree-canvas-renders-nothing-when-a-task-uses-the-reserved-backburner-milestone-duplicate-band-key'
worktree: task-124-tree-canvas-renders-nothing-when-a-task-uses-the-reserved-backburner-milestone-duplicate-band-key
claimed_at: '2026-07-13 01:28'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Tree tab renders an empty canvas in the taskwright repo itself (works in other repos), so the board appears unable to switch to Tree view.

Root cause (reproduced 2026-07-13 with Playwright against the real 115-task board): `deriveTreeLayout` (src/core/treeLayout.ts:50-72) builds `bandOrder` through a de-duplicating `pushBand()` — declared milestones, then discovered ones — and then appends the reserved band with a RAW `bandOrder.push(BACKBURNER_BAND)` that bypasses the dedupe. If any task carries `milestone: Backburner` explicitly (this board has several), "Backburner" is already present as a discovered band, so it is pushed a second time.

The webview keys the band `{#each}` by band name, so a duplicate name is a duplicate key: Svelte 5 throws `each_key_duplicate` (https://svelte.dev/e/each_key_duplicate) and the whole TechTreeCanvas subtree fails to render. Observed: the Tree tab activates and #tree-view mounts, but 0 tree nodes render and the page throws exactly one error. No other repo has a Backburner milestone on a task, which is why it only reproduces here.

Secondary hazard from the same line: `backburnerIdx` is computed as `bandOrder.length - 1`, which assumes Backburner is LAST. Simply routing the final push through `pushBand()` would NOT be enough — a discovered "Backburner" sorts into the middle of the discovered bands and would leave `backburnerIdx` pointing at an unrelated band. Backburner is a reserved band and must be excluded from the declared/discovered sets, then appended exactly once at the end.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 deriveTreeLayout emits Backburner exactly once in bandOrder, and always LAST, even when tasks or the config declare a milestone named Backburner (any casing).
- [ ] #2 A task whose milestone is Backburner is laid out in the Backburner band (not a phantom duplicate band), and backburnerIdx still points at the real Backburner band.
- [ ] #3 Unit test in src/test/unit/treeLayout.test.ts fails on the duplicate (it is a pure-core regression, not a webview one).
- [ ] #4 Verified in the real UI: injecting this repo's actual board payload into the tasks fixture and clicking the Tree tab renders >0 tree nodes with 0 page errors (before the fix: 0 nodes, each_key_duplicate).
- [ ] #5 bun run test && bun run lint && bun run typecheck all pass.
<!-- AC:END -->
