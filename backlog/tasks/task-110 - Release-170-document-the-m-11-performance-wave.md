---
id: TASK-110
title: Release 1.7.0 — document the m-11 performance wave
status: Done
assignee: []
created_date: '2026-07-12 06:55'
updated_date: '2026-07-12 07:03'
labels:
  - docs
  - release
milestone: Performance & Startup Cost
dependencies:
  - TASK-107
  - TASK-108
  - TASK-109
priority: medium
category: Docs & Branding
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-107, TASK-108 and TASK-109 are merged but unreleased: `package.json` still says 1.6.1, the CHANGELOG has no entry, and the docs still describe the old activation behavior.

Version: **1.7.0**, not a patch. Two of the three are pure fixes, but TASK-109 carries a deliberate, user-visible behavior change — a backlog root nested below the workspace root no longer *eager*-activates (it activates when the board view opens), and the git/sync housekeeping now runs ~2s after activation rather than inline. That belongs in a minor.

Docs that are now stale and must be reconciled:
- `CLAUDE.md` / `AGENTS.md` — "The extension activates when it detects `backlog/tasks/*.md` files" is no longer true (activation is now plain-path `workspaceContains:` stats on `backlog/config.yml` etc, plus the lazy board-view trigger).
- `CLAUDE.md` "Taskwright additions" — needs an m-11 entry covering the bounded-hover edge layer, the gesture-scoped compositor hint, and the deferred startup bootstrap, in the same style as the existing entries.
- `README.md` — check for any activation/requirements claim that assumed the glob.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `package.json` version is 1.7.0 (single-line diff — nothing else in the manifest changed).
- [x] #2 CHANGELOG.md has a `## [1.7.0]` — 2026-07-12 section in the existing Keep-a-Changelog style: Fixed (hover repaint storm, zoom blur, eager-activation gating) + Changed (glob-free activation events, deferred doctors), with the measured numbers (117 → 2 mutated elements per hover; 40ms cold / 2ms warm board parse; 2.1s activation) and the deliberate narrowing called out.
- [x] #3 The stale activation claim is corrected: AGENTS.md now describes plain-path `workspaceContains:` stats + the lazy board-view trigger, and README.md no longer calls the board doctor "activation-time". (The CLAUDE.md `backlog/tasks/*.md` mention is about READING task data, not activation, and is still true — left alone. The `docs/superpowers/` hits are historical plans/specs, deliberately not rewritten.)
- [x] #4 CLAUDE.md gains an m-11 entry in the Taskwright-additions list covering all three fixes and their cores (EdgeLayer base/overlay split, gesture-scoped `will-change`, `src/core/deferredBootstrap.ts`).
- [x] #5 The honest limits are recorded in BOTH the changelog and CLAUDE.md, as explicit callouts rather than buried: a screenshot cannot show stale-raster blur (capture forces a re-raster), so the zoom fix is property-verified; and the startup improvement is not yet re-measured end-to-end in an installed build.
- [x] #6 `bun run test` (2065 passed), `bun run lint`, `bun run typecheck`, and `prettier --check` on the touched files all pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## File Structure

- `package.json` — version → 1.7.0.
- `CHANGELOG.md` — new `## [1.7.0]` section at the top.
- `CLAUDE.md` — m-11 additions entry; fix the activation claim.
- `AGENTS.md` — fix the activation claim.
- `README.md` — audit for stale activation/requirements copy.

## Steps

1. Bump the version.
2. Write the changelog entry from the three merged tasks' final summaries.
3. Grep the repo for `backlog/tasks/*.md` activation claims and correct them.
4. Add the m-11 entry to CLAUDE.md.
5. Run the verify trio.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Released **1.7.0** — the performance release covering TASK-107 (hover repaint storm), TASK-108 (zoom
blur) and TASK-109 (startup cost).

Minor, not patch: two of the three are pure fixes, but TASK-109 carries a deliberate user-visible
behavior change — a backlog root nested below the workspace root no longer *eager*-activates (it
activates when the board view opens), and the git/sync housekeeping now runs ~2s after activation
rather than inline.

- `package.json` → 1.7.0 (clean single-line diff).
- `CHANGELOG.md` → `## [1.7.0]` with Fixed / Changed sections carrying the measured evidence
  (117 → 2 mutated elements per hover; 98-task board parses in 40ms cold / 2ms warm, so the board was
  never the startup cost; Taskwright activating 2.1s in and gating `Eager extensions activated`).
- `AGENTS.md` → the "activates when it detects `backlog/tasks/*.md`" claim was simply false after
  TASK-109; replaced with the real rule (plain-path `workspaceContains:` stats, no globs, plus the
  lazy board-view trigger) and the reason globs are banned.
- `README.md` → the board doctor is no longer "activation-time"; it runs just after activation, off
  the critical path.
- `CLAUDE.md` → m-11 entry in the additions list, in house style, with the pure cores named.

Both **honest limits are stated in the shipped docs**, not just in the task notes: a screenshot cannot
demonstrate the zoom fix (capturing one forces the compositor to re-rasterize, so before/after images
are identical either way — it is verified at the property level), and the startup win has not been
re-measured end-to-end because that needs the build installed and the window reloaded.

Verified: 2065 unit tests, lint, typecheck, and `prettier --check` on every touched file.
<!-- SECTION:FINAL_SUMMARY:END -->
