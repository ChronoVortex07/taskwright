---
id: TASK-128
title: Fix the CRLF-corrupting pre-commit hook so --no-verify folklore can be retired
type: bug
status: To Do
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 08:21'
labels:
  - friction
  - windows
  - tooling
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - .husky/
  - .gitattributes
priority: high
category: Bugs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On Windows, the lint-staged pre-commit hook rewrites line endings across the tree (CRLF→LF flips), corrupting unrelated files. The standing workaround is folklore: "commit with --no-verify" lives in HANDOFF.md, agent memory notes, and tribal knowledge — every new agent must know the ritual or corrupt the tree, and skipping the hook also skips the lint it was supposed to run. This has never been fixed at the hook level (friction report 2026-07-14, item 4; memory notes precommit-hook-autocrlf-corruption and root-tree-healing-lf-config).

Fix direction: make the hook line-ending-safe — align .gitattributes (`* text=auto` policy), prettier/eslint end-of-line config, and lint-staged so the hook only touches staged files and never rewrites endings the repo policy doesn't mandate. Then delete the --no-verify guidance from HANDOFF.md and anywhere else it appears, so hooks run again.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A commit on Windows with the hook enabled leaves unstaged/untouched files byte-identical (no tree-wide CRLF/LF flips); proven with a repo-fixture test or documented manual verification
- [ ] #2 lint-staged operates only on staged files; formatter end-of-line settings agree with .gitattributes
- [ ] #3 All --no-verify guidance is removed from HANDOFF.md and other agent-facing docs
- [ ] #4 A normal `git commit` (hook active) succeeds cleanly on Windows in the primary checkout
<!-- AC:END -->
