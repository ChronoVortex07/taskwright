---
id: TASK-132
title: >-
  Make the verify doctor proactive at setup so wrong default verify commands
  don't ship silently
status: Done
assignee: []
created_date: '2026-07-14 05:26'
updated_date: '2026-07-14 09:44'
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
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The verify doctor (TASK-86) classifies the repo and flags provably unrunnable verify commands, but it is purely advisory: a cross-repo scan at the time found 0/5 repos had ever overridden taskwright.mergeVerifyCommands, meaning bun-flavored defaults silently ship on non-bun repos and only surface as confusing verify_failed aborts at merge time (friction report 2026-07-14, item 8).

Fix direction: run the doctor at board initialization / first request_merge in a repo and, when the configured commands are provably unrunnable for the detected repo type, prompt the human once with the doctor's suggested command set (one-click apply, never a silent rewrite — preserving TASK-86's "never rewrites silently" rule). Consider a board_doctor finding when mergeVerifyCommands is unset on a repo whose type the doctor can classify.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 On first merge (or board init) in a repo whose configured verify commands are provably unrunnable, the human gets a one-time prompt with the doctor's suggested commands and a one-click apply
- [x] #2 No silent rewrite: declining the prompt is remembered and respected
- [x] #3 board_doctor reports a typed finding when verify commands are unset/mismatched for a classifiable repo
- [x] #4 Unit tests cover prompt-once, apply, and decline-remembered paths
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The gap was narrower than "the doctor is only advisory". The doctor was ALSO blind to the exact case that ships: the bun defaults in a pnpm/npm/yarn repo that happens to have test/lint/typecheck scripts are not *provably* unrunnable (the scripts exist), so the evidence-only check passed them and nobody was ever asked anything. Fixing only the prompting would have left that case silent.

So there are two halves:

1. New evidence class — RUNNER MISMATCH (verifyDoctor.ts). A script-runner command whose script exists but whose runner differs from the package manager the repo's LOCKFILE proves it uses. Kept strictly separate from `ok: false` (provably cannot run) so the notification never overstates its evidence. Added `packageManagerProven` to RepoProfile: the pre-existing "no lockfile ⇒ npm" default is a guess, and a mismatch is never built on a guess — the doctor still must not cry wolf. Verified against Taskwright itself (bun.lock + bun defaults): silent, healthy.

2. Prompt-once memory (verifyDoctorState.ts) — a durable decision record at <commonDir>/taskwright/verify-doctor.json keyed by `verifyDoctorSignature(report)` = (repo kind + proven pm + configured commands + suggested commands). Proactive had to also mean well-mannered: any recorded decision closes the question for that situation, but a *new* situation (commands changed, or the repo changed so the advice changed) mints a new signature and earns one more prompt. A decision is about one situation, never a blanket mute.

Decline semantics, deliberately three-valued: `declined` (explicit "Keep mine" / "Open Settings" — respected everywhere, including the standing board_doctor finding), `deferred` (toast dismissed with the X — stops the nag but KEEPS the board_doctor finding, so a stray click cannot silently lose the diagnosis), `applied`. The setup command forces the prompt past any memory, which is the escape hatch back from a decline.

AC1's "first merge" is served by board init + board_doctor, not by request_merge: the merge gate runs out-of-process in the MCP server and has no VS Code UI, so it structurally cannot prompt a human. The agent-facing equivalent is the board_doctor finding (its tool description now tells an agent that a verify-commands-mismatch means request_merge will fail verification no matter how good the work is).

board_doctor check 12 is only raised with EVIDENCE and with ADVICE — an unclassifiable repo yields no suggestions and is therefore never accused. The new `apply-verify-commands` repair writes both stores the gate reads (the VS Code setting and the shared merge-config.json the out-of-process gate loads), so the fix is live immediately rather than at next activation.

Note the `DoctorRepair` union is exhaustively switched in doctorActions.ts — adding the new kind made tsc fail until both the label and the repair were implemented, which is exactly the guardrail you want.</implementationNotes>
</invoke>

<!-- SECTION:NOTES:END -->
