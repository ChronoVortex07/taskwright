---
id: TASK-76
title: >-
  Ship the Taskwright skills in the VSIX so the skill installer works in
  published builds
type: bug
status: Done
assignee: []
created_date: '2026-07-08 05:25'
updated_date: '2026-07-08 06:18'
labels: []
milestone: Orchestration & UX Polish
dependencies: []
priority: high
category: Core Board
caused_by: TASK-61
plan: docs/superpowers/plans/2026-07-08-package-skills-in-vsix.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The skill-instantiation feature (setupClaudeIntegration → installTaskwrightSkills, from TASK-61) reads skills from `<extensionPath>/.claude/skills` (extension.ts:1821), but `.vscodeignore:31` excludes `.claude/**` from the VSIX and scripts/build.ts never copies the skills into a bundled location. So in a PUBLISHED install the source dir is absent and installTaskwrightSkills silently no-ops (the `continue` on a missing source dir at skillInstaller.ts:74-79). The feature therefore only works from a dev checkout — which is why the user "requested it but doesn't see it working".

Fix packaging so create-task, execute-task, index-codebase actually ship and install from a packaged extension: un-ignore `.claude/skills/**` in .vscodeignore (or copy `.claude/skills` into `dist/` via scripts/build.ts and update the source path at extension.ts:1821).

Acceptance criteria:
- A packaged .vsix contains the three skill dirs; installTaskwrightSkills copies them into a target repo's `.claude/skills/`.
- Installer no longer silently no-ops on a packaged install; idempotent skip-if-exists preserved.
- skillInstaller.test.ts extended to cover the packaged-source path.
- visual-proof and agent-browser remain excluded (internal UI-testing only).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented by DeepSeek (Flash) per plan. Fixed the packaging: scripts/build.ts bundleSkills() copies .claude/skills/<name> → dist/skills/ for each TASKWRIGHT_SKILL_NAMES entry (reusing installTaskwrightSkills, so visual-proof/agent-browser never bundle); extension.ts installs from dist/skills (ships in the .vsix); skillInstaller.ts now surfaces a missing-source via onMissingSource handler instead of silent no-op. +4 tests. Verified: 1611 vitest, lint/typecheck clean, build emits dist/skills/{create-task,execute-task,index-codebase}, vsce ls confirms 3 skills packaged, no dev-only leak. Merged to integration branch.
<!-- SECTION:FINAL_SUMMARY:END -->
