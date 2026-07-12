---
id: TASK-111
title: Stop Playwright silently reusing another worktree's Vite server (wrong dist/)
status: In Progress
assignee: []
created_date: '2026-07-12 16:35'
updated_date: '2026-07-12 22:10'
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
- [x] #1 A Playwright run cannot silently consume a Vite server started from a different worktree — it either uses a tree-unique port, or fails loudly with an actionable message naming the mismatch.
- [x] #2 The failure mode is proven, not assumed: a test//manual check demonstrates that starting a server from worktree A and running the suite in worktree B now errors instead of passing against the wrong dist/.
- [x] #3 `e2e/global-setup.ts`'s existing missing-bundle guard still fires (do not regress it).
- [x] #4 Running the suite normally (no stale server) is unaffected; `bun run test:playwright` still passes.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Fixed with BOTH options from the description (belt and braces), because either alone leaves a hole.

**1. Tree-unique port — removes the collision instead of detecting it.**
New pure core `scripts/lib/fixtureServer.ts` (sits beside `scripts/lib/platform.ts`, the established home for unit-tested script helpers). `fixtureServerPort(rootDir)`:
- **Primary checkout → 5173, unchanged.** Detected by `isLinkedWorktree()`: in a linked worktree `.git` is a FILE (`gitdir: …`), in the primary it is a directory. One stat, no subprocess. Keeping 5173 for the primary is deliberate — the documented agent-browser / visual-proof workflow and every doc that says `localhost:5173` stays correct in the main checkout.
- **Linked worktree → `5174 + FNV-1a(normalized path) % 800`.** Deterministic, stable across processes/platforms. This worktree resolved to **5673**.
- `TASKWRIGHT_FIXTURE_PORT` overrides both (escape hatch; also how the proof below forces a collision).
Both `vite.config.ts` and `playwright.config.ts` call it with their own `__dirname`, so a tree's server and its suite always agree and nothing has to be threaded through. Bonus: two worktrees can now run `test:playwright` concurrently, which the fixed port never allowed — this matters on a repo where several agent worktrees are live at once.

**2. Identity endpoint — the backstop.**
A port can still be occupied by a hash collision, a stale server, or an unrelated process, and `reuseExistingServer` would consume it. So every fixture server now stamps itself: `fixtureRootMiddleware` (mounted by a small `taskwright-fixture-root` vite plugin) answers `GET /__taskwright_fixture_root` with `{ root: <abs path of the tree it serves> }`. `e2e/global-setup.ts` probes that endpoint and aborts unless the server is THIS tree.
Semantics, chosen to be ordering-independent: nothing listening ⇒ no-op (Playwright starts ours); answers with our root ⇒ pass; answers with a different root ⇒ abort naming BOTH trees + the port; answers without the endpoint ⇒ abort "not a Taskwright fixture server". Path compare is separator/trailing-slash-agnostic and case-insensitive on win32/darwin only (`sameTreeRoot`).

**Ordering fact worth keeping:** Playwright runs `webServer` (a plugin setup task) BEFORE `globalSetup` — verified in `node_modules/playwright/lib/runner/index.js` `createGlobalSetupTasks()`, which is `[removeOutputDirs, ...pluginSetupTasks, ...globalSetups]`. So by the time globalSetup probes, the server it is about to test against (fresh or reused) is the one answering. The guard is written so it would still be correct if that ever flipped.

**AC#3 (don't regress the missing-bundle guard):** kept, but moved out of `global-setup.ts` into `missingRequiredBundles()` / `missingBundlesMessage()` in the same lib, so it is now unit-tested rather than untestable inline. `global-setup.ts` composes the two guards (bundles first, then server identity) and is now `async`.

**Proof (AC#2), done end-to-end through the real Playwright globalSetup, not asserted:** started a fixture server stamped with the PRIMARY tree's root, pinned both sides to port 5199 via `TASKWRIGHT_FIXTURE_PORT` to force the old fixed-port collision, then ran this worktree's suite. It exited 1 with the message naming `…/.worktrees/task-111-…` as "this tree" and `…/GitHub/taskwright` as what port 5199 serves. Pre-change, that exact run would have passed silently against the primary's `dist/webview/`. Also re-verified the bundle guard fires by moving `dist/webview/styles.css` aside.

**Docs:** `AGENTS.md` and `.claude/skills/visual-proof/SKILL.md` hardcoded `localhost:5173`; both now state the port is per-checkout (5173 primary, derived in a worktree — use the URL vite prints) and why.

Verification: `bun run test` 2150/2150 · `bun run test:playwright` 447/447 · `bun run lint` · `bun run typecheck` — all clean. New: `src/test/unit/fixtureServer.test.ts` (22 tests, incl. real `http.createServer` servers proving mismatch/foreign/absent/match).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
A Playwright run can no longer silently test another worktree's build.

The fixture-server port is now derived from the checkout (`scripts/lib/fixtureServer.ts`): the primary keeps the documented **5173**, every linked `.worktrees/<branch>` gets a stable hash-derived port (this one: 5673). `vite.config.ts` and `playwright.config.ts` each derive it from their own `__dirname`, so a tree's server and its suite always agree — the fixed-port collision that let `reuseExistingServer` consume another tree's `dist/webview/` simply cannot occur, and two worktrees can now run the suite concurrently.

As a backstop for anything else that lands on the port (hash collision, stale server, unrelated process), every fixture server stamps its identity at `GET /__taskwright_fixture_root`, and `e2e/global-setup.ts` aborts unless that root is THIS tree — naming both trees and the port. Proven end-to-end, not assumed: forcing the old collision via `TASKWRIGHT_FIXTURE_PORT=5199` against a server stamped with the primary's root made the suite exit 1 with exactly that message, where pre-change it would have passed against the wrong `dist/`.

The pre-existing half-built-`dist/` guard is preserved and, having moved into the same lib, is now unit-tested too. Docs that hardcoded 5173 (AGENTS.md, visual-proof SKILL.md) explain the per-checkout port.

2150/2150 unit (22 new) · 447/447 Playwright · lint · typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
