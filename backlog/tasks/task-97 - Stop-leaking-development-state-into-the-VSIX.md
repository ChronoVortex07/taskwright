---
id: TASK-97
title: Stop leaking development state into the VSIX
type: bug
status: To Do
assignee: []
created_date: '2026-07-11 02:33'
updated_date: '2026-07-11 02:34'
labels: []
dependencies: []
priority: high
category: Misc
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Fix the release-blocking packaging and build hygiene defects found in the audit. The published VSIX currently includes local coordination/worktree state and repeated webview builds retain obsolete hashed chunks, causing unnecessary size growth and potentially exposing local data.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The VSIX excludes .taskwright, .worktrees, .superpowers, AGENTS.md, and other repository-only agent/development state
- [ ] #2 Two consecutive production builds do not retain obsolete hashed webview chunks
- [ ] #3 Automated regression tests validate package exclusions and clean webview output behavior
- [ ] #4 The packaged extension still contains every runtime MCP, skill, webview, license, and documentation asset it needs
- [ ] #5 The final VSIX contents and size are inspected and recorded in implementation notes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add failing regression tests for sensitive development-state exclusions and clean webview output.
2. Correct .vscodeignore and the build order/cleanup behavior without dropping runtime assets.
3. Build twice and assert obsolete hashed chunks do not accumulate.
4. Package the VSIX, inspect its full file list and size, then run the required test/lint/typecheck gates.
5. Merge through Taskwright.
<!-- SECTION:PLAN:END -->
