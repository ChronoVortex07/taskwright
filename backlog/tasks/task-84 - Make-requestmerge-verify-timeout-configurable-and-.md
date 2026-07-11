---
id: TASK-84
title: >-
  Make request_merge verify timeout configurable and return machine-readable
  abort codes
status: Done
assignee: []
created_date: '2026-07-10 11:42'
updated_date: '2026-07-10 12:30'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: high
category: Worktrees & Merge
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The verify runner hardcodes a 600_000ms timeout (defaultShellRun, src/mcp/handlers.ts:186) and a killed command surfaces as a generic "Verification failed" — indistinguishable from a red test. Transcript forensics show repos with long suites (stock-trading backend: ~25 min pytest) can NEVER merge: agents sharded suites, hand-edited config, and gave up. 16 of 77 request_merge calls aborted on verify.

Scope:
- Add verifyTimeoutMs to MergeConfig (src/core/mergeConfig.ts) + a taskwright.mergeVerifyTimeoutMinutes setting, replacing the hardcoded cap; keep 10 min as the default.
- Add an optional verifyTimeoutMinutes parameter to the request_merge MCP tool so an orchestrator/subagent that measured its suite can raise it per call, bounded by an optional repo-level max setting.
- Distinguish outcomes: a timeout must return reason "verify timed out after Ns on `cmd` (raise taskwright.mergeVerifyTimeoutMinutes or pass verifyTimeoutMinutes)" — never "Verification failed".
- Add a machine-readable `code` field to RequestMergeResult aborts: verify_timeout | verify_failed | dirty_worktree | dirty_primary | rebase_conflict — so /orchestrate-board can branch on it instead of parsing prose.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 MergeConfig has verifyTimeoutMs (default 600000ms) replacing the hardcoded defaultShellRun cap; taskwright.mergeVerifyTimeoutMinutes setting publishes it
- [x] #2 request_merge MCP tool accepts optional verifyTimeoutMinutes per call, clamped to taskwright.mergeVerifyTimeoutMaxMinutes when set
- [x] #3 A killed verify command returns reason 'verify timed out after Ns on `cmd` (raise taskwright.mergeVerifyTimeoutMinutes or pass verifyTimeoutMinutes)', never 'Verification failed'
- [x] #4 RequestMergeResult aborts carry machine-readable code: verify_timeout | verify_failed | dirty_worktree | dirty_primary | rebase_conflict
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented TDD-first across four layers:

- src/core/mergeConfig.ts: DEFAULT_VERIFY_TIMEOUT_MS (600_000), MergeConfig.verifyTimeoutMs (required, coerced to default on invalid) + optional verifyTimeoutMaxMs (positive-or-unset). resolveMergeConfigFromSettings accepts both raw ms fields; JSON round-trips via readMergeConfig.
- src/core/finishTask.ts: RunFn gains optional timeoutMs param and timedOut result flag; runVerifyCommands forwards the timeout and surfaces timedOut. New MergeAbortCode union; RequestMergeResult aborted variant gains code. Codes wired: dirty_worktree (pre-enqueue clean check), rebase_conflict (pre + post-wait rebase), verify_failed/verify_timeout (pre + post-wait verify), dirty_primary (ffMergeToBase hasCodeWip branch via FfMergeResult.code). Timeout reason is the actionable message from the spec (verifyTimeoutReason helper), never "Verification failed".
- src/mcp/handlers.ts: defaultShellRun takes timeoutMs (default DEFAULT_VERIFY_TIMEOUT_MS) and reports timedOut when node killed the child (killed && no numeric exit code). requestMergeHandler accepts verifyTimeoutMinutes, converts to ms, clamps to config.verifyTimeoutMaxMs when set, and injects the effective verifyTimeoutMs into the config passed to requestMerge. server.ts registers the new optional param.
- src/extension.ts + package.json: new settings taskwright.mergeVerifyTimeoutMinutes (default 10, min 1) and taskwright.mergeVerifyTimeoutMaxMinutes (default 0 = no cap); syncMergeConfig converts minutes to ms (non-positive -> unset) and the onDidChangeConfiguration listener republishes on change.

Surprise: none structural; finishTaskIntegration.test.ts needed the new required verifyTimeoutMs field in its inline config literal. Full suite: 1685 tests, 1 unrelated flaky timeout (mcpBoardPushPullHandlers real-git clone on cold start; passes in isolation). Lint + typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
request_merge's verify gate is now tunable and machine-readable. MergeConfig gained verifyTimeoutMs (default 10 min, replacing the hardcoded defaultShellRun cap) and optional verifyTimeoutMaxMs, published from new settings taskwright.mergeVerifyTimeoutMinutes / mergeVerifyTimeoutMaxMinutes. The request_merge MCP tool accepts a per-call verifyTimeoutMinutes (clamped to the repo max). A timed-out verify command aborts with "verify timed out after Ns on `cmd` (raise taskwright.mergeVerifyTimeoutMinutes or pass verifyTimeoutMinutes)" instead of a generic failure, and every mapped abort now carries a code (verify_timeout | verify_failed | dirty_worktree | dirty_primary | rebase_conflict) so /orchestrate-board can branch without parsing prose. TDD throughout; full unit suite green (one unrelated flaky real-git cold-start timeout, passes in isolation), lint + typecheck clean. Commit b0580e8.
<!-- SECTION:FINAL_SUMMARY:END -->
