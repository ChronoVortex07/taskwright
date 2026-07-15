# Independent audit — Workflow Friction Hardening wave (`c76f7a2..3f97a3d`)

**Task:** TASK-134 **Date:** 2026-07-15
**Reviewer:** codex-terra (GPT-5.6, ChatGPT subscription) — an independent, **non-Claude** pair of eyes,
dispatched read-only via `ch worker --profile codex-terra --review-base c76f7a2 --review-commit 3f97a3d`.
**Range:** `c76f7a2..3f97a3d` (the seven-commit wave, pinned deliberately — not "recent commits").

## Why this audit, and why not the intended reviewer

Every gate in this wave (2400+ tests, lint, typecheck, some mutation-checked) was written by the same
agent that wrote the code, so this is the independent second read. The originally-intended reviewer,
`codex-sol`, was **refused** (not failed): Codex's Windows sandbox helper is missing, and a review
through it reads **blind** — every file read silently fails while success is still reported — which is
worse than no audit. The task therefore accepts **any genuinely independent, non-Claude reviewer**.
`codex-terra` runs through the same Codex CLI, so its output was scrutinised for real read-evidence
before being trusted (see below).

## DoD — the reviewer actually read the source

Confirmed. `codex-terra` reported reading `verifySlot.ts`, `finishTask.ts`, `mergeQueue.ts`,
`handlers.ts`, `sessionTasks.ts`, `server.ts`, `TasksController.ts`, and `types.ts`, and every finding
cites specific line ranges with code-aware reasoning about real constructs (e.g. the `{ flag: 'wx' }`
publish, the `deps.root`-keyed ledger, the `arg.includes('/')` branch). The orchestrating session then
**grounding-checked** each cited region against the actual code — all six findings reference real code,
none are hallucinated. This was not a blind run. (Worker transcript: `.claude/spool/0212-worker-codex-terra.log`.)

## Findings and disposition (AC2 — every defect triaged)

Six defects, all grounding-confirmed. None fixed in this task; each is filed as a tracked follow-up
(draft, for human promotion), referenced by ID. No finding is left silently unactioned.

| #   | Sev | Location                | Defect                                                                                                                                                                                         | Disposition  |
| --- | --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | P1  | `verifySlot.ts:177-179` | Non-atomic publish: lock pathname visible before its JSON is flushed; a waiter reads the partial file as null, steals it, and both verify.                                                     | **TASK-135** |
| 2   | P1  | `verifySlot.ts:184-190` | Unguarded stale-steal: the `remove()` is unconditional, so a second stale-stealer deletes the winner's fresh lock and both verify.                                                             | **TASK-135** |
| 3   | P1  | `verifySlot.ts:215-220` | Unpersisted lease: `isStale` uses the _waiter's_ `leaseMs`; the holder record stores no lease, so a short-timeout waiter steals a legitimately long-running holder.                            | **TASK-135** |
| 4   | P2  | `verifySlot.ts:177-182` | Non-contention create errors swallowed: an unwritable dir / full disk / FD limit is treated as EEXIST → acquire spins forever, wedging every merge.                                            | **TASK-135** |
| 5   | P1  | `handlers.ts:434-437`   | `request_branch_merge` misroutes a slash-containing **branch name** through `path.resolve` → fails the `.worktrees/` containment gate; the bare-branch form is unusable for `feature/…` names. | **TASK-136** |
| 6   | P1  | `handlers.ts:1119-1122` | `get_active_task` session-ledger fallback keyed only by `deps.root` (no session identity) → a second session at the same root is handed the first's task.                                      | **TASK-137** |

## Clean confirmations (AC3 — recorded, with the reviewer named)

`codex-terra` audited all five plan targets and found the following **clean**:

- **TASK-130 — `isSamePath` flavor fix** (`3f97a3d`): real-platform path-flavor behaviour is unchanged,
  and the worktree-target validation gate is not bypassable by a crafted path.
- **TASK-133 — `complete_task` dewire** (`0bbf569`): no reachable caller of the removed completion
  surface survives.
- **TASK-127 — `request_branch_merge`** (`3758b29`): the merge core correctly **derives** that no board
  mutation happens for a `branch:<name>` key (the invariant holds in the core, not merely trusted to
  callers). _(The separate slash-name resolution bug, finding #5, is in the arg-resolution helper, not
  in this board-neutralisation invariant.)_

## Conclusion

The wave is **not clean** on its two riskiest surfaces: the cross-process verify slot (four defects, all
capable of reintroducing verify overlap or wedging merges) and the `get_active_task` fallback (a
cross-session wrong-task handoff). The `request_branch_merge` board-neutralisation invariant, the
`isSamePath` fix, and the `complete_task` dewire hold up. All six defects are tracked in TASK-135 /
TASK-136 / TASK-137 for the next fix wave; they are latent (narrow timing windows or multi-session
preconditions), so they do not block shipping the wave provided the follow-ups are visible in the
release notes.
