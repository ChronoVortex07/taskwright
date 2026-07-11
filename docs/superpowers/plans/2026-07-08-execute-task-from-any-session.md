# `/execute-task` From Any Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the `/execute-task` skill so it no longer requires a board Dispatch — from a primary-rooted session it bootstraps the task's worktree via `start_task`, then closes via `request_merge` with the `worktree` target, while leaving the existing dispatched (already-worktree-rooted) path untouched.

**Architecture.** The whole feature rides two MCP tools that DRAFT-3 and DRAFT-4 land: `start_task { taskId }` (creates/enters `.worktrees/<branch>` and returns its paths) and `request_merge { … worktree? }` (rebase/verify/ff-merge against a _linked_ worktree even when the caller's MCP is rooted in the primary tree). This task is therefore almost entirely a **skill-document rewrite** (`.claude/skills/execute-task/SKILL.md`): step 1 accepts a user-named task ID (not only the active-task pointer), and step 2's "STOP if not worktree-rooted" branch becomes a **bootstrap** branch that calls `start_task` and then either relaunches into the worktree or continues single-session and closes with `request_merge { worktree }`. One small, unit-tested glue change repoints the `getActiveTask` no-active-task message so the MCP's own guidance reflects the from-any-session capability. Subscription-safety, the mandatory cancellation checkpoint, and the dispatched path are all preserved verbatim.

**Tech Stack:** Markdown (the skill + CLAUDE.md doc-sync), TypeScript (`src/mcp/handlers.ts` one-line message repoint), Vitest (unit test mirroring `src/test/unit/mcpHandlers.test.ts`). No webview/Svelte, no new MCP tool, no new frontmatter. Build/test via **Bun**.

---

## Prerequisites (this draft is BLOCKED)

This draft depends on two other drafts and **must be carved after they land**:

- **DRAFT-3 (`start_task` MCP tool)** — provides `mcp__taskwright__start_task` and its pure core `src/core/startTask.ts` (`bootstrapTaskWorktree`). The skill's new step 2 bootstrap branch calls this tool; it does not exist until DRAFT-3 is merged.
- **DRAFT-4 (`request_merge` gains optional `worktree?`)** — lets `request_merge { taskId, worktree }` rebase/verify/ff-merge against a linked worktree from a primary-rooted session (the `isPrimaryTree` abort applies **only** when `worktree` is absent). The single-session close path relies on this; it does not exist until DRAFT-4 is merged.

**Carve this worktree AFTER DRAFT-3 and DRAFT-4 land so their code is present.** Because the `taskwright` MCP server in a worktree runs the **primary** checkout's `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`), the `start_task` tool and the `request_merge { worktree }` behavior are only **live** once DRAFT-3/4 are merged into the primary **and the primary is rebuilt** (`bun run build` on main). The skill this task writes documents calling those tools; it cannot be _exercised live_ from within this worktree even after this task's own edits — validate the skill by the scenario walkthrough (Task 1, Step 4) and validate the glue by its unit test (Task 2), never by calling the MCP tool from the worktree.

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit with `--no-verify`** (the repo's lint-staged pre-commit hook flips the whole tree CRLF->LF on Windows). Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

---

## Locked names & wire conventions (do not rename)

Consumed here (defined by the prerequisite drafts — use these EXACT names/shapes):

- **`start_task` MCP tool** (DRAFT-3): input `{ taskId: string }`; output
  `{ created: boolean; taskId: string; branch: string; worktree: string /* repo-root-relative, e.g. ".worktrees/task-7-add-login" */; worktreeAbs: string; relaunchHint: string }`.
  Pure core `src/core/startTask.ts` exporting `bootstrapTaskWorktree(deps, taskId)` (vscode-free; reuses `WorktreeService.createWorktree` + `activeTask.writeActiveTask` + `cancellationMarker.clearCancellationMarker` + `dispatchBranchName`). Handler `startTaskHandler` in `src/mcp/handlers.ts`; registered in `src/mcp/server.ts`. The skill references it as `mcp__taskwright__start_task`.
- **`request_merge` optional `worktree?: string`** (DRAFT-4): a branch name OR a repo-root-relative `.worktrees/<branch>` path. When present, resolve+validate that linked worktree and run rebase/verify/ff-merge/cleanup against it (`FinishDeps.root` = that worktree's abs path; `primaryRoot` unchanged); the `isPrimaryTree` abort applies **only** when `worktree` is absent. Validation: the target must appear in `git worktree list --porcelain`, be clean, non-detached, and under this repo's `.worktrees/`.

Defined here:

- **No new code exports.** The only source edit is repointing an existing message string inside `getActiveTask` (`src/mcp/handlers.ts`). No new MCP tool, no new frontmatter, no webview change.
- **Skill** `.claude/skills/execute-task/SKILL.md` keeps `name: execute-task`; `allowed-tools` **adds `mcp__taskwright__start_task`** to the existing set (`get_active_task`/`claim_task`/`edit_task`/`request_merge`/`release_task`/`get_board` + the three superpowers skills + `Bash`/`Read`/`Grep`/`Glob`).

Not in scope here (sibling drafts, named for orientation only — do NOT touch): `next_ready_tasks` (DRAFT-5), `/orchestrate-board` (DRAFT-8), broaden-scaffolding (DRAFT-9).

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing text to match — **match the quoted text, not any cited line number**. SKILL.md anchors are verified against the working tree at this plan's authoring; line numbers may drift under earlier edits, but the quoted before/after snippets are authoritative.

---

## File Structure

**Modify:**

- `.claude/skills/execute-task/SKILL.md` — rewire frontmatter (`allowed-tools` + description), intro, "When to use", **step 1** (accept a user-named task ID), **step 2** (replace the STOP-if-not-worktree-rooted branch with a `start_task` bootstrap branch → relaunch OR single-session), **step 7** (worktree-targeted `request_merge` for the single-session path), the cancellation-contract "Worktree vanished" bullet, and "Rules of thumb". (Task 1)
- `CLAUDE.md` — correct the P5 bullet's one clause that says `/execute-task` "**verifies** … rather than self-creating a worktree" to reflect the from-any-session bootstrap. (Task 1)
- `src/mcp/handlers.ts` — repoint the `getActiveTask` no-active-task `message` so it names the from-any-session bootstrap path. (Task 2)

**Test:**

- `src/test/unit/mcpHandlers.test.ts` — add one case to the existing `getActiveTask` describe asserting the repointed no-active-task message. (Task 2)

---

## Task 1: Rewire `.claude/skills/execute-task/SKILL.md` for from-any-session (primary deliverable)

**Model:** Opus (judgment: preserve every guardrail — subscription-safety, cancellation checkpoint, dispatched path — while inverting the "STOP" branch into a coherent bootstrap; no code test, so the prose must be exactly right).

**Files:**

- Modify: `.claude/skills/execute-task/SKILL.md`, `CLAUDE.md`

**Goal:** The dispatched path stays byte-identical; the primary-rooted path becomes a first-class bootstrap. The MCP server roots itself **once at launch** (`src/mcp/server.ts`: `const root = process.env.TASKWRIGHT_ROOT?.trim() || process.cwd();`) and an in-session `cd` never re-roots it — so the skill cannot re-root the MCP, but it **can** (a) create the worktree with `start_task`, (b) do all Bash/file/test work inside it (those are not bound to the MCP root), and (c) close with `request_merge { worktree }` (DRAFT-4), which resolves+validates the linked worktree instead of aborting on the primary tree. The relaunch alternative gives full MCP isolation for callers who prefer a clean worktree-rooted session.

This is a docs-only change: the standard TDD exception (there is no failing test to write for prose). The "test" is the numbered scenario walkthrough in Step 4, plus the regression gate.

- [ ] **Step 1: Verify the anchors, then apply the eight SKILL.md edits**

Open `.claude/skills/execute-task/SKILL.md` and confirm each `old` block below appears verbatim before editing. Apply each edit exactly.

**Edit 1 — frontmatter (`description` + `allowed-tools`).** Add `start_task` to `allowed-tools` and note the from-any-session capability in the description.

Replace:

```
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task" for a task the board dispatched to this session. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__request_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Bash, Read, Grep, Glob
```

with:

```
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task". Works from ANY session: a dispatched worktree session, or a primary-rooted session that bootstraps its own worktree via start_task. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__start_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__request_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Bash, Read, Grep, Glob
```

**Edit 2 — intro paragraph.** Replace:

```
Execute exactly one Taskwright task from start to merge: load your assignment, confirm you are in
the task's isolated worktree, claim it, do the work with the right execution strategy, record what
you learn, and close through the merge queue with `request_merge`. Parity: every step here is one a
human can drive from the P2 board (Claim / Request merge / Cancel dispatch) — you are automating the
sequence, not bypassing it.
```

with:

```
Execute exactly one Taskwright task from start to merge: load your assignment, get into the task's
isolated worktree (already there when a dispatch launched you; otherwise bootstrap one with
`start_task`), claim it, do the work with the right execution strategy, record what you learn, and
close through the merge queue with `request_merge`. Parity: every step here is one a human can drive
from the P2 board (Claim / Request merge / Cancel dispatch) — you are automating the sequence, not
bypassing it.
```

**Edit 3 — "When to use" bullets.** Replace:

```
- The user invokes `/execute-task`, or asks you to execute / work on / do / run a specific task.
- A dispatch handed this session a task (the dispatch prompt tells you to run `/execute-task`).
- Not for authoring or decomposing new work — that is `/create-task`. This skill *executes* an
  existing task.
```

with:

```
- The user invokes `/execute-task`, or asks you to execute / work on / do / run a specific task.
- A dispatch handed this session a task (the dispatch prompt tells you to run `/execute-task`).
- **From any session — no board Dispatch required.** Run `/execute-task` from a primary-rooted
  session (optionally naming a task, e.g. `/execute-task TASK-7`) and this skill bootstraps the task's
  isolated worktree for you via `start_task`, then runs the same loop.
- Not for authoring or decomposing new work — that is `/create-task`. This skill *executes* an
  existing task.
```

**Edit 4 — step 1 (accept a user-named task ID).** Replace:

```
1. **Load once.** Call `get_active_task` a single time. Capture the returned **task ID** and its
   full context (description, acceptance criteria, plan link, subtasks). Work from that fixed ID for
   the rest of the session — **never re-read `get_active_task` for your identity or status**: the
   active task is an ephemeral human-focus pointer and may drift to an unrelated task while you work.
   - If `get_active_task` reports no active task, STOP and ask which task to work on (do not guess
     from the file tree).
```

with:

```
1. **Load once — fix your task ID.** Call `get_active_task` a single time, then settle on exactly ONE
   task ID for the whole session and work from that fixed ID — **never re-read `get_active_task` for
   your identity or status**: the active task is an ephemeral human-focus pointer and may drift to an
   unrelated task while you work.
   - If `get_active_task` returns a task, use its **task ID** and capture its full context
     (description, acceptance criteria, plan link, subtasks).
   - Else if the user named a task (e.g. `/execute-task TASK-7`), use that ID and load its context
     with `get_board` (find the row) so you have the same fields.
   - Else (no active task and none named), **STOP and ask which task to work on** — do not guess from
     the file tree.
```

**Edit 5 — step 2 (THE CRUX: replace the STOP branch with a bootstrap branch).** This is a block with a nested code fence; copy the `bash` fence exactly. Replace:

```
2. **Verify the worktree, then install deps.** Your task must run inside its own `.worktrees/<branch>`,
   because the `taskwright` MCP server roots itself at the directory the session was launched in — an
   in-session `cd` does not move it. This step **verifies**; it does not create.
   - The cheap confirmation is that step 1 returned a task at all (⇒ the MCP is rooted in the
     worktree). Double-check with Bash: `git rev-parse --git-common-dir` and `git rev-parse --git-dir`
     should **differ** (a linked worktree), and the working directory should be under `.worktrees/`.
   - If you are **not** worktree-rooted (step 1 returned "no active task", or the two git dirs match =
     the primary tree), **STOP**. Do not create a worktree and continue — the already-spawned MCP
     server cannot be re-rooted this session. Tell the user to **Dispatch** the task from the board
     (or relaunch the session with its working directory set to `.worktrees/<branch>`) and re-run
     `/execute-task`.
   - A fresh worktree has no `node_modules` (git-ignored). If it is absent, run `bun install` once
     (Bash) before you build or test.
   - Never `git checkout`, `commit`, or `merge` in the repository root — it is shared with other
     agents and a managed pre-commit hook blocks it. All git/file/test commands run in the worktree.
```

with (note: this new block CONTAINS a triple-backtick `bash` fence — in the plan it is wrapped in a 4-backtick fence so the inner fence survives; write the inner ` ```bash ` … ` ``` ` verbatim into SKILL.md):

````
2. **Get into the task's worktree (verify, or bootstrap).** The task runs inside its own
   `.worktrees/<branch>`. The `taskwright` MCP server roots itself at the directory the session was
   launched in and an in-session `cd` does **not** re-root it — so how you proceed depends on where
   the MCP is rooted. Determine that with Bash:

   ```bash
   # "linked" = a per-task worktree (--git-dir differs from the common dir); "primary" = the main checkout.
   [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] && echo linked || echo primary
   ```

   - **`linked` — already worktree-rooted (the dispatched path, unchanged).** Confirm the working
     directory is under `.worktrees/`. A fresh worktree has no `node_modules` (git-ignored) — if it is
     absent, run `bun install` once (Bash) before you build or test. Proceed; you will close with a
     bare `request_merge` (step 7).

   - **`primary` — primary-rooted, so bootstrap the worktree yourself.** You already hold a task ID
     from step 1. Call **`start_task { taskId }`**. It creates (or reuses) `.worktrees/<branch>`, seeds
     the active task there, clears any stale cancellation marker, and returns
     `{ created, branch, worktree, worktreeAbs, relaunchHint }`. Keep `worktree` (repo-root-relative,
     e.g. `.worktrees/task-7-add-login`) and `worktreeAbs`. Then pick ONE path:
     - **Relaunch (preferred — full MCP isolation).** Surface `relaunchHint` to the user: open a new
       session whose working directory is `worktreeAbs` and run `/execute-task` there, then **STOP this
       session**. The relaunched session is worktree-rooted, so it takes the `linked` path above and
       closes with a bare `request_merge`.
     - **Single session (continue here).** You cannot re-root the MCP, but Bash / file / test work is
       not bound to it: `cd` into `worktreeAbs` and run **all** git / file / test commands there. If
       `node_modules` is absent, `bun install` once. Do the work, then close with the worktree-targeted
       form **`request_merge { taskId, worktree }`** (step 7) — a bare `request_merge` would abort
       because the MCP is still rooted in the primary tree.

   - **Never** `git checkout`, `commit`, or `merge` in the repository root — it is shared with other
     agents and a managed pre-commit hook blocks it. All git / file / test commands run in the worktree.
````

**Edit 6 — step 7 (Close: worktree-targeted form for the single-session path).** Replace:

```
7. **Close.** When the work is committed and the worktree is clean, call `request_merge` from inside
   the worktree and wait for it to return. It rebases onto the base branch, runs the verify commands,
   waits for its turn in the merge queue (and, in manual-review mode, for the human's approval on the
   board), fast-forward-merges (or opens a PR), marks the task **Done**, and removes your worktree. Do
   not merge, commit, or push from the repository root yourself.
```

with:

```
7. **Close.** When the work is committed and the worktree is clean, close through the merge queue:
   - If you are **worktree-rooted** (dispatched, or relaunched into the worktree), call
     `request_merge` from inside the worktree.
   - If you bootstrapped in this same primary-rooted session, call **`request_merge { taskId, worktree }`**,
     passing the repo-root-relative `worktree` that `start_task` returned (e.g.
     `.worktrees/task-7-add-login`). The `worktree` target tells `request_merge` which linked worktree
     to rebase/verify/merge — without it, `request_merge` aborts because the MCP is rooted in the
     primary tree.
   Wait for it to return. It rebases onto the base branch, runs the verify commands, waits for its
   turn in the merge queue (and, in manual-review mode, for the human's approval on the board),
   fast-forward-merges (or opens a PR), marks the task **Done**, and removes your worktree. Do not
   merge, commit, or push from the repository root yourself.
```

**Edit 7 — cancellation contract "Worktree vanished" bullet.** Replace:

```
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", or `request_merge` aborting because it is now the
  primary tree). On POSIX the marker is deleted along with the worktree, so this is the reliable
  signal there; on Windows the marker may survive a busy removal.
```

with:

```
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", `request_merge { worktree }` aborting because the
  target worktree is no longer listed, or — from the primary tree with no `worktree` target — the
  primary-tree abort). On POSIX the marker is deleted along with the worktree, so this is the reliable
  signal there; on Windows the marker may survive a busy removal.
```

**Edit 8 — "Rules of thumb".** Replace:

```
- One session = one task; hold the task ID from step 1 and never re-derive it.
- Launch inside the worktree; if you are not worktree-rooted, stop and ask for a dispatch — do not
  self-create a worktree and continue.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close with `request_merge` from the worktree; never commit/merge from the repo root.
```

with:

```
- One session = one task; hold the task ID from step 1 and never re-derive it.
- Get into the worktree before doing work: worktree-rooted ⇒ proceed; primary-rooted ⇒ `start_task`,
  then relaunch into it or continue single-session and close with `request_merge { worktree }`.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close through the merge queue from the worktree; never commit/merge from the repo root.
```

> **What is deliberately unchanged:** the "Subscription safety" section, step 3 (Claim), step 4 (adaptive execute), step 5 (record via `edit_task`), step 6 (mandatory cancellation checkpoint), and the "Marker present" cancellation bullet. Do not touch them — they hold for both paths.

- [ ] **Step 2: Doc-sync `CLAUDE.md` — correct the stale P5 clause**

The P5 CLAUDE.md bullet still says `/execute-task` _verifies_ rather than self-creating a worktree. DRAFT-7 reverses that. In `CLAUDE.md`, replace (these two lines carry the ` >` blockquote prefix — match it exactly):

```
  > repoint. The MCP root is fixed at launch (`server.ts`), so `/execute-task` **verifies** it is
  > worktree-rooted rather than self-creating a worktree (spec §5 direct-run descoped to launch-in-worktree).
```

with:

```
  > repoint. The MCP root is fixed at launch (`server.ts`) and cannot re-root mid-session, so
  > `/execute-task` runs from **any** session: dispatched (already worktree-rooted) it proceeds
  > directly; primary-rooted it bootstraps the task's worktree via `start_task` and either relaunches
  > into it or continues single-session and closes with `request_merge { worktree }`
  > (DRAFT-7 — `docs/superpowers/plans/2026-07-08-execute-task-from-any-session.md`).
```

- [ ] **Step 3: Sanity-check the skill still parses**

Confirm the YAML frontmatter fence is intact (`---` … `---`), `name: execute-task` unchanged, the seven `mcp__taskwright__*` tools plus the three `Skill(superpowers:*)` plus `Bash, Read, Grep, Glob` are all present on the `allowed-tools` line, and `mcp__taskwright__start_task` is now among them. Confirm the new step-2 `bash` fence opens and closes cleanly (no stray backticks) and the numbered list 1–7 is contiguous.

- [ ] **Step 4: Self-check — the scenario walkthrough (the "test" for the doc)**

Read the edited skill top-to-bottom and confirm each scenario reaches the right terminus. Record the trace in this task's implementation notes (via `edit_task`). All five must hold:

1. **Dispatched (worktree-rooted).** step 1 loads the active task the dispatch seeded → step 2 root probe prints `linked` → confirm under `.worktrees/`, `bun install` if needed → claim → execute → cancellation checkpoint → step 7 **bare `request_merge`** → Done. _(Unchanged from before this task — the dispatched path is preserved.)_
2. **Primary-rooted, relaunch path.** step 1 (active task set by opening the board popover, OR a named `/execute-task TASK-7`) → step 2 prints `primary` → `start_task { taskId }` creates `.worktrees/<branch>` and returns `relaunchHint`/`worktreeAbs` → surface `relaunchHint`, **STOP this session** → user relaunches rooted in the worktree → that session is `linked` → runs the whole loop → **bare `request_merge`** → Done.
3. **Primary-rooted, single-session path.** step 1 → step 2 prints `primary` → `start_task { taskId }` (keep `worktree`, `worktreeAbs`) → `cd worktreeAbs`, `bun install` if needed → claim → execute → cancellation checkpoint → step 7 **`request_merge { taskId, worktree }`** (DRAFT-4 resolves the linked worktree — no primary-tree abort) → Done. **This proves the from-any-session path reaches Done via `request_merge`.**
4. **Graceful STOP — no task.** step 1: `get_active_task` returns no active task AND the user named none → **STOP and ask** (no `start_task`, no guessing from the file tree). Degrades cleanly.
5. **Cancellation mid-flight (both paths).** At the mandatory checkpoint (step 6), either `test -f .taskwright/cancelled` succeeds (presence-only) OR a worktree op fails / `request_merge { worktree }` aborts because the worktree is no longer listed → **stop, do NOT `request_merge`**, optional `edit_task` note, exit; the extension owns teardown. Holds for the bootstrapped worktree too (after `start_task`, the board's Cancel-dispatch affordance sees the worktree dir and can cancel it).

Falsification: if any scenario cannot be traced to its stated terminus using only the edited skill text (e.g. the single-session path has no worktree-targeted close, or the STOP branch is missing), the edits are wrong — fix the prose before proceeding.

- [ ] **Step 5: Full task gate**

Run in the worktree:

```
bun run test && bun run lint && bun run typecheck
```

Expected: PASS with no regression from the baseline (docs-only change; Windows keeps its ~22 known upstream POSIX-path failures — do not "fix"). No new test is added by this task (the deliverable is prose, validated by Step 4).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/execute-task/SKILL.md CLAUDE.md
git commit --no-verify -m "docs(execute-task): run /execute-task from any session (bootstrap via start_task)

- SKILL.md: step 1 accepts a user-named task ID; step 2 replaces the STOP-if-not-worktree-rooted
  branch with a start_task bootstrap (relaunch into the worktree, OR continue single-session and
  close with request_merge { worktree }); step 7 documents the worktree-targeted close; frontmatter
  adds mcp__taskwright__start_task; rules-of-thumb + cancellation-vanished bullet updated
- dispatched path, subscription-safety, and the mandatory cancellation checkpoint preserved verbatim
- CLAUDE.md: correct the stale P5 clause (verify -> bootstrap-from-any-session)

Completes DRAFT-7.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** DRAFT-3 (`start_task`) and DRAFT-4 (`request_merge { worktree }`) merged + primary rebuilt (Prerequisites). Independent of Task 2 — the skill logic does not depend on the message string Task 2 repoints.

---

## Task 2: Repoint the `getActiveTask` no-active-task message (glue)

**Model:** Opus (tiny, but the message must stay coherent with the skill; TDD).

**Files:**

- Modify: `src/mcp/handlers.ts`
- Test: `src/test/unit/mcpHandlers.test.ts`

**Goal:** When a primary-rooted session runs `/execute-task` with nothing set, `get_active_task` currently returns "Pick a task on the Taskwright board (or dispatch one) before starting." — which no longer reflects reality (you can now name a task and bootstrap its worktree from here). Repoint that one message so the MCP's own guidance names the from-any-session path. Pure string change, exercised by a unit test (the MCP server in a worktree runs the primary build, so this is validated by the test, never by a live call — see Prerequisites).

> Before editing, confirm no test asserts the OLD string verbatim: `grep -rn "Pick a task on the Taskwright board" src/test` returns nothing, and the only `getActiveTask` no-active-task assertion (`src/test/unit/mcpHandlers.test.ts`, "reports no active task when none is set") checks `expect(result.message).toBeTruthy()` — unaffected.

- [ ] **Step 1: Write the failing test**

In `src/test/unit/mcpHandlers.test.ts`, inside the existing `describe('getActiveTask', …)` block, add this case immediately after the existing `it('reports no active task when none is set', …)` test:

```ts
it('no-active-task message names the from-any-session bootstrap path (DRAFT-7)', async () => {
  routeReads(null);
  const result = await getActiveTask(makeDeps());
  expect(result.active).toBe(false);
  expect(result.message).toContain('/execute-task');
  expect(result.message?.toLowerCase()).toContain('bootstrap');
});
```

> This reuses the file's existing `routeReads(null)` helper (routes `active-task.json` reads to an ENOENT throw, so `readActiveTask` returns undefined and `getActiveTask` takes the no-active branch) and `makeDeps()` (a fully-wired `McpHandlerDeps` over `/repo`). The two assertions falsify against the current message, which contains neither `/execute-task` nor `bootstrap`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- mcpHandlers`
Expected: FAIL on the new case — the current message is `No active task is set. Pick a task on the Taskwright board (or dispatch one) before starting.`, which contains neither `/execute-task` nor `bootstrap`. (The sibling `toBeTruthy` case stays green.)

- [ ] **Step 3: Repoint the message in `src/mcp/handlers.ts`**

In `getActiveTask`, replace the no-active-task return:

```ts
if (!active) {
  return {
    active: false,
    message:
      'No active task is set. Pick a task on the Taskwright board (or dispatch one) before starting.',
  };
}
```

with:

```ts
if (!active) {
  return {
    active: false,
    message:
      'No active task is set. Pick a task on the Taskwright board (or dispatch one), or run ' +
      '/execute-task naming a task (e.g. /execute-task TASK-7) to bootstrap its worktree from here.',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- mcpHandlers && bun run typecheck` → PASS (both the new case and the existing `toBeTruthy` case).

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck` → PASS (no regression; Windows keeps its ~22 known upstream POSIX-path failures — do not "fix").

- [ ] **Step 6: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/mcpHandlers.test.ts
git commit --no-verify -m "feat(mcp): get_active_task points at the /execute-task bootstrap path (DRAFT-7 glue)

- getActiveTask's no-active-task message now names running /execute-task with a task id to
  bootstrap its worktree from a primary-rooted session, alongside the board/dispatch options
- unit test asserts the repointed message mentions /execute-task and bootstrap

Completes DRAFT-7.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** none (independent of Task 1). Not live in a worktree until this branch merges + the primary rebuilds; exercised via the unit test.

---

## Closing the PR

After both tasks are committed and the worktree is clean, run the full gate once more and close through the merge queue **from inside this worktree** (do NOT ff-merge or push from the repo root):

```
bun run test && bun run lint && bun run typecheck
```

Then call `request_merge` (the `/execute-task` flow's close). If this very session bootstrapped its own worktree (primary-rooted), close with `request_merge { taskId, worktree }` per the skill's step 7; if it is worktree-rooted, a bare `request_merge`.

---

## Self-Review

**1. Spec coverage (Item 3c).** The `/execute-task` skill no longer requires a board Dispatch: step 1 accepts a user-named task ID (Edit 4); step 2's "STOP if not worktree-rooted" branch is replaced by a `start_task` bootstrap that offers relaunch OR single-session (Edit 5); the single-session close uses `request_merge { worktree }` (Edit 6). Both prerequisite tools (`start_task` DRAFT-3, `request_merge { worktree }` DRAFT-4) are consumed by their exact locked names/shapes. The `getActiveTask` message is repointed to match (Task 2).

**2. Invariant honored.** The plan never assumes the MCP can re-root (`src/mcp/server.ts` fixes `root` at launch). Instead: `start_task` creates the worktree, Bash/file/test work runs inside it (not bound to the MCP root), and `request_merge { worktree }` closes against the linked worktree from the primary tree — exactly the DRAFT-4 contract.

**3. Preserved verbatim.** Subscription-safety (in-session; sub-skills use Task-tool subagents; never `claude -p`) — the "Subscription safety" section is untouched. The mandatory cancellation checkpoint (step 6) and its presence-only/vanished contract are untouched except the "Worktree vanished" bullet, which is _broadened_ to cover the `{ worktree }` abort (not weakened). The dispatched path is byte-identical (the `linked` branch of Edit 5 = the old verify + `bun install` behavior).

**4. No placeholders.** Every SKILL.md edit shows full before/after replacement text; the glue shows the complete test and the complete implementation string; commit commands stage only the named files with `--no-verify`. The one author-substituted token is the `Co-Authored-By: <your model>` trailer (per Global Constraints, the dispatched agent fills its own model line).

**5. Type/name consistency.** `mcp__taskwright__start_task` matches the DRAFT-3 tool name; `request_merge { taskId, worktree }` matches DRAFT-4's optional `worktree?`; `worktree`/`worktreeAbs`/`relaunchHint` match the `StartTaskResult` fields. No code export is added or renamed. The glue edits only a string literal inside the existing `getActiveTask` return; `McpHandlerDeps`, `ActiveTaskResult`, and `getActiveTask`'s signature are unchanged, so `typecheck` and every other `getActiveTask` test stay green.

**6. Test discipline.** Task 1 is docs-only (the standard TDD exception) — validated by the five-scenario walkthrough (dispatched, relaunch, single-session-to-Done, graceful STOP, cancellation) plus the regression gate. Task 2 is TDD: failing test (message lacks `/execute-task`+`bootstrap`) → minimal string change → green, mirroring `src/test/unit/mcpHandlers.test.ts`/`toSummary.test.ts`. No vacuous assertions: the walkthrough has a falsification clause; the unit test asserts two distinct substrings absent from the old message.

**7. Prerequisite/live-ness caveat surfaced.** The plan states up front that `start_task`/`request_merge { worktree }` and the repointed message are only live after DRAFT-3/4 merge + primary rebuild, so this worktree validates by walkthrough + unit test, never by a live MCP call.
