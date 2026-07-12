---
id: TASK-111
title: Stop Playwright silently reusing another worktree's Vite server (wrong dist/)
status: In Progress
assignee: []
created_date: '2026-07-12 16:35'
updated_date: '2026-07-12 16:35'
labels:
  - testing
  - dx
milestone: Backburner
dependencies: []
references:
  - playwright.config.ts
  - e2e/global-setup.ts
priority: medium
category: Polish
claimed_by: '@agent/task-111-stop-playwright-silently-reusing-another-worktree-s-vite-server-wrong-dist'
worktree: task-111-stop-playwright-silently-reusing-another-worktree-s-vite-server-wrong-dist
claimed_at: '2026-07-13 05:55'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`playwright.config.ts` sets `webServer.reuseExistingServer: !process.env.CI` on a fixed port (5173). If a Vite fixture server is already running from a *different* worktree, Playwright silently reuses it — and that server serves *that* tree's `dist/webview/`. The suite then tests a build that is not the one under test, with no warning.

This is the same defect class as the half-built-`dist/` trap fixed on the tree-find-bar branch (1.8.0): a missing `dist/webview/styles.css` 404s silently in Chromium, collapses the fixture page's entire height chain, and makes three unrelated `tree-canvas` tests fail exactly like a code regression. That one cost roughly an hour of misdiagnosis before it was traced, and it is now guarded by `e2e/global-setup.ts` (which asserts the required bundles EXIST).

The reuse-the-wrong-server path is not guarded, and will eventually cost someone the same hour. Deliberately left unchanged on the find-bar branch to keep that PR scoped.

Options (pick during implementation): derive the port per worktree (e.g. hash the repo root) so trees cannot collide; or have `globalSetup` verify the server on 5173 is actually serving THIS tree's `dist/` (e.g. fetch a build-stamped asset and compare) and fail loudly if not; or set `reuseExistingServer: false` and accept the startup cost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A Playwright run cannot silently consume a Vite server started from a different worktree — it either uses a tree-unique port, or fails loudly with an actionable message naming the mismatch.
- [ ] #2 The failure mode is proven, not assumed: a test//manual check demonstrates that starting a server from worktree A and running the suite in worktree B now errors instead of passing against the wrong dist/.
- [ ] #3 `e2e/global-setup.ts`'s existing missing-bundle guard still fires (do not regress it).
- [ ] #4 Running the suite normally (no stale server) is unaffected; `bun run test:playwright` still passes.
<!-- AC:END -->
