---
id: TASK-101
title: Make development and release automation cross-platform
status: Done
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 09:47'
labels: []
dependencies: []
priority: medium
category: Misc
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove the Windows-hostile assumptions in package scripts and helper tooling, add Windows CI coverage alongside the existing platform, and ensure build, license, screenshot, Playwright, CDP, e2e, packaging, and release entry points either run portably or fail with explicit supported-platform guidance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Core build, test, lint, typecheck, license, package, and release scripts have cross-platform entry points
- [x] #2 Bash-only e2e and screenshot helpers are ported or wrapped with explicit platform detection and actionable errors
- [x] #3 CI runs the supported verification matrix on Windows and Linux
- [x] #4 Developer documentation lists any unavoidable platform prerequisites
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Ported the five bash wrappers (generate-licenses.sh, check-licenses.sh, run-e2e.sh, run-cdp-tests.sh, screenshots/run.sh) to TypeScript run via `bun` — no `bash` dependency remains in any package.json script. Shared, unit-tested platform branching in scripts/lib/platform.ts (shouldUseXvfb/withXvfb) fixes the old `uname != Darwin` bug that wrongly funnelled Git-Bash/Windows into xvfb. scripts/lib/run.ts is a spawnSync helper with actionable ENOENT errors. Display-driven suites auto-wrap in xvfb-run on headless Linux only; native display on Windows/macOS. CI (.github/workflows/ci.yml) now matrixes the portable core (install/engines/lint/typecheck/depcheck/audit/test/build/licenses:check) over ubuntu-24.04 + windows-latest; xvfb/apt/VS-Code-download suites stay Linux-only via `if: runner.os == 'Linux'`. licenses:check live-verified on Windows (byte-identical output to committed, LF-normalized). Corrected stale "~22 POSIX tests fail on Windows" note in CONTRIBUTING.md + docs/building-and-publishing.md; added a Platform support / prerequisites section. Verified: typecheck, 2033 unit tests (incl. 9 new), lint, depcheck, check:engines all green; ci.yml valid YAML.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made development and release automation cross-platform. All five bash script wrappers ported to bun-run TypeScript (scripts/lib/{platform,run}.ts + generate-licenses.ts, check-licenses.ts, run-e2e.ts, run-cdp-tests.ts, screenshots/run.ts); no package.json script shells out to bash anymore. xvfb is used only on headless Linux (platform bug fixed), with actionable errors when a required command is missing. CI matrixes the portable verification core over Windows + Linux. Developer docs list the unavoidable platform prerequisites and the stale Windows test note was corrected. New unit tests (9) cover the platform branching; full gate green (2033 tests, lint, typecheck).
<!-- SECTION:FINAL_SUMMARY:END -->
