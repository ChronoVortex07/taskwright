---
id: TASK-112
title: Normalize stale-nonce replay in the tree canvas host→canvas command props
status: In Progress
assignee: []
created_date: '2026-07-12 16:36'
updated_date: '2026-07-12 16:36'
labels:
  - tech-debt
  - webview
milestone: Backburner
dependencies: []
references:
  - src/webview/components/tree/TechTreeCanvas.svelte
  - src/webview/components/tasks/Tasks.svelte
  - e2e/tree-find.spec.ts
priority: medium
category: Tree
claimed_by: '@agent/task-112-normalize-stale-nonce-replay-in-the-tree-canvas-host-canvas-command-props'
worktree: task-112-normalize-stale-nonce-replay-in-the-tree-canvas-host-canvas-command-props
claimed_at: '2026-07-13 06:12'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`TechTreeCanvas.svelte` receives host→canvas commands as monotonic **nonce props** from `Tasks.svelte`, each guarded by a plain `let last*Nonce` compared for inequality inside an `$effect`.

The hazard: the nonce props live in `Tasks.svelte` and **survive for the whole webview session**, while `TechTreeCanvas` is rendered inside `{:else if activeTab === 'tree'}` and is therefore **destroyed and recreated on every tab switch**. A guard initialized to `0` therefore sees a stale, non-zero nonce on remount, and **replays the last command** with no user input.

This already bit us once, on the find bar (fixed in 1.8.0, commit `fb63630`): press `/` → Escape → switch tab → switch back, and the find bar **spontaneously reopened and stole keyboard focus**, on every Tree-tab re-entry for the rest of the session. The fix was to seed the guard from the prop's mount-time value via `untrack()` rather than `0`, with a comment warning that "normalizing" it back to `0` reintroduces the bug.

The remaining nonces carry the identical pattern and are still initialized to `0`: `lastJumpNonce`, `lastJumpTaskNonce`, `lastMinimapPanNonce`. They are **benign today** — they replay an invisible viewport recenter — which is exactly why they are worth fixing before someone adds a fourth nonce that does something visible, or repoints an existing one at a focus-grabbing action.

Preferred approach: extract the pattern once (a small helper / shared idiom) so a new host→canvas command cannot be added with the wrong initializer, rather than hand-patching three `let`s. Consider whether the guard belongs in the canvas at all, or whether the host should not resend a command the canvas has already consumed.

**Hard constraint:** `TechTreeCanvas.svelte` holds a load-bearing invariant — `findResults` may depend ONLY on the primitive dim sources (`navFilterDimmedIds`, `hiddenIds`), NEVER on the composed `dimmedIds`/`fadedIds`. Svelte 5 deriveds are lazy synchronous getters with no fixed-point iteration, so a cycle throws `derived_references_self` in dev and **stack-overflows in production**. Re-derive the graph and confirm it is still acyclic before closing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No host→canvas nonce command replays on a Tree-tab remount: a tab round-trip after a jump, a minimap pan, or a find does not re-fire the command.
- [ ] #2 The pattern is normalized once (a shared helper or idiom), not hand-patched per nonce, so a newly added command prop cannot reintroduce the wrong initializer.
- [ ] #3 A real bump after a remount STILL fires — the fix must not disable the commands (prove it with a test that round-trips the tab and then issues a genuine command).
- [ ] #4 Regression coverage exists for at least one previously-unguarded nonce (jump or minimap pan), not only the find bar.
- [ ] #5 The $derived graph in TechTreeCanvas.svelte is re-derived and confirmed acyclic; findResults still reads only navFilterDimmedIds + hiddenIds.
- [ ] #6 bun run test, lint, typecheck, and the Playwright tree suites (tree-find, tree-canvas, tree-authoring, tree-drag, tree-navigator) all pass.
<!-- AC:END -->
