---
id: TASK-132
title: >-
  Make the verify doctor proactive at setup so wrong default verify commands
  don't ship silently
status: In Progress
assignee: []
created_date: '2026-07-14 05:26'
updated_date: '2026-07-14 09:23'
labels:
  - friction
  - merge-queue
  - ux
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
priority: low
category: Worktrees & Merge
claimed_by: '@agent/.worktrees/task-132-make-the-verify-doctor-proactive-at-setup-so-wrong-default-verify-commands-don-t-ship-silently'
worktree: .worktrees/task-132-make-the-verify-doctor-proactive-at-setup-so-wrong-default-verify-commands-don-t-ship-silently
claimed_at: '2026-07-14 17:16'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The verify doctor (TASK-86) classifies the repo and flags provably unrunnable verify commands, but it is purely advisory: a cross-repo scan at the time found 0/5 repos had ever overridden taskwright.mergeVerifyCommands, meaning bun-flavored defaults silently ship on non-bun repos and only surface as confusing verify_failed aborts at merge time (friction report 2026-07-14, item 8).

Fix direction: run the doctor at board initialization / first request_merge in a repo and, when the configured commands are provably unrunnable for the detected repo type, prompt the human once with the doctor's suggested command set (one-click apply, never a silent rewrite — preserving TASK-86's "never rewrites silently" rule). Consider a board_doctor finding when mergeVerifyCommands is unset on a repo whose type the doctor can classify.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 On first merge (or board init) in a repo whose configured verify commands are provably unrunnable, the human gets a one-time prompt with the doctor's suggested commands and a one-click apply
- [ ] #2 No silent rewrite: declining the prompt is remembered and respected
- [ ] #3 board_doctor reports a typed finding when verify commands are unset/mismatched for a classifiable repo
- [ ] #4 Unit tests cover prompt-once, apply, and decline-remembered paths
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. verifyDoctor.ts (pure core): add evidence-based RUNNER MISMATCH detection alongside the existing "provably broken" one — a script-runner command whose script exists but whose runner differs from the repo's LOCKFILE-PROVEN package manager (bun defaults in a pnpm/npm/yarn repo). Add `packageManagerProven` to RepoProfile so an unproven (lockfile-less) pm never cries wolf. Report gains `mismatched` + `ok` becomes "nothing needs attention". Add `verifyDoctorSignature(report)` — a stable fingerprint of (repo profile + configured commands + suggestions) that keys the prompt-once memory.
2. verifyDoctorState.ts (new): durable decision record at <commonDir>/taskwright/verify-doctor.json ({ signature, decision: applied|declined|deferred, decidedAt }). Pure predicates `shouldPromptVerifyDoctor` (any recorded decision for the same signature suppresses the prompt) and `isVerifyDoctorDismissed` (only an explicit decline suppresses the standing board_doctor finding; an X/ESC "deferred" stops the nag but keeps the finding).
3. boardDoctor.ts: new typed finding `verify-commands-mismatch` / repair `apply-verify-commands` (check 12), fed by an optional `verify` input; `gatherVerifyFacts(repoRoot, commonDir)` assembles it from merge-config.json + the doctor and honors the dismissal. `runBoardDoctor` takes an optional commonDir.
4. extension.ts: runVerifyDoctorCheck consults the state — prompts ONCE per signature (Apply / Open Settings / Not now), records the decision, never rewrites silently. The explicit setup path (quietWhenOk:false) forces the prompt, which is the escape hatch back from a decline.
5. doctorActions.ts + mcp/handlers.ts: route the new repair (update the setting + republish merge-config.json) and pass commonDir so board_doctor emits the finding.
6. Tests: verifyDoctor (mismatch/proven-pm/signature), verifyDoctorState (prompt-once, apply, decline-remembered), boardDoctor (check 12 fires / stays quiet on unknown repos + dismissal).
<!-- SECTION:PLAN:END -->
