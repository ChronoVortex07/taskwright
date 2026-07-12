---
id: TASK-110
title: Release 1.7.0 — document the m-11 performance wave
status: In Progress
assignee: []
created_date: '2026-07-12 06:55'
updated_date: '2026-07-12 06:56'
labels:
  - docs
  - release
milestone: Performance & Startup Cost
dependencies:
  - TASK-107
  - TASK-108
  - TASK-109
priority: medium
category: 'Docs & Branding'
claimed_by: '@agent/task-110-release-1-7-0-document-the-m-11-performance-wave'
worktree: task-110-release-1-7-0-document-the-m-11-performance-wave
claimed_at: '2026-07-12 14:56'
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
- [ ] #1 `package.json` version is 1.7.0.
- [ ] #2 CHANGELOG.md has a `## [1.7.0]` section dated 2026-07-12, following the existing Keep-a-Changelog style, covering all three tasks under the right headings (Fixed for the two rendering bugs, Fixed + Changed for the startup work), naming the measured numbers (117 → 2 mutated elements per hover; 40ms cold / 2ms warm board parse) and the deliberate activation narrowing.
- [ ] #3 Every doc claim that the extension activates on `backlog/tasks/*.md` is corrected (CLAUDE.md, AGENTS.md, README.md if applicable).
- [ ] #4 CLAUDE.md gains an m-11 entry in the Taskwright-additions list describing the three fixes and their pure cores (`EdgeLayer` base/overlay split, gesture-scoped `will-change`, `src/core/deferredBootstrap.ts`).
- [ ] #5 The honest limits are recorded, not glossed: the zoom-blur fix is verified at the property level (a screenshot forces a re-raster and so cannot show stale-raster blur), and the startup improvement is not yet re-measured end-to-end in an installed build.
- [ ] #6 `bun run test`, `bun run lint`, `bun run typecheck` pass.
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
