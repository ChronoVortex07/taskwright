---
id: TASK-135
title: Harden the verify-slot lock protocol (4 findings from the TASK-134 audit)
type: bug
status: To Do
assignee: []
created_date: '2026-07-15 01:19'
updated_date: '2026-07-15 01:19'
labels: []
milestone: Workflow Friction Hardening
dependencies: []
references:
  - docs/audits/2026-07-15-workflow-friction-hardening-audit.md
priority: high
category: Worktrees & Merge
caused_by: TASK-126
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Independent audit TASK-134 (reviewer: codex-terra / GPT-5.6) found four defects in `src/core/verifySlot.ts`'s `FileVerifySlot.acquire` lock protocol. All are on the merge critical path and each can reintroduce the exact overlap the verify slot exists to prevent, so fix them together. Grounding-confirmed against the code by the orchestrating session — real, not a misread. Each fix needs a regression test that reproduces GENUINE overlap (nest the second acquire inside the first's held window; a sequential test passes for the test's reason, not the code's).

1. [P1] Non-atomic publish (verifySlot.ts:177-179). `createExclusive` makes the lock pathname visible before its JSON is necessarily flushed; a concurrent waiter can read the transient empty/partial file as null (parse throws → readHolder null), treat it as stale, unlink it, create its own lock, and start verifying while the original holder also proceeds. Fix: publish atomically (write temp then rename), so the lock is only ever visible fully-formed.

2. [P1] Unguarded stale-steal (verifySlot.ts:184-190). The `remove(this.filePath)` after inspecting a stale/torn holder is unconditional. Two waiters that both read the same stale record race: A removes it and wins the O_EXCL create; B then removes A's fresh lock and creates its own → both verify concurrently, and A's ownership-checked release no-ops because B overwrote the record. Fix: compare-and-delete — only remove if the current file still equals the record we inspected.

3. [P1] Unpersisted lease (verifySlot.ts:215-220). `isStale` uses the WAITER's `opts.leaseMs`, but the holder record `{owner,pid,acquiredAt}` stores no lease. A default-timeout waiter (~22 min) steals a holder legitimately running with `verifyTimeoutMinutes: 60`. Fix: persist the holder's lease in the record and judge staleness against THAT.

4. [P2] Non-contention create errors swallowed (verifySlot.ts:177-182). The `catch {}` treats every `createExclusive` failure as EEXIST. If `.git/taskwright` is unwritable / disk full / FD limit, readHolder returns null and remove() no-ops, so acquire spins forever and wedges every merge in verification. Fix: distinguish EEXIST from other errno and surface a real, actionable failure.

Reference: docs/audits/2026-07-15-workflow-friction-hardening-audit.md</description>
<parameter name="acceptanceCriteria">[{"text": "Lock publish is atomic (temp+rename or equivalent): a concurrent reader can never observe a partially-written lock and mis-steal it, proven by a regression test that reproduces the overlap window."}, {"text": "Stale/torn-lock deletion is conditional on the current file still matching the inspected record (compare-and-delete); two concurrent stale-stealers cannot both end up verifying."}, {"text": "The holder's lease is persisted in the lock record and staleness is judged against the holder's lease, not the waiter's, so mixed verifyTimeoutMinutes callers never steal a live holder."}, {"text": "createExclusive distinguishes EEXIST (contention) from other errors and surfaces an actionable failure instead of spinning forever."}, {"text": "Each fix has a regression test reproducing genuine overlap/failure (not a sequential stand-in)."}]
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->
