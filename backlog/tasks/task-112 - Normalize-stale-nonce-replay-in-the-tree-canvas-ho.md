---
id: TASK-112
title: Normalize stale-nonce replay in the tree canvas host→canvas command props
status: In Progress
assignee: []
created_date: '2026-07-12 16:36'
updated_date: '2026-07-12 22:45'
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
- [x] #1 No host→canvas nonce command replays on a Tree-tab remount: a tab round-trip after a jump, a minimap pan, or a find does not re-fire the command.
- [x] #2 The pattern is normalized once (a shared helper or idiom), not hand-patched per nonce, so a newly added command prop cannot reintroduce the wrong initializer.
- [x] #3 A real bump after a remount STILL fires — the fix must not disable the commands (prove it with a test that round-trips the tab and then issues a genuine command).
- [x] #4 Regression coverage exists for at least one previously-unguarded nonce (jump or minimap pan), not only the find bar.
- [x] #5 The $derived graph in TechTreeCanvas.svelte is re-derived and confirmed acyclic; findResults still reads only navFilterDimmedIds + hiddenIds.
- [x] #6 bun run test, lint, typecheck, and the Playwright tree suites (tree-find, tree-canvas, tree-authoring, tree-drag, tree-navigator) all pass.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed

**New shared idiom — `src/webview/lib/commandNonce.svelte.ts`**
`onCommandNonce(readNonce, run)` seeds its guard from the prop's MOUNT-TIME value via `untrack()` and exposes **no initializer parameter**, so the wrong-initializer bug is *unrepresentable* for any future command prop. All four nonces in `TechTreeCanvas.svelte` (`jumpNonce`, `jumpTaskNonce`, `minimapPanNonce`, `findRequestNonce`) now route through it; the four hand-rolled `let last*Nonce` guards and the `untrack` import are gone from the canvas. This generalizes the 1.8.0 find-bar fix (fb63630) rather than regressing it — the mount-time seeding it introduced now lives in one place and covers all four.

## Key finding: the jump/minimap replays were MASKED, not merely "benign"

The task called them "benign (an invisible viewport recenter)". The actual mechanism, discovered while trying to write a failing e2e: `TechTreeCanvas` declares its `restored` effect (`vp = persisted treeViewport`, line ~388) **after** the command effects, and Svelte runs effects in creation order — so on a remount the replayed command flushes first and the restore **overwrites `vp` in the same flush**, clobbering the recenter before it can paint.

Consequence for testing: **a viewport-level e2e assertion cannot fail for these three nonces.** I verified this the hard way — my first e2e spec passed *identically* with the `= 0` bug reintroduced and rebuilt, i.e. it was vacuous. Anyone adding a "proves the replay" viewport assertion here will write a test that can never fail. This is documented in the `e2e/tree-command-nonce.spec.ts` header. The find nonce was the visible one precisely because it does not touch `vp`.

## Coverage (AC#4 lives here)

