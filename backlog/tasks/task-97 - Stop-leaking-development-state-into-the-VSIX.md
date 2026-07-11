---
id: TASK-97
title: Stop leaking development state into the VSIX
type: bug
status: Done
assignee: []
created_date: '2026-07-11 02:33'
updated_date: '2026-07-11 07:35'
labels: []
dependencies: []
priority: high
category: Misc
claimed_by: '@agent/task-97-stop-leaking-development-state-into-the-vsix'
worktree: task-97-stop-leaking-development-state-into-the-vsix
claimed_at: '2026-07-11 15:28'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fix the release-blocking packaging and build hygiene defects found in the audit. The published VSIX currently includes local coordination/worktree state and repeated webview builds retain obsolete hashed chunks, causing unnecessary size growth and potentially exposing local data.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The VSIX excludes .taskwright, .worktrees, .superpowers, AGENTS.md, and other repository-only agent/development state
- [x] #2 Two consecutive production builds do not retain obsolete hashed webview chunks
- [x] #3 Automated regression tests validate package exclusions and clean webview output behavior
- [x] #4 The packaged extension still contains every runtime MCP, skill, webview, license, and documentation asset it needs
- [x] #5 The final VSIX contents and size are inspected and recorded in implementation notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing regression tests for sensitive development-state exclusions and clean webview output.
2. Correct .vscodeignore and the build order/cleanup behavior without dropping runtime assets.
3. Build twice and assert obsolete hashed chunks do not accumulate.
4. Package the VSIX, inspect its full file list and size, then run the required test/lint/typecheck gates.
5. Merge through Taskwright.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added releasePackaging regressions for state/tooling exclusions, runtime MCP assets, clean Vite output, and build order. .vscodeignore now excludes Taskwright board/worktree state, superpowers/agent instructions, and repository-only audit/release/build configuration. Vite now empties dist/webview before compiling; the production build runs Vite first and regenerates Tailwind styles.css afterward. Verified two builds by inserting an obsolete hashed-chunk sentinel between them: the second build removed it and retained styles.css. The audited package dropped from 538 files / 5.34 MB to 95 files / 1.56 MB. Final contents are .mcp.json, extension/MCP/hooks/webview bundles, four skills, launcher, images, package metadata, README/changelog, license, and ThirdPartyNotices; no local coordination or development state remains.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hardened VSIX packaging and made webview builds clean/reproducible. The final 95-file, 1.56 MB VSIX retains all runtime assets, and 1,948 tests, lint, typecheck, repeated builds, stale-artifact verification, and package inspection pass.
<!-- SECTION:FINAL_SUMMARY:END -->
