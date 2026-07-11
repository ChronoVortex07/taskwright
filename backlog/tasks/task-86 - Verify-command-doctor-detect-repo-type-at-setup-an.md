---
id: TASK-86
title: >-
  Verify-command doctor — detect repo type at setup and flag verify commands
  that cannot run
status: Done
assignee: []
created_date: '2026-07-10 11:42'
updated_date: '2026-07-10 13:24'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-85
priority: medium
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
No consuming repo overrides the bun-flavored default verify commands, so Python repos ship `bun run test` (which on Windows resolved to MSYS test.exe) and claude-harness failed on `bun run lint: Script not found` — failures discovered mid-merge, weeks after board setup. Cross-repo scan: 0 of 5 repos set taskwright.mergeVerifyCommands.

Scope:
- A pure core (e.g. src/core/verifyDoctor.ts) that inspects the repo — package.json scripts, pytest.ini/pyproject/uv.lock, etc. — and validates the configured verify commands (does the referenced script/tool exist?), returning suggestions (e.g. `uv run pytest -q` for a uv repo).
- Run it from setUpClaudeIntegration and on activation when the merge gate is misconfigured; surface a notification with a one-click "apply suggested commands" that persists durably (requires the clobber fix).
- Never auto-rewrite silently; suggestions are confirmed by the human.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the verify-command doctor as a pure core `src/core/verifyDoctor.ts` (TDD, 27 new tests in `src/test/unit/verifyDoctor.test.ts`):

- `detectRepoProfile(root, fs)` — classifies the repo (node/python/rust/go/unknown) from marker files; node repos get packageManager (bun/pnpm/yarn/npm from lockfiles) + package.json script names; python repos get usesUv (uv.lock or [tool.uv]). Node wins in mixed repos (script commands are the provable ones).
- `diagnoseVerifyCommands(commands, profile)` — strictly evidence-based: flags only `bun|npm|pnpm|yarn run <script>` (and `npm test`) when there is no package.json or the script is missing. `bun test` (built-in runner), `npx`, `uv run pytest`, `cargo test` etc. are never flagged — the doctor never cries wolf.
- `suggestVerifyCommands(profile)` — node: `<pm> run <script>` for whichever of test/lint/typecheck exist; python: `uv run pytest -q` (uv) / `pytest -q`; rust: `cargo test`; go: `go test ./...`.
- `runVerifyDoctor` + `verifyDoctorNotification` (message builder, undefined when healthy).

Extension glue (`src/extension.ts`): `runVerifyDoctorCheck(repoRoot, { quietWhenOk })` reads the effective commands from the shared merge-config.json (readMergeConfig), runs the doctor against the repo root, and on findings shows a warning with "Apply suggested commands" (writes taskwright.mergeVerifyCommands at Workspace target, then re-runs syncMergeConfig — durable thanks to the TASK-85 clobber fix) and "Open Settings". Never rewrites silently. Wired at (a) activation, chained after syncMergeConfig's publish (quietWhenOk: true — only misconfigured gates notify) and (b) the end of setUpClaudeIntegration (quietWhenOk: false — explicit setup confirms a healthy gate out loud).

Full suite green: 1754 tests / 126 files, lint, typecheck.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped the verify-command doctor. Pure core `src/core/verifyDoctor.ts` detects the repo type (node w/ package manager + scripts, python w/ uv detection, rust, go) and validates configured merge-verify commands strictly on evidence — script-runner commands (`bun|npm|pnpm|yarn run X`, `npm test`) are flagged when package.json or the script is missing; nothing else is ever flagged. It suggests runnable replacements (`<pm> run test|lint|typecheck` from existing scripts; `uv run pytest -q` / `pytest -q`; `cargo test`; `go test ./...`). Extension glue `runVerifyDoctorCheck` reads the effective commands from the shared merge-config.json and surfaces a warning with one-click "Apply suggested commands" (persists via workspace setting + republished merge config, durable per TASK-85) — never silent. Runs at activation (notify only when misconfigured) and from setUpClaudeIntegration (confirms healthy gates too). 27 new unit tests; full suite 1754 green + lint + typecheck.
<!-- SECTION:FINAL_SUMMARY:END -->