- **`src/test/unit/commandNonce.test.ts`** — the real proof.
  - *Behavioural* rune tests of the idiom (nonce-agnostic ⇒ they cover all four commands at once): no replay across one or many remounts, a genuine bump after a remount still fires, per-mount guard independence. **RED-verified**: with the seed flipped back to `0`, these fail with `expected [1] to deeply equal []`.
  - *Contract* tests: every `*Nonce` prop the canvas declares is routed through `onCommandNonce`; no `let last*Nonce` guard survives (comments stripped first, so it scans code not prose); the helper still seeds via `untrack` and takes no seed argument. **This is what fails the build if a fifth command prop is added the old way.**
  - *Acyclicity re-derivation* (AC#5): asserts `findCandidates`/`findResults` reference neither `dimmedIds` nor `fadedIds`, and still read `navFilterDimmedIds` + `hiddenIds`. Nothing I added is a `$derived` (only effects reading props), so no new edge exists; build emits no `derived_references_self`.
- **`e2e/tree-command-nonce.spec.ts`** — 4 tests: commands still fire after a remount (AC#3, *not* masked, since `restored` runs once per mount), and a tab round-trip leaves the viewport where the user left it. Fixture is deliberately WIDE/SHORT (8 bands, 2 lanes) because `clampViewport` pins tx on a narrow board and would make even these vacuous; each test has a sanity assertion guarding that.

## Infrastructure: unit-testing runes (`vitest.config.ts`)

To test `$effect` behaviour at all I had to make Vitest compile `.svelte.ts` rune modules. Three blockers, each a trap for a later session:
1. Vitest transforms in **SSR mode**, and vite-plugin-svelte keys the compiler's `generate` off that flag ⇒ it emits `generate: 'server'`, where **`$effect.root`'s body never runs and `$state` is inert**. Rune tests would then observe nothing and **pass vacuously** (I hit exactly this).
2. `compilerOptions.generate` cannot force it: vite-plugin-svelte lists it in `ignoredCompilerOptions` and strips it.
3. Vitest 4 **removed `testTransformMode`**, so web mode can't be requested per-file; the only supported route is a DOM `environment` (a new jsdom/happy-dom dependency + a DOM global for every unit test).

Resolution: a ~10-line local plugin that transforms `.svelte.ts` with esbuild (TS strip) then `compileModule(..., { generate: 'client' })`. Also required: `resolve.conditions`/`ssr.resolve.conditions` = `['browser']` (svelte's exports map `default` → the server build) **and** `server.deps.inline: [/^svelte($|\/)/]` — the regex must cover **subpaths**, or `svelte/internal/client` stays externalized and the compiled effects register in a *different copy* of the runtime than the one `flushSync` drains (effects silently never run). Full unit suite (2160 tests / 150 files) unaffected.

## Scope hygiene

`bun run format` reflowed ~13 unrelated files (Prettier printWidth churn in `AGENTS.md`, `src/mcp/server.ts`, docs, other specs). All reverted — the commit touches only the 6 files of this task. Don't run repo-wide `format` in a shared-worktree flow.

## Verification

`bun run test` 2160/2160 · `bun run test:playwright` 451/451 (incl. the existing `tree-find` remount regression) · `bun run lint` · `bun run typecheck` · `bun run build` — all clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Extracted the host→canvas command-nonce guard into one shared idiom, `onCommandNonce(readNonce, run)` (`src/webview/lib/commandNonce.svelte.ts`), which seeds from the prop's mount-time value via `untrack()` and takes no initializer — making the stale-nonce replay bug unrepresentable rather than hand-patching the three remaining nonces. All four command props in `TechTreeCanvas.svelte` (`jumpNonce`, `jumpTaskNonce`, `minimapPanNonce`, `findRequestNonce`) now route through it, generalizing the 1.8.0 find-bar fix (fb63630) instead of regressing it.

Proof is in `src/test/unit/commandNonce.test.ts`: behavioural rune tests of the idiom (nonce-agnostic, so they cover all four commands), RED-verified against the buggy `= 0` seed; a contract test that every declared nonce prop is routed through the idiom and no `let last*Nonce` guard survives — which is what fails the build if a fifth command prop is added the old way; and a re-derivation of the `$derived` acyclicity invariant (`findResults` still reads only `navFilterDimmedIds` + `hiddenIds`). `e2e/tree-command-nonce.spec.ts` adds 4 tests covering "commands still fire after a remount" and viewport stability across a tab round-trip.

Two findings worth carrying forward. (1) The jump/minimap replays were masked, not just benign: the canvas's `restored` effect is declared *after* the command effects and overwrites `vp` in the same flush, so a viewport-level e2e assertion for those three nonces **cannot fail** — my first attempt passed identically with the bug reintroduced. Documented in the spec header so nobody rewrites that vacuous test. (2) Unit-testing runes required compiling `.svelte.ts` with an explicit `generate: 'client'` (vite-plugin-svelte keys `generate` off Vitest's SSR mode and strips `compilerOptions.generate`; Vitest 4 removed `testTransformMode`) plus inlining svelte's *subpaths* — otherwise the rune tests pass vacuously against a no-op server runtime.

All gates green: 2160 unit tests, 451 Playwright (incl. the existing tree-find remount regression), lint, typecheck, build.
<!-- SECTION:FINAL_SUMMARY:END -->
