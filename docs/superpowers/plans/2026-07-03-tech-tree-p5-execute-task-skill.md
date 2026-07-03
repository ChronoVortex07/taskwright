# Tech-tree P5 — `/execute-task` Skill & Cancellation Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude an **execution** counterpart to P4's authoring skill: a `/execute-task` skill that takes one dispatched task, confirms it is in the task's isolated worktree, claims it, does the work with the right superpowers execution strategy, records progress, and closes through the merge queue — subscription-safe, honoring worktree isolation, identically whether it was dispatched or launched by hand. P5 also **owns the Cancel-dispatch plumbing** P2's popover triggers: a task/worktree-scoped cancellation marker that a live agent detects and stops on. Along the way P5 **closes the gaps that make that loop actually work** against the landed code (per the binding directives): the marker must be written **first** so teardown can't resurrect the worktree dir and defeat isolation (GAP-1/4), dispatch must clear a stale marker so a re-dispatch doesn't insta-abort (GAP-3), `get_active_task` must surface `subtasks`/`parentTaskId` so the SDD branch can fire (GAP-5), the Cancel-dispatch affordance must be gated on worktree-dir existence so a dispatched-but-unclaimed task is teardownable (GAP-7), and the dispatch template must point at `/execute-task` while keeping every guardrail (GAP-9).

**CENTRAL INVARIANT (the spine of this phase — bind first).** The taskwright MCP server roots itself **once at process launch** (`root = process.env.TASKWRIGHT_ROOT?.trim() || process.cwd()`, `src/mcp/server.ts:73`; `scripts/taskwright-mcp.cjs` sets `TASKWRIGHT_ROOT = cwd`). An in-session `cd` does **not** re-root it. Consequences, all code-verified: `get_active_task` returns a task **only when the session was launched with the worktree as its cwd** (`handlers.ts:392-393`; dispatch seeds active-task only into the worktree, `dispatchActions.ts:114`); `request_merge` **hard-aborts** on the primary tree (`isPrimaryTree`, `handlers.ts:300-308`); the marker's Windows-survival depends on the agent's long-lived process being rooted inside the worktree. Therefore P5's `/execute-task` targets a session **whose MCP is already rooted in the worktree** (dispatched, or launched with cwd = `.worktrees/<branch>`). The skill's step 2 **verifies** it is worktree-rooted (it does **not** self-create a worktree and continue — architecturally impossible with the fixed root). Every deliverable below serves this invariant.

**Scope boundary (P5).** This plan implements the P5 architecture directives (`.superpowers/tech-tree-run/p5-architecture-directives.md`) in full: GAP-1..GAP-9 and the deliverable breakdown. It does **not** implement codebase-indexing tree bootstrap (**P6**), nor a re-rootable MCP server (`set_root` / per-call root — explicitly accepted debt / future enhancement). No new frontmatter (`dispatched_at` is deliberately **not** added — GAP-8). The direct-run-from-anywhere ergonomic is descoped to launch-in-worktree (spec §5 deviation, recorded in the directives' DEVIATIONS and in a one-line spec addendum here).

**Architecture.** The changes span four seams, all reusing existing cores (parity — every step the skill takes has a human equivalent on the P2 board):
- **New pure core** `src/core/cancellationMarker.ts` mirroring `src/core/activeTask.ts` exactly (STATE_DIR `.taskwright`, never-throws reads): `writeCancellationMarker` / `isCancelled` (**presence-only** — never parses the JSON) / `clearCancellationMarker`.
- **Cancel-dispatch orchestrator** `src/core/cancelDispatch.ts` gains a `writeCancellationMarker` dep and a **marker-first** order (`marker → releaseClaim → setStatus → removeWorktree → disposeTerminal`); the extension threads the **absolute** `worktreePathFor(repoRoot, branch)` into that dep.
- **Dispatch seam** — `dispatchActions.ts` clears any stale marker on seed; `dispatchPrompt.ts` repoints `DEFAULT_DISPATCH_TEMPLATE` at `/execute-task` (guardrails kept, workflow prose migrated into the skill).
- **Read/UI surface** — `handlers.ts` `toSummary` surfaces `subtasks`/`parentTaskId`; `TasksController` computes a `dispatchedWorktree` boolean (`fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)))`) and `DetailPopover` gates Cancel-dispatch on `dispatchedWorktree || hasWorktree`.
- **The skill** — `.claude/skills/execute-task/SKILL.md`, house format, encoding the load-once → verify-worktree → claim → adaptive-execute → record → cancellation-checkpoint → `request_merge` loop and the presence-only-OR-vanished cancellation contract.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure cores + temp-dir scaffolds + host-agnostic controller cases + vscode-mock provider case), Playwright (popover affordance), CDP-over-WebSocket (full-suite regression bound to the riskiest webview task), esbuild (extension + MCP bundles) + Vite (webview bundles). MCP handlers run as a separate stdio process reusing only `src/core`.

## Where this fits (the tech-tree overhaul)

- **Umbrella vision:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`.
- **Spec (approved, superseded by the directives where they conflict):** `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md`.
- **Directives (orchestrator-locked, binding):** `.superpowers/tech-tree-run/p5-architecture-directives.md` (CENTRAL INVARIANT, GAP-1..GAP-9, Deliverable breakdown, DEVIATIONS). Every directive is honored below; none are relitigated.
- **Base:** main `dd5e4e2` (advanced from `6a93c17` via the sync FETCH_HEAD-race fix — touches only `boardRef.ts` + its test, **no P5 file**, so every P5 anchor below is unchanged from `6a93c17`; Task 9's `boardRef.ts`/`boardSyncEngine.ts` anchors are re-verified at `dd5e4e2`). Worktree `.worktrees/tech-tree-p5`, branch `tech-tree-p5`, **carved from `dd5e4e2`**.
- **Builds on landed reality:** P1 (claim/gating), P2 (Dispatch + Cancel-dispatch popover triggers), P3/P4 (create/traverse tools), and the existing dispatch/merge infrastructure (`WorktreeService`, `activeTask`, `handoff`, `ClaimService`, `finishTask`/`request_merge`, `scripts/taskwright-mcp.cjs`). `cancelDispatch` (v1) already tears local state down (`extension.ts:1131-1174`) — P5 makes it signal a live agent, in the right order.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p5` on branch `tech-tree-p5`. Run all git/file/test commands inside the worktree. A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there **once** before the first build/test. Never commit/merge from the repo root; stage only the files each task names; commit with `--no-verify` (the repo's lint-staged pre-commit hook flips the whole tree CRLF→LF on Windows — see the memory note "Pre-commit hook autocrlf corruption").
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (`dd5e4e2`):** capture them **in the fresh worktree** (`.worktrees/tech-tree-p5`), never the primary tree (the primary is prone to the INCIDENT-3 root-flush) — after `bun install`, run `bun run test`, `bun run test:playwright`, `bun run test:cdp` once and **record the actual pass counts** (do not hardcode; the run's earlier phases nudge these). Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **MCP primary-build live-caveat:** the `taskwright` MCP server in a worktree runs the **primary** checkout's `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). Changes to `handlers.ts`/`server.ts` (Task 5) are **NOT live** in the worktree until this branch is merged and the primary rebuilt. Exercise them via **unit tests**, never by calling the tool live from the worktree. A post-land smoke is the orchestrator's job.
- **Parity (mandatory):** every step the skill takes has a human equivalent on the P2 board (Claim / Request merge / Cancel dispatch); the skill automates the sequence via the same tools/cores. The cancellation marker reuses the `activeTask.ts` module shape; `cancelDispatch` reuses the injected-dep orchestrator; the affordance reuses the existing `taskwright.cancelDispatch` command.
- **Every task's verify gate runs `bun run test:playwright -- tree-`** (the `e2e/tree-*.spec.ts` glob — `tree-authoring`/`tree-canvas`/`tree-drag`/`tree-navigator`/`tree-popover`) **plus** `bun run test`, `bun run lint`, `bun run typecheck`. The **full** `bun run test:playwright` and the **full CDP** suite run at least once, **bound to Task 6** (the only webview/controller change, and the highest cross-view-regression risk); Task 8 re-runs the full unit + Playwright gate at close. **Next CDP port is 9345** (reserved — P5 needs no new CDP file; the affordance is covered by the controller unit test + the Playwright popover touch + a full-CDP regression run).
- **Rendering discipline (webview):** Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens. The only webview change in P5 is a two-line guard in `DetailPopover.svelte` — no new component, no CSP surface change. Run the `svelte` MCP `svelte-autofixer` over `DetailPopover.svelte` until clean before committing (a `state_referenced_locally` warning on an init-once `$state` read is a known FALSE POSITIVE → suppress with `<!-- svelte-ignore state_referenced_locally -->`, do not restructure).
- **Root check-and-heal before/after every dispatch:** the shared root tree can accumulate autocrlf noise; heal per the memory notes before staging.
- **Commit trailer:** end each commit with `Co-Authored-By: <implementing model> <noreply@anthropic.com>` (opus tasks: `Claude Opus 4.8 (1M context)`; the haiku task: `Claude Haiku 4.5`; workers substitute their own model line per `AGENTS.md`). **The orchestrator lands this branch (ff-merge) — the close task (Task 8) ends at "worktree clean, all gates green, ledger updated", NOT `request_merge`.**

## Locked names & wire conventions (from the directives — do not rename)

- **New core module** `src/core/cancellationMarker.ts` exporting `cancellationMarkerPath(root)`, `writeCancellationMarker(root, taskId, now?)`, `isCancelled(root)`, `clearCancellationMarker(root)`, and `interface CancellationMarker { taskId; cancelledAt }`. Marker file: `<root>/.taskwright/cancelled`. Detection is **presence-based**; `taskId` is stored for human/debug legibility only.
- **`CancelDispatchDeps` gains** `writeCancellationMarker: (taskId: string) => void` as its **first** field; the order is `marker → releaseClaim → setStatus → removeWorktree → disposeTerminal`.
- **`TaskSummary` gains** `subtasks?: string[]` and `parentTaskId?: string` (parity: the active-task view reflects the task).
- **`Task` (webview-visible) gains** board-bus enrichment `dispatchedWorktree?: boolean`.
- **No new frontmatter** (`dispatched_at` is NOT added). **No new MCP tool** (`ensure_worktree` is NOT added). **No new webview message** (Cancel-dispatch already posts `{ type:'cancelDispatch'; taskId }`, `TechTreeCanvas.svelte:677`).
- **Skill** `.claude/skills/execute-task/SKILL.md` — `name: execute-task`; `allowed-tools` = the taskwright MCP tools `get_active_task`/`claim_task`/`edit_task`/`request_merge`/`release_task`/`get_board` + `Skill(superpowers:executing-plans)` / `Skill(superpowers:subagent-driven-development)` / `Skill(superpowers:test-driven-development)` + `Bash` + `Read`/`Grep`/`Glob`.

## Shape of the phase (the 9 tasks)

Cores first (the marker), then the wiring that depends on them, then the independent seams, then the skill, then the folded board.materialized bugfix (Task 9), then docs/close.

1. **`src/core/cancellationMarker.ts` + unit tests** [opus]. Pure core mirroring `activeTask.ts`; presence-only `isCancelled`; never throws. (GAP-4 core.)
2. **`cancelDispatch` marker-first order + `writeCancellationMarker` dep + extension wiring + GAP-8 TODO reword** [opus]. Reorder + extend `cancelDispatch.test.ts` (incl. a Windows-busy survival test); thread the absolute worktree path from `extension.ts`. (GAP-1, GAP-4, GAP-8; GAP-2 record correction folded into the reworded comment.)
3. **Dispatch clears a stale marker on seed** [opus]. `dispatchActions.ts` `clearCancellationMarker(sessionRoot)` alongside `writeActiveTask`; new provider test. (GAP-3.)
4. **Dispatch template repoint** [opus]. `DEFAULT_DISPATCH_TEMPLATE` → launch inside `.worktrees/{{worktree}}` and run `/execute-task`; guardrails kept; workflow prose migrated to the skill; handoff stays in sync; template tests adjusted. (GAP-9.)
5. **`toSummary` surfaces `subtasks` + `parentTaskId`** [opus]. `TaskSummary` + `toSummary` + a new `toSummary` unit test. (GAP-5 data.)
6. **Cancel-dispatch affordance: `dispatchedWorktree` enrichment + popover gate** [opus]. `types.ts` + `TasksController` + `DetailPopover.svelte` + controller test + Playwright popover touch; **full Playwright + full CDP** bound here. (GAP-7.)
7. **`.claude/skills/execute-task/SKILL.md`** [haiku]. Full verbatim skill (frontmatter + loop + ordered adaptive selector + presence-only-OR-vanished cancellation contract + migrated guardrails). (GAP-2/5/6/9 prose.)
8. **Docs + full gate + close** [opus]. CLAUDE.md P5 bullet (✅), one-line spec §5 addendum, AGENTS.md cross-reference verify; full regression gate (covers Task 9); hand back (no `request_merge`).
9. **Frozen `board.materialized` bugfix (folded, user-directed)** [opus]. A distinct residual on the synced board: `refreshBoard` re-materializes every ~20s because the prune loop's unforced `fs.rmSync` throws before `writeMaterialized` runs, so the marker froze at `10fdb770…` since Jul 1. Live systematic-debugging → fix at source (`{ force: true }` + the real cause the repro reveals) → **surface** (log) the swallowed failure → TDD regression. Board node = **TASK-26** (`type: bug`), distinct from TASK-25. Rides the P5 branch.

**Recommended execution order (green at every commit):** `1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 8` — Task 9 executes **before** the Task 8 close so the final full gate covers its tests.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. P5-file line numbers are verified against the working tree at `6a93c17` (unchanged at `dd5e4e2` — the sync fix touched no P5 file); Task 9's `boardRef.ts`/`boardSyncEngine.ts` anchors are re-verified at `dd5e4e2`. Line numbers may drift under earlier edits; the quoted before/after snippets are authoritative.

---

## File Structure

**Create:**

- `src/core/cancellationMarker.ts` — vscode-free marker core mirroring `activeTask.ts` (path/write/presence-only read/clear; never throws).
- `src/test/unit/cancellationMarker.test.ts` — temp-dir unit tests (write→present, clear→absent, idempotent, never-throws, **presence-only** even for non-JSON contents).
- `src/test/unit/dispatchActions.test.ts` — provider test (vscode-mock + config-mock): dispatch clears a stale marker on seed (GAP-3).
- `src/test/unit/toSummary.test.ts` — `toSummary` surfaces `subtasks`/`parentTaskId` (GAP-5).
- `.claude/skills/execute-task/SKILL.md` — the `/execute-task` skill.

**Modify:**

- `src/core/cancelDispatch.ts` — add `writeCancellationMarker` dep; marker-first order; reword the stale GAP-8 TODO (record the marker-is-the-signal + Windows-leak/re-dispatch-heal facts; no `dispatched_at`).
- `src/test/unit/cancelDispatch.test.ts` — reorder the order assertion to `['marker','release','status','worktree','terminal']`; add the `writeCancellationMarker` dep to both existing cases; add a real-marker path + Windows-busy-survival case.
- `src/extension.ts` — import `writeCancellationMarker` (from `./core/cancellationMarker`) + `worktreePathFor` (from `./core/WorktreeService`); add the `writeCancellationMarker` closure (absolute `worktreePathFor(repoRoot, branch)`) as the first `cancelDispatch` dep.
- `src/providers/dispatchActions.ts` — `clearCancellationMarker(sessionRoot)` immediately after `writeActiveTask(sessionRoot, taskId)`.
- `src/core/dispatchPrompt.ts` — repointed `DEFAULT_DISPATCH_TEMPLATE`.
- `src/test/unit/dispatchPrompt.test.ts` — adjust the three template assertions that reference removed prose; add the GAP-9 `/execute-task` describe.
- `src/mcp/handlers.ts` — `TaskSummary` + `toSummary` add `subtasks`/`parentTaskId`.
- `src/core/types.ts` — `Task` gains `dispatchedWorktree?: boolean` (board-bus enrichment).
- `src/providers/TasksController.ts` — compute `dispatchedWorktree` in the tree-tab enrichment (imports `dispatchBranchName`, `worktreePathFor`, `fs`).
- `src/test/unit/TasksController.test.ts` — `dispatchedWorktree` enrichment case (spy `fs.existsSync`).
- `src/webview/components/tree/DetailPopover.svelte` — `hasDispatchedWorktree` derived; gate Cancel-dispatch on `dispatchedWorktree || hasWorktree`.
- `e2e/tree-popover.spec.ts` — a dispatched-but-unclaimed in-progress task offers Cancel dispatch (+ negative).
- `CLAUDE.md` — P5 bullet (Task 8).
- `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md` — one-line §5 addendum (Task 8).
- `src/core/boardRef.ts` — force the prune-loop `fs.rmSync` (+ the real cause the repro reveals) so `materialize` stops throwing before `writeMaterialized` (Task 9).
- `src/providers/BoardSyncController.ts` — surface a materialize/poll failure (degraded status + de-duplicated log) instead of an invisible ext-host `console.error` (Task 9).
- `src/test/unit/boardRef.test.ts` and/or `src/test/unit/boardSyncEngine.test.ts` — prune-force regression + "materialize failure is surfaced, marker not advanced on failure" (Task 9).

---

## Task 1: `src/core/cancellationMarker.ts` + unit tests (GAP-4 core) [opus]

**Model:** Opus (new correctness core; the presence-only-vs-parse contract + never-throws semantics need care).

**Files:**

- Create: `src/core/cancellationMarker.ts`
- Test: `src/test/unit/cancellationMarker.test.ts`

**Goal (GAP-4):** `CancelDispatchDeps` cannot express the marker write today, and the cancellation contract needs a task/worktree-scoped file at `<root>/.taskwright/cancelled`. Build the pure core first — it has no consumers yet, so it lands green in isolation. It **mirrors `activeTask.ts`** (STATE_DIR `.taskwright`, `mkdirSync({recursive:true})` on write, never-throws read) but with **presence-only** detection: `isCancelled` is a bare existence check and NEVER reads/parses the file (the JSON `taskId` is for humans/debugging only). This is the one deliberate divergence from `activeTask.ts` (which parses its JSON) — encode it, and test it.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/cancellationMarker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  cancellationMarkerPath,
  writeCancellationMarker,
  isCancelled,
  clearCancellationMarker,
} from '../../core/cancellationMarker';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-marker-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('cancellationMarker', () => {
  it('path is <root>/.taskwright/cancelled', () => {
    expect(cancellationMarkerPath(root)).toBe(path.join(root, '.taskwright', 'cancelled'));
  });

  it('write creates the state dir + file; isCancelled flips false -> true', () => {
    expect(isCancelled(root)).toBe(false); // negative control (nothing written yet)
    const marker = writeCancellationMarker(root, 'TASK-7', new Date('2026-07-03T12:00:00Z'));
    expect(marker).toEqual({ taskId: 'TASK-7', cancelledAt: '2026-07-03T12:00:00.000Z' });
    expect(fs.existsSync(cancellationMarkerPath(root))).toBe(true);
    expect(isCancelled(root)).toBe(true);
    // File content is JSON with the task id (human/debug legibility only).
    const raw = JSON.parse(fs.readFileSync(cancellationMarkerPath(root), 'utf-8'));
    expect(raw.taskId).toBe('TASK-7');
  });

  it('detection is PRESENCE-ONLY — a non-JSON marker still reads as cancelled', () => {
    // Contract divergence from activeTask.ts: isCancelled never PARSES the file.
    fs.mkdirSync(path.join(root, '.taskwright'), { recursive: true });
    fs.writeFileSync(cancellationMarkerPath(root), 'not json at all', 'utf-8');
    expect(isCancelled(root)).toBe(true);
  });

  it('clear removes the marker; isCancelled returns to false; idempotent', () => {
    writeCancellationMarker(root, 'TASK-7');
    clearCancellationMarker(root);
    expect(isCancelled(root)).toBe(false);
    // Idempotent — clearing an already-absent marker does not throw.
    expect(() => clearCancellationMarker(root)).not.toThrow();
  });

  it('isCancelled never throws on a non-existent root', () => {
    const missing = path.join(root, 'does', 'not', 'exist');
    expect(() => isCancelled(missing)).not.toThrow();
    expect(isCancelled(missing)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- cancellationMarker`
Expected: FAIL — `src/core/cancellationMarker` does not exist. (Positive controls: the false→true flip and the presence-only case both prove the module's behavior, not a tautology.)

- [ ] **Step 3: Write `src/core/cancellationMarker.ts`**

```ts
import * as fs from 'fs';
import * as path from 'path';

/**
 * The cancellation marker is Taskwright's task/worktree-scoped stop signal for a
 * dispatched agent. When a human cancels a dispatch, the extension writes this marker
 * into the task's worktree `.taskwright/` BEFORE tearing the worktree down (the ordering
 * is load-bearing — see src/core/cancelDispatch.ts). A dispatched `/execute-task` session
 * polls for it at each checkpoint and stops cleanly (it never calls request_merge).
 *
 * Mirrors src/core/activeTask.ts (STATE_DIR `.taskwright`, mkdir-on-write, never-throws
 * reads) with ONE deliberate divergence: detection is PRESENCE-ONLY. `isCancelled` is a
 * bare existence check and never reads or parses the file — the JSON `taskId` it stores is
 * for human/debug legibility, never for control flow. State lives at
 * `<root>/.taskwright/cancelled`, where `root` is the worktree the session runs in.
 * Local/ephemeral (git-ignored), never shared.
 */

export interface CancellationMarker {
  /** ID of the cancelled task — for human/debug legibility only, never parsed for control. */
  taskId: string;
  /** ISO-8601 timestamp of when the dispatch was cancelled. */
  cancelledAt: string;
}

const STATE_DIR = '.taskwright';
const STATE_FILE = 'cancelled';

/** Absolute path of the cancellation marker file under `root`. */
export function cancellationMarkerPath(root: string): string {
  return path.join(root, STATE_DIR, STATE_FILE);
}

/**
 * True when a cancellation marker exists for `root`. Presence-only — the file's contents
 * are never read or parsed. Never throws (a missing file / unreadable path ⇒ false).
 */
export function isCancelled(root: string): boolean {
  try {
    return fs.existsSync(cancellationMarkerPath(root));
  } catch {
    return false;
  }
}

/** Write a cancellation marker for `root`, creating the state dir if needed. */
export function writeCancellationMarker(
  root: string,
  taskId: string,
  now: Date = new Date()
): CancellationMarker {
  const marker: CancellationMarker = { taskId, cancelledAt: now.toISOString() };
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(cancellationMarkerPath(root), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  return marker;
}

/** Clear the cancellation marker for `root`. Idempotent — a missing file is fine. */
export function clearCancellationMarker(root: string): void {
  try {
    fs.unlinkSync(cancellationMarkerPath(root));
  } catch {
    // already absent — nothing to clear
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- cancellationMarker && bun run typecheck` → PASS.

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS (no consumers yet; the tree Playwright set is a regression check).

- [ ] **Step 6: Commit**

```bash
git add src/core/cancellationMarker.ts src/test/unit/cancellationMarker.test.ts
git commit --no-verify -m "feat(tree P5): cancellationMarker core (presence-only, mirrors activeTask)

- src/core/cancellationMarker.ts: <root>/.taskwright/cancelled writer/reader/clearer,
  mirroring activeTask.ts (mkdir-on-write, never-throws) with PRESENCE-ONLY detection
  (isCancelled never parses the file; the JSON taskId is human/debug legibility only)
- unit tests: write->present, clear->absent, idempotent, never-throws on a missing root,
  and presence-only holds even for non-JSON contents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none (leaf core).

---

## Task 2: `cancelDispatch` marker-first order + dep + extension wiring + GAP-8 reword [opus]

**Model:** Opus (integration/wiring: extension.ts closure, reordered/extended tests, ordering-correctness reasoning).

**Files:**

- Modify: `src/core/cancelDispatch.ts`, `src/extension.ts`
- Test: `src/test/unit/cancelDispatch.test.ts`

**Goal (GAP-1, GAP-4, GAP-8):** the marker write must be the **first** side effect of `cancelDispatch`, not an afterthought. `removeWorktree` runs `git worktree remove --force` then `prune`, swallowing errors (`finishTask.ts:209-224`); `--force` sweeps the whole dir including the git-ignored `.taskwright/`. If the marker were written **after** a successful removal, its `mkdirSync` would **resurrect** `.worktrees/<branch>/.taskwright/` — and the next dispatch's `createWorktree` sees `pathExists ⇒ created:false ⇒ SKIPS git worktree add` (`WorktreeService.ts:74-79`), running the agent in a plain dir that git resolves up to the **primary** tree (isolation silently lost). So lock the order to `marker → releaseClaim → setStatus → removeWorktree → disposeTerminal`. The pure core gains a `writeCancellationMarker` dep; the extension threads the **absolute** `worktreePathFor(repoRoot, branch)` into it. Also **reword the stale GAP-8 TODO** at `cancelDispatch.ts:42-49` (the marker now lands; record that `dispatched_at` is deliberately NOT added, and correct the "prune reclaims" record — a Windows live-agent cancel LEAKS the worktree until re-dispatch reuses it, because `git worktree prune` only deregisters worktrees whose dir is already missing and `cancelDispatch` fires once).

- [ ] **Step 1: Rewrite the failing tests**

Replace the whole body of `src/test/unit/cancelDispatch.test.ts` with (reordered order assertion + `writeCancellationMarker` dep on both cases + a real-marker/Windows-busy survival case):

```ts
import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { cancelDispatch } from '../../core/cancelDispatch';
import {
  writeCancellationMarker,
  cancellationMarkerPath,
  isCancelled,
} from '../../core/cancellationMarker';

describe('cancelDispatch', () => {
  it('writes the marker, releases the claim, resets status, removes the worktree, disposes the terminal — in order', async () => {
    const calls: string[] = [];
    const deps = {
      writeCancellationMarker: vi.fn((_id: string) => {
        calls.push('marker');
      }),
      releaseClaim: vi.fn(async () => {
        calls.push('release');
      }),
      setStatus: vi.fn(async (_id: string, _status: string) => {
        calls.push('status');
      }),
      removeWorktree: vi.fn(async (_rel: string) => {
        calls.push('worktree');
      }),
      disposeTerminal: vi.fn((_name: string) => {
        calls.push('terminal');
      }),
    };
    await cancelDispatch(deps, {
      taskId: 'TASK-7',
      branch: 'task-7-thing',
      toDoStatus: 'To Do',
      terminalName: 'Taskwright TASK-7',
    });
    expect(calls).toEqual(['marker', 'release', 'status', 'worktree', 'terminal']);
    expect(deps.writeCancellationMarker).toHaveBeenCalledWith('TASK-7');
    expect(deps.releaseClaim).toHaveBeenCalledWith('TASK-7');
    expect(deps.setStatus).toHaveBeenCalledWith('TASK-7', 'To Do');
    expect(deps.removeWorktree).toHaveBeenCalledWith('.worktrees/task-7-thing');
    expect(deps.disposeTerminal).toHaveBeenCalledWith('Taskwright TASK-7');
  });

  it('is best-effort: a failing step does not abort the remaining cleanup', async () => {
    const deps = {
      writeCancellationMarker: vi.fn(() => {}),
      releaseClaim: vi.fn(async () => {
        throw new Error('release boom');
      }),
      setStatus: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      disposeTerminal: vi.fn(() => {}),
    };
    await expect(
      cancelDispatch(deps, {
        taskId: 'TASK-1',
        branch: 'b',
        toDoStatus: 'To Do',
        terminalName: 'Taskwright TASK-1',
      })
    ).resolves.toBeUndefined();
    expect(deps.setStatus).toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalled();
    expect(deps.disposeTerminal).toHaveBeenCalled();
  });

  it('writes the real marker into the worktree .taskwright/ BEFORE removal, and it survives a Windows-busy removal failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cancel-'));
    const branch = 'task-7-thing';
    const worktreeRoot = path.join(root, '.worktrees', branch);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const order: string[] = [];
    try {
      await cancelDispatch(
        {
          // Wire the REAL marker core against the real worktree dir.
          writeCancellationMarker: (id) => {
            writeCancellationMarker(worktreeRoot, id);
            order.push('marker');
          },
          releaseClaim: async () => {
            order.push('release');
          },
          setStatus: async () => {
            order.push('status');
          },
          // Simulate a Windows-busy removal that FAILS — the marker must already be on disk.
          removeWorktree: async () => {
            order.push('worktree');
            throw new Error('EBUSY: worktree locked by a live process');
          },
          disposeTerminal: () => {
            order.push('terminal');
          },
        },
        { taskId: 'TASK-7', branch, toDoStatus: 'To Do', terminalName: 'Taskwright TASK-7' }
      );
      // Marker is written first (index 0) and best-effort continues past the removal failure.
      expect(order).toEqual(['marker', 'release', 'status', 'worktree', 'terminal']);
      // Marker survives the failed teardown (written before removeWorktree ran).
      expect(fs.existsSync(cancellationMarkerPath(worktreeRoot))).toBe(true);
      expect(isCancelled(worktreeRoot)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
```

> Falsification: if an implementer reorders the marker after `removeWorktree`, `order[0]` is `'release'` (or the marker file is written into a resurrected dir after removal) — both assertions fail. The best-effort case proves the marker dep is required by the type (TS errors if omitted) and that a mid-chain throw does not abort.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- cancelDispatch`
Expected: FAIL — `CancelDispatchDeps` has no `writeCancellationMarker`, and the current order is `['release','status','worktree','terminal']`.

- [ ] **Step 3: Add the dep + marker-first order to `src/core/cancelDispatch.ts`**

Replace the `CancelDispatchDeps` interface (`cancelDispatch.ts:8-13`):

```ts
export interface CancelDispatchDeps {
  releaseClaim: (taskId: string) => Promise<void>;
  setStatus: (taskId: string, status: string) => Promise<void>;
  removeWorktree: (worktreeRelPath: string) => Promise<void>;
  disposeTerminal: (terminalName: string) => void;
}
```

with:

```ts
export interface CancelDispatchDeps {
  /** Write the task/worktree-scoped cancellation marker into the worktree's `.taskwright/`.
   *  Invoked FIRST, before any teardown — the ordering is load-bearing (see cancelDispatch). */
  writeCancellationMarker: (taskId: string) => void;
  releaseClaim: (taskId: string) => Promise<void>;
  setStatus: (taskId: string, status: string) => Promise<void>;
  removeWorktree: (worktreeRelPath: string) => Promise<void>;
  disposeTerminal: (terminalName: string) => void;
}
```

Then replace the `cancelDispatch` body + trailing TODO (`cancelDispatch.ts:33-50`):

```ts
export async function cancelDispatch(
  deps: CancelDispatchDeps,
  input: CancelDispatchInput
): Promise<void> {
  await attempt(() => deps.releaseClaim(input.taskId));
  await attempt(() => deps.setStatus(input.taskId, input.toDoStatus));
  await attempt(() => deps.removeWorktree(`.worktrees/${input.branch}`));
  await attempt(() => deps.disposeTerminal(input.terminalName));

  // TODO(P5): write a task/worktree-scoped cancellation marker that the dispatched
  // agent detects at its next checkpoint (the P5 cancellation-signal protocol — see
  // the P5 spec §6). P2 only tears down local state; it does not signal a live agent.
  //
  // Q2 (adjudicated, v1): "dispatched/agent" is inferred from the `worktree` claim
  // field — a human claiming from a worktree, or a dispatched-but-unclaimed task, are
  // accepted edge cases for v1. A firmer marker (`dispatched_at` frontmatter) lands
  // with this P5 cancellation protocol, not now.
}
```

with:

```ts
export async function cancelDispatch(
  deps: CancelDispatchDeps,
  input: CancelDispatchInput
): Promise<void> {
  // Marker FIRST — the order is load-bearing (see the block comment below).
  await attempt(() => deps.writeCancellationMarker(input.taskId));
  await attempt(() => deps.releaseClaim(input.taskId));
  await attempt(() => deps.setStatus(input.taskId, input.toDoStatus));
  await attempt(() => deps.removeWorktree(`.worktrees/${input.branch}`));
  await attempt(() => deps.disposeTerminal(input.terminalName));

  // Ordering rationale (P5, GAP-1): the marker is written before removeWorktree, never
  // after. removeWorktree runs `git worktree remove --force` (finishTask.ts:209-224),
  // which sweeps the whole dir including the git-ignored `.taskwright/`. Writing the
  // marker AFTER a successful removal would resurrect `.worktrees/<branch>/.taskwright/`
  // via mkdirSync — and the next dispatch's createWorktree sees the dir exists, SKIPS
  // `git worktree add` (WorktreeService.ts:74-79), and runs the agent in a plain dir git
  // resolves up to the PRIMARY tree (isolation silently defeated).
  //
  // Detection (P5, GAP-2) is presence-only (src/core/cancellationMarker.ts) and co-equal
  // with the worktree-vanished backstop: on POSIX `git worktree remove --force` unlinks
  // the busy dir and DELETES the marker, so the vanished worktree is the only signal
  // there; on Windows a busy removal may leave the marker AND LEAK the worktree — a
  // single cancelDispatch call does not `prune`-reclaim it (`git worktree prune` only
  // deregisters worktrees whose directory is already missing). The self-heal is the next
  // dispatch of the same task, which reuses the dir after clearing the stale marker
  // (dispatchActions clearCancellationMarker, GAP-3).
  //
  // We deliberately do NOT add a `dispatched_at` frontmatter field (GAP-8): teardown
  // derives the worktree path from the task id (extension wiring: worktreePathFor +
  // dispatchBranchName), so it would buy zero cancellation-correctness and only add
  // Backlog.md byte-compat surface. The Cancel-dispatch affordance is gated on
  // worktree-dir existence (TasksController `dispatchedWorktree`), not the claim field.
}
```

- [ ] **Step 4: Wire the marker into `src/extension.ts`**

Add the marker import near the other core imports (after `import { cancelDispatch } from './core/cancelDispatch';` at `extension.ts:23`):

```ts
import { writeCancellationMarker } from './core/cancellationMarker';
```

Change the `WorktreeService` import (`extension.ts:26`) from:

```ts
import type { GitExecFn } from './core/WorktreeService';
```

to (bring in the path helper as a value):

```ts
import { worktreePathFor, type GitExecFn } from './core/WorktreeService';
```

In the `taskwright.cancelDispatch` command, add the `writeCancellationMarker` closure as the **first** dep. Replace the `cancelDispatch(...)` call (`extension.ts:1157-1166`):

```ts
      await cancelDispatch(
        {
          releaseClaim: (id) => releaseTaskClaim(id, activeParser),
          setStatus: (id, status) => writer.updateTask(id, { status }, activeParser),
          removeWorktree: (rel) => removeWorktree(exec, repoRoot, rel),
          disposeTerminal: (name) =>
            vscode.window.terminals.find((t) => t.name === name)?.dispose(),
        },
        { taskId, branch, toDoStatus: toDo, terminalName: `Taskwright ${taskId}` }
      );
```

with:

```ts
      await cancelDispatch(
        {
          // Absolute worktree root so the marker lands in .worktrees/<branch>/.taskwright/.
          writeCancellationMarker: (id) =>
            writeCancellationMarker(worktreePathFor(repoRoot, branch), id),
          releaseClaim: (id) => releaseTaskClaim(id, activeParser),
          setStatus: (id, status) => writer.updateTask(id, { status }, activeParser),
          removeWorktree: (rel) => removeWorktree(exec, repoRoot, rel),
          disposeTerminal: (name) =>
            vscode.window.terminals.find((t) => t.name === name)?.dispose(),
        },
        { taskId, branch, toDoStatus: toDo, terminalName: `Taskwright ${taskId}` }
      );
```

> `repoRoot` (`extension.ts:1150`) and `branch` (`:1147`) are already in scope. The object KEY `writeCancellationMarker` does not shadow the imported binding — the RHS `writeCancellationMarker(...)` resolves to the import.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test -- cancelDispatch && bun run typecheck` → PASS (typecheck catches any missed dep site).

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/cancelDispatch.ts src/extension.ts src/test/unit/cancelDispatch.test.ts
git commit --no-verify -m "feat(tree P5): cancelDispatch writes the marker FIRST (GAP-1/4/8)

- CancelDispatchDeps gains writeCancellationMarker; order locked to
  marker -> releaseClaim -> setStatus -> removeWorktree -> disposeTerminal so a
  --force worktree removal can't resurrect .taskwright/ and defeat isolation on the
  next dispatch
- extension wires the absolute worktreePathFor(repoRoot, branch) into the marker dep
- reword the stale TODO: marker IS the signal (presence-only, co-equal with the
  vanished-worktree backstop); Windows live-agent cancel leaks the worktree until
  re-dispatch reuses it (prune only deregisters missing dirs); no dispatched_at
- tests: reordered order assertion, marker dep on both cases, real-marker path +
  Windows-busy survival

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** Task 1 (imports `writeCancellationMarker`).

---

## Task 3: Dispatch clears a stale cancellation marker on seed (GAP-3) [opus]

**Model:** Opus (provider glue + a new vscode-mock/config-mock test — judgment on the harness).

**Files:**

- Modify: `src/providers/dispatchActions.ts`
- Test: `src/test/unit/dispatchActions.test.ts` (new)

**Goal (GAP-3):** branch names are deterministic per task (`dispatchBranchName`), and `createWorktree` reuses an existing dir as-is (`WorktreeService.ts:74-75`). A leftover `.taskwright/cancelled` from a prior (leaked) Windows cancel survives into the **next** dispatch of the same task and would insta-abort the fresh `/execute-task` at its first checkpoint. Fix (belt-and-suspenders): in `dispatchTask`, call `clearCancellationMarker(sessionRoot)` immediately after `writeActiveTask(sessionRoot, taskId)` (`dispatchActions.ts:114`). Cover with a provider test asserting a pre-existing marker is gone after dispatch and the active task was seeded.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/dispatchActions.test.ts`. The vitest config aliases `vscode` to `src/test/mocks/vscode.ts` (which exposes `env.clipboard.writeText`, `window.showWarningMessage`, etc.); mock `../../config` to force `dispatchCreateWorktree:false` so no git runs (session root falls back to the repo root — the temp dir):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  writeCancellationMarker,
  cancellationMarkerPath,
  isCancelled,
} from '../../core/cancellationMarker';
import { activeTaskPath } from '../../core/activeTask';
import type { BacklogParser } from '../../core/BacklogParser';
import type { Task } from '../../core/types';

// Force worktree creation OFF so dispatch seeds into the repo root (the temp dir) with no git.
vi.mock('../../config', () => ({
  getTaskwrightConfig: (key: string, dflt: unknown) =>
    key === 'dispatchCreateWorktree' ? false : dflt,
}));

// Imported AFTER the mock so dispatchActions picks up the mocked config.
import { dispatchTask } from '../../providers/dispatchActions';

let root: string, backlogPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-dispatch-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(backlogPath, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal parser: getTask returns the task; getBacklogPath sets the session root.
 *  loadTreeStateFromParser calls other getters and THROWS on this stub — dispatchTask's
 *  gate is wrapped in a fail-open try/catch, so dispatch proceeds regardless. */
function stubParser(task: Task): BacklogParser {
  return {
    getTask: async () => task,
    getBacklogPath: () => backlogPath,
  } as unknown as BacklogParser;
}
const makeTask = (): Task =>
  ({
    id: 'TASK-7',
    title: 'Thing',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: path.join(backlogPath, 'tasks', 'task-7 - Thing.md'),
  }) as Task;

describe('dispatchTask — clears a stale cancellation marker on seed (GAP-3)', () => {
  it('removes a pre-existing .taskwright/cancelled and seeds the active task', async () => {
    // A leftover marker from a prior (leaked) cancel at the session root.
    writeCancellationMarker(root, 'TASK-7');
    expect(isCancelled(root)).toBe(true);

    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(result!.sessionRoot).toBe(root); // no worktree → repo root

    expect(fs.existsSync(cancellationMarkerPath(root))).toBe(false); // stale marker cleared
    expect(fs.existsSync(activeTaskPath(root))).toBe(true); // active task seeded
  });

  it('positive control: a dispatch with no prior marker leaves none', async () => {
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(isCancelled(root)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- dispatchActions`
Expected: FAIL — dispatch writes the active task but does NOT clear the marker, so `.taskwright/cancelled` still exists.

> If the run errors on a missing vscode-mock member (e.g. `createTerminal`), that member is only reached when `openTerminal && worktreePath` — both false here — so it should not be hit; if it is, add a no-op to `src/test/mocks/vscode.ts` (`window.createTerminal`). The mock already provides `env.clipboard.writeText` and `window.showWarningMessage`.

- [ ] **Step 3: Clear the stale marker in `dispatchActions.ts`**

Add the import (after `import { writeActiveTask } from '../core/activeTask';` at `dispatchActions.ts:6`):

```ts
import { clearCancellationMarker } from '../core/cancellationMarker';
```

Then, in `dispatchTask`, replace the seed line (`dispatchActions.ts:112-114`):

```ts
  // Mark the task active for the session root so the MCP get_active_task resolves
  // it, then render + persist the paste-ready prompt.
  writeActiveTask(sessionRoot, taskId);
```

with:

```ts
  // Mark the task active for the session root so the MCP get_active_task resolves
  // it, then render + persist the paste-ready prompt. Clear any stale cancellation
  // marker left by a prior (leaked) cancel of the SAME task (deterministic branch =>
  // reused worktree dir) so this fresh /execute-task does not insta-abort (GAP-3).
  writeActiveTask(sessionRoot, taskId);
  clearCancellationMarker(sessionRoot);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- dispatchActions && bun run typecheck` → PASS.

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/dispatchActions.ts src/test/unit/dispatchActions.test.ts
git commit --no-verify -m "feat(tree P5): dispatch clears a stale cancellation marker on seed (GAP-3)

- dispatchTask calls clearCancellationMarker(sessionRoot) right after writeActiveTask so a
  leftover .taskwright/cancelled from a prior (leaked) cancel of the same task can't
  insta-abort the fresh /execute-task (deterministic branch => reused worktree dir)
- new provider test (vscode-mock + config-mock forcing dispatchCreateWorktree:false):
  stale marker gone + active task seeded after dispatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** Task 1 (imports `clearCancellationMarker`).

---

## Task 4: Dispatch template repoint to `/execute-task` (GAP-9) [opus]

**Model:** Opus (judgment: preserve every guardrail, migrate prose into the skill without loss, fix the three existing assertions).

**Files:**

- Modify: `src/core/dispatchPrompt.ts`
- Test: `src/test/unit/dispatchPrompt.test.ts`

**Goal (GAP-9):** `DEFAULT_DISPATCH_TEMPLATE` inlines the full workflow and never mentions `/execute-task` (`dispatchPrompt.ts:34-51`); the same rendered prompt is written to the handoff file (`dispatchActions.ts:117-119`), so the handoff stays in sync automatically when only the default constant changes. Repoint the default to instruct **"launch this session inside `.worktrees/{{worktree}}` and run `/execute-task`"** while KEEPING the worktree-location, `bun install`, no-root-commit, and subscription-safety lines. The removed inline workflow prose migrates **into** SKILL.md (Task 7). Users with a custom `taskwright.dispatchTemplate` setting won't pick up the change (only the default moves) — documented in the CLAUDE.md P5 bullet (Task 8).

- [ ] **Step 1: Adjust the failing tests**

In `src/test/unit/dispatchPrompt.test.ts`, make these edits.

(a) In the `renderDispatchPrompt` "substitutes every known placeholder" test, change the `claim_task` assertion (`dispatchPrompt.test.ts:112`) — the new template names `get_active_task` and `/execute-task` (which claims for you), not `claim_task` literally:

```ts
    expect(out).toContain('get_active_task');
    expect(out).toContain('claim_task');
```

→

```ts
    expect(out).toContain('get_active_task');
    expect(out).toContain('/execute-task');
```

(b) Replace the `DEFAULT_DISPATCH_TEMPLATE worktree isolation` first test (`dispatchPrompt.test.ts:151-155`) — the template now says LAUNCH inside, not "cd into it":

```ts
  it('tells the session to cd into and stay in its worktree', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('.worktrees/{{worktree}}');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('cd into it');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('repository root');
  });
```

→

```ts
  it('tells the session to LAUNCH inside its worktree (not cd from the root)', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('.worktrees/{{worktree}}');
    expect(DEFAULT_DISPATCH_TEMPLATE).toMatch(/launch this session inside/i);
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('repository root');
  });
```

(c) In the `DEFAULT_DISPATCH_TEMPLATE closing step` test (`dispatchPrompt.test.ts:196-201`), the "wait for it to return" detail now lives in the skill; assert the closing guardrail instead:

```ts
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('request_merge');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('wait for it to return');
```

→

```ts
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('request_merge');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('from inside your worktree');
```

(d) Append a new GAP-9 describe (at the end of the file):

```ts
describe('DEFAULT_DISPATCH_TEMPLATE — /execute-task repoint (P5, GAP-9)', () => {
  it('instructs the session to run /execute-task', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('/execute-task');
  });

  it('names the adaptive strategies so the skill choice is transparent', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toMatch(/executing-plans/);
    expect(DEFAULT_DISPATCH_TEMPLATE).toMatch(/subagent-driven-development/);
    expect(DEFAULT_DISPATCH_TEMPLATE).toMatch(/test-driven-development/);
  });

  it('keeps the subscription-safety + bun install + no-root-commit guardrails', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toMatch(/subscription-safe/i);
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('bun install');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('node_modules');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('repository root');
  });
});
```

> The existing `bun install` isolation test (`dispatchPrompt.test.ts:157-160`) stays green unchanged. The `renderDispatchPrompt` "no leftover `{{\w+}}`" assertion stays green — the new template uses only the same placeholders (`{{worktree}}`/`{{id}}`/`{{title}}`/`{{status}}`/`{{priority}}`/`{{labels}}`/`{{description}}`/`{{acceptanceCriteria}}`/`{{plan}}`), all substituted by `dispatchContextFromTask`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- dispatchPrompt`
Expected: FAIL — the current template lacks `/execute-task`, "launch this session inside", the strategy names, and "from inside your worktree"; it still contains "cd into it" / "wait for it to return".

- [ ] **Step 3: Repoint `DEFAULT_DISPATCH_TEMPLATE`**

In `src/core/dispatchPrompt.ts`, replace the `DEFAULT_DISPATCH_TEMPLATE` const (`dispatchPrompt.ts:34-51`) with:

```ts
export const DEFAULT_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

Launch this session INSIDE your isolated worktree .worktrees/{{worktree}} — open that folder / start the session with it as the working directory. Do NOT start at the repository root and cd in: the taskwright MCP server roots itself at the directory the session launched in, and an in-session cd does not move it. A fresh worktree has no node_modules (it is git-ignored), so run \`bun install\` there once before you build or test. Do NOT git checkout, commit, or merge in the repository root — that tree is shared with other agents and committing there corrupts their branches.

Task {{id}}: {{title}}
Status: {{status}} · Priority: {{priority}} · Labels: {{labels}}

## Description
{{description}}

## Acceptance Criteria
{{acceptanceCriteria}}

## Implementation Plan
{{plan}}

---
Run the \`/execute-task\` skill. It loads your assignment (\`get_active_task\`), verifies you are worktree-rooted and installs deps, claims the task, executes with the right strategy (attached plan → executing-plans; independent subtasks → subagent-driven-development; else test-driven-development), records progress with \`edit_task\`, checks for cancellation, and closes with \`request_merge\` from inside your worktree. It is subscription-safe (in-session; never \`claude -p\`). If \`/execute-task\` is unavailable, follow the project's TDD / superpowers workflow by hand and close with \`request_merge\` (taskwright MCP) from inside your worktree.`;
```

> No change to `dispatchActions.ts` is needed: it renders `settings.template` (default = this constant) into both the clipboard prompt and the handoff file (`dispatchActions.ts:117-119`), so the handoff stays byte-for-byte in sync. The subscription-safety guarantee is unchanged — dispatch still copies a prompt and never spawns `claude -p`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- dispatchPrompt && bun run typecheck` → PASS.

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/dispatchPrompt.ts src/test/unit/dispatchPrompt.test.ts
git commit --no-verify -m "feat(tree P5): repoint dispatch template at /execute-task (GAP-9)

- DEFAULT_DISPATCH_TEMPLATE now says LAUNCH the session inside .worktrees/{{worktree}} and
  run /execute-task (roots the MCP correctly), naming the adaptive strategies; the inline
  workflow prose moves into the skill
- keeps every guardrail: worktree location, bun install/node_modules, no-root-commit,
  subscription-safety, request_merge from the worktree; handoff render stays in sync
  (same constant); custom taskwright.dispatchTemplate users are unaffected (default only)
- tests: /execute-task + strategy-name + guardrail assertions; adjusted the cd/wait prose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none (the template references `/execute-task`, which Task 7 authors; the skill is auto-discovered and the template's fallback line covers its absence). Order after Tasks 1–3 for a clean history, but no hard dependency.

---

## Task 5: `toSummary` surfaces `subtasks` + `parentTaskId` (GAP-5 data) [opus]

**Model:** Opus (MCP contract surface; small but the active-task view feeds the skill's SDD branch).

**Files:**

- Modify: `src/mcp/handlers.ts`
- Test: `src/test/unit/toSummary.test.ts` (new)

**Goal (GAP-5):** the skill's middle adaptive branch (independent subtasks ⇒ `subagent-driven-development`) is currently **dead code** — `TaskSummary` omits `subtasks` and `parentTaskId` (`handlers.ts:115-144`, `toSummary` `:359-385`) though `Task.subtasks?: string[]` and `Task.parentTaskId?` exist (`types.ts:72,:84`). So `get_active_task` can't tell the skill a task has subtasks and the SDD branch can never fire. Surface both (one field each — parity: the active-task view should reflect the task). The skill then judges independence by fetching the subtask rows via `get_board` (GAP-5, encoded in SKILL.md).

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/toSummary.test.ts` (`toSummary` reads fs only when `task.plan` is set — leave it unset, so no fs mock is needed):

```ts
import { describe, it, expect } from 'vitest';
import { toSummary } from '../../mcp/handlers';
import type { Task } from '../../core/types';

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'TASK-5',
    title: 'Parent',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/b/tasks/TASK-5 - Parent.md',
    ...over,
  } as Task;
}

describe('toSummary — subtasks + parentTaskId (GAP-5)', () => {
  it('surfaces subtasks when present', () => {
    const s = toSummary(makeTask({ subtasks: ['TASK-5.1', 'TASK-5.2'] }), '/b');
    expect(s.subtasks).toEqual(['TASK-5.1', 'TASK-5.2']);
  });

  it('surfaces parentTaskId on a child', () => {
    const s = toSummary(makeTask({ id: 'TASK-5.1', parentTaskId: 'TASK-5' }), '/b');
    expect(s.parentTaskId).toBe('TASK-5');
  });

  it('leaves both undefined on a plain task (negative control)', () => {
    const s = toSummary(makeTask(), '/b');
    expect(s.subtasks).toBeUndefined();
    expect(s.parentTaskId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- toSummary`
Expected: FAIL — `TaskSummary` has no `subtasks`/`parentTaskId`, so the type omits them and the returned object never carries them.

- [ ] **Step 3: Add the fields to `TaskSummary` + `toSummary`**

> **M1 (MAJOR — anchor non-uniqueness, do NOT use single-line anchors):** `handlers.ts` has `dependencies: string[];` at BOTH the `TaskSummary` interface (:137) AND the `get_board` row interface (:648), and `dependencies: task.dependencies,` at BOTH `toSummary` (:378) AND the `get_board` mapper (:685). A single-line anchor would hit the wrong site / error as non-unique. Use the **two-line unique anchors** below (verified at `dd5e4e2`): the `TaskSummary` interface pairs `dependencies: string[];` with `locked?: boolean;` (the get_board row pairs it with `blockedBy`), and `toSummary` pairs `dependencies: task.dependencies,` with `locked: derived?.locked,` (the get_board mapper pairs it with `blockedBy`).

In `src/mcp/handlers.ts`, add the two fields to the `TaskSummary` interface, matching the unique two-line anchor `dependencies: string[];` + `locked?: boolean;` (`handlers.ts:137-138`):

```ts
  dependencies: string[];
  locked?: boolean;
```

→

```ts
  dependencies: string[];
  /** IDs of subtask children (drives the skill's independent-subtasks execution branch). */
  subtasks?: string[];
  /** Parent task ID when this is a subtask. */
  parentTaskId?: string;
  locked?: boolean;
```

Then in `toSummary`, add both to the returned object, matching the unique two-line anchor `dependencies: task.dependencies,` + `locked: derived?.locked,` (`handlers.ts:378-379`):

```ts
    dependencies: task.dependencies,
    locked: derived?.locked,
```

→

```ts
    dependencies: task.dependencies,
    subtasks: task.subtasks,
    parentTaskId: task.parentTaskId,
    locked: derived?.locked,
```

> `toSummary` is used by `getActiveTask` (`handlers.ts:392+`) and the claim/read handlers, so `get_active_task` now reflects subtasks/parent. No other change — `Task.subtasks`/`parentTaskId` already parse from frontmatter.

- [ ] **Step 4: Run tests + typecheck + build**

Run: `bun run test -- toSummary && bun run typecheck && bun run build` → PASS (rebuild the MCP bundle so the surface compiles; not live in the worktree until merged — primary-build caveat).

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/toSummary.test.ts
git commit --no-verify -m "feat(tree P5): get_active_task summary surfaces subtasks + parentTaskId (GAP-5)

- TaskSummary + toSummary carry subtasks/parentTaskId so /execute-task can detect the
  independent-subtasks branch (previously dead: the SDD strategy could never fire)
- toSummary unit test (subtasks present, parentTaskId on a child, undefined on a plain task)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none.

---

## Task 6: Cancel-dispatch affordance — `dispatchedWorktree` enrichment + popover gate (GAP-7) [opus]

**Model:** Opus (Svelte + controller enrichment + Playwright + the run's full-Playwright/full-CDP binding — highest cross-view risk).

**Files:**

- Modify: `src/core/types.ts`, `src/providers/TasksController.ts`, `src/webview/components/tree/DetailPopover.svelte`
- Test: `src/test/unit/TasksController.test.ts`, `e2e/tree-popover.spec.ts`

**Goal (GAP-7):** the popover gates "Cancel dispatch" on `inProgress && hasWorktree`, where `hasWorktree = !!task.worktree` = the CLAIM frontmatter field (`DetailPopover.svelte:50,77-78`). Dispatch writes active-task + handoff but NOT a claim (`dispatchActions.ts:114-119`), so `task.worktree` is empty until the agent runs `claim_task`. A dispatched-but-unclaimed (or claim-released-but-worktree-remaining) in-progress task therefore offers **no** Cancel-dispatch button, leaving its worktree un-teardownable from the board — the exact window P2b hedged with `dispatched_at`. Close it **without new frontmatter**: the `TasksController` tree-tab enrichment computes `dispatchedWorktree = fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)))` and the popover shows Cancel-dispatch when `inProgress && (dispatchedWorktree || hasWorktree)`.

- [ ] **Step 1: Write the failing tests**

**6a — `TasksController.test.ts` (enrichment).** Add a case proving `dispatchedWorktree` reflects worktree-dir existence, in tree mode. Spy `fs.existsSync` so only the task's worktree path resolves true (delegating to the real impl for every other path, so config/queue reads are unaffected — do NOT `vi.mock('fs')`):

```ts
import * as fs from 'fs';
// ... inside the describe block near the other tree-mode cases:

describe('TasksController — dispatchedWorktree enrichment (GAP-7)', () => {
  it('flags dispatchedWorktree when the task worktree dir exists, in the tree tab', async () => {
    const realExists = fs.existsSync.bind(fs);
    const spy = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p: fs.PathLike) =>
        String(p).includes('task-9-dispatched') ? true : realExists(p as string)
      );
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'TASK-9', title: 'Dispatched', status: 'In Progress', folder: 'tasks',
        labels: [], assignee: [], dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-9.md' },
      { id: 'TASK-8', title: 'Other', status: 'In Progress', folder: 'tasks',
        labels: [], assignee: [], dependencies: [], acceptanceCriteria: [], definitionOfDone: [],
        filePath: '/fake/backlog/tasks/task-8.md' },
    ]);
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('tree');
    await controller.refresh();
    const msg = posted.find((m) => m.type === 'tasksUpdated');
    const rows = msg!.tasks as Array<Task & { dispatchedWorktree?: boolean }>;
    const t9 = rows.find((t) => t.id === 'TASK-9')!;
    const t8 = rows.find((t) => t.id === 'TASK-8')!;
    expect(t9.dispatchedWorktree).toBe(true); // .worktrees/task-9-dispatched exists
    expect(t8.dispatchedWorktree).toBe(false); // no worktree dir for task-8-other
    spy.mockRestore();
  });
});
```

> `dispatchBranchName({id:'TASK-9', title:'Dispatched'})` = `task-9-dispatched`; `mockParser.getBacklogPath()` returns `/fake/backlog` so `repoRoot = /fake` and `worktreePathFor('/fake','task-9-dispatched')` contains `task-9-dispatched`. Ensure `mockParser.getConfig()` does NOT set `check_active_branches` (the default `local-only` mode is required so tree derivation + the union run). Match the file's existing tree-mode idioms (grep other `setViewMode('tree')` cases).

**6b — `e2e/tree-popover.spec.ts` (the affordance).** Append two tests to the `Tree detail popover` describe. Post a custom in-progress task with `dispatchedWorktree:true` but no claim, and assert Cancel-dispatch shows and posts `cancelDispatch`; then a negative (no worktree dir, no claim → the affordance is absent):

```ts
  test('a dispatched-but-unclaimed in-progress task offers Cancel dispatch (GAP-7)', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'TASK-9', title: 'Dispatched unclaimed', status: 'In Progress',
          category: 'Misc', milestone: 'v1', labels: [], assignee: [], dependencies: [],
          acceptanceCriteria: [], definitionOfDone: [],
          dispatchedWorktree: true, // worktree dir exists; no claim `worktree` field
          layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
          filePath: '/b/tasks/task-9.md',
        },
      ],
    });
    await page.waitForTimeout(150);
    await page.locator('[data-testid="tree-node-TASK-9"]').click();
    await expect(page.locator('[data-testid="tp-action-cancelDispatch"]')).toBeVisible();
    await page.locator('[data-testid="tp-action-cancelDispatch"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({ type: 'cancelDispatch', taskId: 'TASK-9' });
  });

  test('an in-progress task with no worktree dir and no claim does NOT offer Cancel dispatch (GAP-7 negative)', async ({ page }) => {
    await postMessageToWebview(page, {
      type: 'tasksUpdated',
      tasks: [
        {
          id: 'TASK-9', title: 'In progress no wt', status: 'In Progress',
          category: 'Misc', milestone: 'v1', labels: [], assignee: [], dependencies: [],
          acceptanceCriteria: [], definitionOfDone: [],
          layout: { lane: 'Misc', band: 'v1', depth: 0, subRow: 0 },
          filePath: '/b/tasks/task-9.md',
        },
      ],
    });
    await page.waitForTimeout(150);
    await page.locator('[data-testid="tree-node-TASK-9"]').click();
    await expect(page.locator('[data-testid="tp-action-cancelDispatch"]')).toHaveCount(0);
  });
```

> `laneOrder` in this spec already includes `Misc` and `bandOrder` includes `v1`, so the node renders. Action buttons use `data-testid="tp-action-<kind>"` (established by the sibling tests). The negative task (In Progress, unclaimed, no worktree, no `dispatchedWorktree`) falls through the popover gate to the final Claim+Dispatch branch — so no Cancel-dispatch button — the falsification path.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- TasksController` (FAIL — `dispatchedWorktree` not set) and `bun run test:playwright -- tree-popover` (FAIL — the gate still requires `hasWorktree`, so the dispatched-but-unclaimed task shows no Cancel-dispatch).

- [ ] **Step 3: Add `dispatchedWorktree` to the `Task` type**

In `src/core/types.ts`, add the field to the board-bus enrichment block, after `claimedByMe?: boolean;` (`types.ts:112`):

```ts
  /** Board-bus enrichment: true when `claimedBy` equals the current claim identity. */
  claimedByMe?: boolean;
```

→

```ts
  /** Board-bus enrichment: true when `claimedBy` equals the current claim identity. */
  claimedByMe?: boolean;
  /** Board-bus enrichment (tree tab): true when this task's dispatch worktree dir exists
   *  on disk, so Cancel-dispatch is offered even before the agent writes a claim (GAP-7). */
  dispatchedWorktree?: boolean;
```

> The webview `Task` re-exports `core/types` (`src/webview/lib/types.ts:21,:40`), so `DetailPopover`'s `PopoverTask = Task & {…}` sees `dispatchedWorktree` with no webview-type edit.

- [ ] **Step 4: Compute `dispatchedWorktree` in the controller enrichment**

In `src/providers/TasksController.ts`, add the imports (near the existing `dispatchPrompt`/core imports — grep the import block; add `fs` only if absent):

```ts
import * as fs from 'fs';
import { dispatchBranchName } from '../core/dispatchPrompt';
import { worktreePathFor } from '../core/WorktreeService';
```

Add a small helper after `repoRoot` is resolved (`TasksController.ts:318-323`) and **before** the `tasksWithBlocks` map (`:335`):

```ts
      // Cancel-dispatch affordance (GAP-7): a dispatched task's worktree dir may exist on
      // disk before the agent writes a claim (dispatch seeds active-task + handoff, not a
      // claim). Flag it so the popover offers Cancel-dispatch. Tree tab only (the sole
      // consumer); best-effort (a stat failure must not break loading the board).
      const dispatchedWorktreeFor = (task: Task): boolean => {
        if (this.viewMode !== 'tree' || !repoRoot) return false;
        try {
          return fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)));
        } catch {
          return false;
        }
      };
```

Then, in the `tasksWithBlocks` map's object literal, add the field after `mergeState: …,` (`TasksController.ts:351`):

```ts
          mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
```

→

```ts
          mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
          dispatchedWorktree: dispatchedWorktreeFor(task),
```

> `dispatchedWorktree` is now on the core `Task`, so the literal type-checks without touching the local augment union (`TasksController.ts:336-345`). Tree-tab gating keeps kanban/list refreshes free of the per-task `existsSync`.

- [ ] **Step 5: Gate the popover Cancel-dispatch on `dispatchedWorktree || hasWorktree`**

In `src/webview/components/tree/DetailPopover.svelte`, add a derived after `hasWorktree` (`DetailPopover.svelte:50`):

```ts
  const hasWorktree = $derived(!!task.worktree);
```

→

```ts
  const hasWorktree = $derived(!!task.worktree);
  const hasDispatchedWorktree = $derived(task.dispatchedWorktree === true);
```

Then change the Cancel-dispatch gate (`DetailPopover.svelte:77`):

```ts
    if (inProgress && hasWorktree)
      return [{ key: 'cancel', label: 'Cancel dispatch', kind: 'cancelDispatch' }];
```

→

```ts
    if (inProgress && (hasDispatchedWorktree || hasWorktree))
      return [{ key: 'cancel', label: 'Cancel dispatch', kind: 'cancelDispatch' }];
```

> Run the `svelte` MCP `svelte-autofixer` on `DetailPopover.svelte` until clean before committing (a one-line derived + a boolean gate; no new `$state`). No other action branch changes.

- [ ] **Step 6: Build + run the new tests + typecheck**

Run: `bun run build && bun run test -- TasksController toSummary && bun run typecheck` → PASS. Then `bun run test:playwright -- tree-popover` → PASS (the two new cases green; the existing popover cases unaffected).

- [ ] **Step 7: Full task gate + FULL Playwright + FULL CDP (bound here — riskiest webview change)**

Run the full unit + lint + typecheck + **full** Playwright:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Then the **full CDP** suite (this is the only webview/controller change in P5; bind the run's full-CDP gate here per the standing lessons):

```bash
bun run test:cdp
```

Expected: PASS — the existing CDP suites (`cross-view`, `tree-popover`, `tree-authoring`, `tree-reslot`, `tree-promote`) stay green; the popover gate change does not disturb node selection / popover open-close / reslot cross-view. (P5 adds no new CDP file — the affordance is proven by the controller unit test + the Playwright popover touch; port **9345** is reserved should a future CDP popover test be added.)

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/providers/TasksController.ts \
  src/webview/components/tree/DetailPopover.svelte \
  src/test/unit/TasksController.test.ts e2e/tree-popover.spec.ts
git commit --no-verify -m "feat(tree P5): Cancel-dispatch affordance via worktree-dir existence (GAP-7)

- Task.dispatchedWorktree board-bus enrichment; TasksController computes
  fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task))) in the tree tab
- DetailPopover shows Cancel dispatch when inProgress && (dispatchedWorktree || hasWorktree),
  so a dispatched-but-unclaimed task is teardownable from the board (no new frontmatter)
- controller test (spy fs.existsSync) + Playwright popover touch (+ negative); full
  Playwright + full CDP regression bound here (only webview change in P5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none hard (independent seam); run after Tasks 1–5 for clean history. It is the **last** webview/controller change, so the full-CDP run here is the binding one.

---

## Task 7: `.claude/skills/execute-task/SKILL.md` (the skill) [haiku]

**Model:** Haiku (pure transcription — the full SKILL.md is provided verbatim below; no cross-file judgment).

**Files:**

- Create: `.claude/skills/execute-task/SKILL.md`

**Goal (GAP-2/5/6/9 prose):** the skill is P5's user-facing deliverable. It encodes the execution loop (load once → verify worktree-rooted + `bun install` → claim → adaptive execute via the ordered gate → record via `edit_task` → mandatory pre-`request_merge` cancellation checkpoint → `request_merge`), the **ordered adaptive selector** (plan > independent-subtasks > TDD; independence judged via `get_board` rows — GAP-5), the **VERIFY-not-create** step 2 (Bash + `bun install` + stop-if-not-worktree-rooted — GAP-6), the **presence-only-OR-vanished** cancellation contract (GAP-2), and the worktree/no-root-commit/bun-install guardrails migrated out of the dispatch template (GAP-9). It is validated by review + a scenario walkthrough, not a unit test. **[haiku-transcription]** — byte-copy the content below.

- [ ] **Step 1: Create the skill**

Create `.claude/skills/execute-task/SKILL.md` with the exact content below (frontmatter matches the house YAML-fence format of `.claude/skills/create-task/SKILL.md:1-5`):

```markdown
---
name: execute-task
description: Execute a single Taskwright task end-to-end in its isolated worktree — pick the right execution strategy, do the work, record progress, and close through the merge queue. Use when the user says /execute-task, or asks you to "execute", "work on", "do the task", or "run this task" for a task the board dispatched to this session. Subscription-safe: runs in-session, never spawns `claude -p`.
allowed-tools: mcp__taskwright__get_active_task, mcp__taskwright__claim_task, mcp__taskwright__edit_task, mcp__taskwright__request_merge, mcp__taskwright__release_task, mcp__taskwright__get_board, Skill(superpowers:executing-plans), Skill(superpowers:subagent-driven-development), Skill(superpowers:test-driven-development), Bash, Read, Grep, Glob
---

# Execute task (Taskwright)

Execute exactly one Taskwright task from start to merge: load your assignment, confirm you are in
the task's isolated worktree, claim it, do the work with the right execution strategy, record what
you learn, and close through the merge queue with `request_merge`. Parity: every step here is one a
human can drive from the P2 board (Claim / Request merge / Cancel dispatch) — you are automating the
sequence, not bypassing it.

## When to use

- The user invokes `/execute-task`, or asks you to execute / work on / do / run a specific task.
- A dispatch handed this session a task (the dispatch prompt tells you to run `/execute-task`).
- Not for authoring or decomposing new work — that is `/create-task`. This skill *executes* an
  existing task.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any headless
agent. The sub-skills it invokes (`superpowers:executing-plans`, `superpowers:subagent-driven-development`,
`superpowers:test-driven-development`) run in-session and use the Task tool for any subagents — never
`claude -p`. Everything else is the `taskwright` MCP tools plus local Bash/Read/Grep/Glob.

## The loop

1. **Load once.** Call `get_active_task` a single time. Capture the returned **task ID** and its
   full context (description, acceptance criteria, plan link, subtasks). Work from that fixed ID for
   the rest of the session — **never re-read `get_active_task` for your identity or status**: the
   active task is an ephemeral human-focus pointer and may drift to an unrelated task while you work.
   - If `get_active_task` reports no active task, STOP and ask which task to work on (do not guess
     from the file tree).

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

3. **Claim.** Call `claim_task` with your task ID to mark it in progress (advisory — prevents
   cross-worktree collisions). On a synced board a claim may **surrender** if another session already
   holds it; if so, stop and pick a different task with the user.

4. **Execute (adaptive — ordered gate).** Choose the strategy by this precedence, first match wins:
   1. **Attached plan** — the task has a `plan` and its `planProgress.exists` is true ⇒ invoke
      `superpowers:executing-plans` and work the plan's checkboxes.
   2. **Independent subtasks** — the task has `subtasks` AND those subtask rows are mutually
      dependency-free ⇒ invoke `superpowers:subagent-driven-development`. Judge independence by
      fetching the subtask rows with `get_board` and checking that none lists another in-set subtask
      in its `dependencies` / `blockedBy` (if they chain, they are not independent — fall through).
   3. **Otherwise** ⇒ invoke `superpowers:test-driven-development` (write the failing test first,
      then implement).
   Precedence is **plan > independent-subtasks > TDD**.

5. **Record progress.** As you go, use `edit_task` to append implementation notes (decisions,
   surprises) and, when done, a final summary. Do **not** call `complete_task` — `request_merge`
   marks the task Done on the board and leaves it there.

6. **Cancellation checkpoint (mandatory before closing).** Before `request_merge` — and between major
   steps — run the cancellation check (below). If cancelled, **stop; do not `request_merge`**.

7. **Close.** When the work is committed and the worktree is clean, call `request_merge` from inside
   the worktree and wait for it to return. It rebases onto the base branch, runs the verify commands,
   waits for its turn in the merge queue (and, in manual-review mode, for the human's approval on the
   board), fast-forward-merges (or opens a PR), marks the task **Done**, and removes your worktree. Do
   not merge, commit, or push from the repository root yourself.

## Cancellation contract

A dispatch can be cancelled from the board while you work. Cancellation is **task/worktree-scoped**,
never signalled through the drifting active task. At each checkpoint treat **either** of these as
cancelled (both are first-class — neither is "primary"):

- **Marker present** — `test -f .taskwright/cancelled` in your worktree succeeds. Detection is
  **presence-only**: never read or parse the file's contents.
- **Worktree vanished** — any git / file / `request_merge` operation fails because the worktree or its
  files are gone (ENOENT, "not a working tree", or `request_merge` aborting because it is now the
  primary tree). On POSIX the marker is deleted along with the worktree, so this is the reliable
  signal there; on Windows the marker may survive a busy removal.

On cancellation: **stop immediately, do NOT `request_merge`**, leave a short note via `edit_task` if
the task is still reachable, and exit (release your working directory). Do **not** remove the worktree
yourself — the extension owns teardown.

## Rules of thumb

- One session = one task; hold the task ID from step 1 and never re-derive it.
- Launch inside the worktree; if you are not worktree-rooted, stop and ask for a dispatch — do not
  self-create a worktree and continue.
- Strategy precedence is plan > independent-subtasks > TDD.
- Check for cancellation before `request_merge`, every time.
- Close with `request_merge` from the worktree; never commit/merge from the repo root.
```

- [ ] **Step 2: Sanity-check the skill loads**

Confirm the frontmatter parses (YAML fence, `name`/`description`/`allowed-tools`) and the `allowed-tools` names match the registered MCP tools (`mcp__taskwright__get_active_task` etc.) and the three superpowers skills. No test — skills are prose, validated by review + a scenario walkthrough.

- [ ] **Step 3: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS (skill-only; the gate is a regression check).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/execute-task/SKILL.md
git commit --no-verify -m "docs(tree P5): /execute-task skill

- .claude/skills/execute-task/SKILL.md: load-once -> verify-worktree-rooted + bun install ->
  claim -> adaptive execute (plan > independent-subtasks > TDD; independence judged via
  get_board) -> record via edit_task -> mandatory cancellation checkpoint -> request_merge
- cancellation contract is presence-only (test -f .taskwright/cancelled) OR worktree-vanished,
  both co-equal; step 2 VERIFIES worktree-rooting (never self-creates); subscription-safe
  (in-session; sub-skills use Task-tool subagents, never claude -p)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

**Dependencies:** Task 5 (the subtasks-surfacing that makes the SDD branch real) and Task 4 (template coherence with `/execute-task`). Soft — the skill only needs the six MCP tools, all of which pre-exist.

---

## Task 9: Frozen `board.materialized` bugfix (folded, user-directed) [opus]

**Model:** Opus (live systematic-debugging on a synced-board correctness bug — not a transcription).

**Sub-skill:** start with **`superpowers:systematic-debugging`** (reproduce → capture the real throw → fix at source → prove red→green), then TDD the regression.

**Files:**

- Modify: `src/core/boardRef.ts` (prune loop), `src/providers/BoardSyncController.ts` (surface the degraded state); `src/core/boardSyncEngine.ts` only if the repro points there.
- Test: `src/test/unit/boardRef.test.ts` (prune-force regression) and/or a `boardSyncEngine`/controller test (failure surfaced, marker not advanced on failure).

**Context:** a DISTINCT residual from the `/execute-task` work — it rides this branch per the user's fold directive (AGENTS.md allows mid-branch scope growth). Board node = **TASK-26** (`type: bug`, `caused_by` the synced-board work), separate from TASK-25. Keep it off TASK-25's acceptance criteria.

**Symptom (verified live at `dd5e4e2`):** `.taskwright/board.materialized` is frozen at sha `10fdb770…` (since Jul 1 21:59) while the local board ref tip is `216d8b7a…`. Because the marker ≠ the tip, `refreshBoard`'s gate (`boardSyncEngine.ts:343`, `if (d.readMaterialized(target) === localTip) return { changed: false }`) never short-circuits, so **every ~20s poll** re-enters `materialize`.

**Mechanism (hypothesis — confirm by repro):** `refreshBoard` (`boardSyncEngine.ts:345-346`) calls `await d.materialize(target)` then `d.writeMaterialized(target, localTip)`. `materialize` → `materializeRefToWorktree` (`boardRef.ts:153-200`) throws **between checkout-index (:190) and the return (:199)** — so `writeMaterialized` never runs and the marker stays frozen. The throw propagates to `BoardSyncController.tick`'s catch (`BoardSyncController.ts:115-117`), which sets `this.degraded = true` and `console.error`s — but `setStatus` (`:114`) is **skipped**, so the status bar does not clearly reflect the degraded state, and an ext-host `console.error` is effectively invisible to the user. Net harm: hidden repeated failure + wasteful 20s re-`checkout-index` churn (re-writing all board files into the root working tree) + a widened write-clobber window.

**Prime suspect (guard ruled OUT):** the `dd5e4e2` non-board refuse-guard (`boardRef.ts:176-183`) is NOT the cause — the board ref tree is all `backlog/{tasks,drafts,completed,archive}/` paths (verified), so the throw is downstream of the guard. The only code between checkout-index (:190) and return (:199) is the **prune loop** `fs.rmSync(path.join(opts.repoRoot, ...rel.split('/')))` at `boardRef.ts:195` — **no `{ force: true }`**, so it throws (ENOENT on an already-removed file / a concurrent-poll race / a dir-vs-file mismatch).

- [ ] **Step 1: Reproduce (systematic-debugging).** In the worktree, run `materializeRefToWorktree` against the current board ref (`refs/heads/taskwright-board`, in the shared object store) into a **temp isolated index + temp `repoRoot`** (NEVER the primary — do not `checkout-index` into the shared root's `backlog/`). Capture the ACTUAL thrown error + the offending path; record the real error class (ENOENT / EISDIR / EPERM / path-separator). This is the diagnosis the user asked for — write it into TASK-26's implementation notes via `edit_task`.

- [ ] **Step 2: Write the failing regression test(s).** (a) `boardRef`: a prune of a local board file that is already-absent (or whatever the repro proves) does NOT throw. (b) `refreshBoard`/controller: a materialize failure is **surfaced** (degraded state set AND a status update / de-duplicated log fires) and the marker is **NOT** advanced on failure. Run → confirm red (with positive controls, no vacuous assertions).

- [ ] **Step 3: Fix at source.** In `boardRef.ts:195`, at minimum `fs.rmSync(path.join(opts.repoRoot, ...rel.split('/')), { force: true })`; handle the real cause the repro revealed. Add `recursive: true` **only** if the repro proves a directory is legitimately listed — otherwise fix `listLocalBoardFiles`/the listing race rather than mask a wrong-path bug with `recursive`.

- [ ] **Step 4: Surface the failure.** In `BoardSyncController.tick`'s catch, make the degraded state visible (call `setStatus` / set a degraded status indicator) and de-duplicate the `console.error` so a persistent failure shows without 20s spam. Minimal change, covered by the Step-2 test.

- [ ] **Step 5: Prove red→green (falsification).** Show the Step-2 tests red before the fix, green after; confirm a successful `refreshBoard` now advances the marker to the current tip.

- [ ] **Step 6: Full task gate.** `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS (no webview change; the tree glob is a regression check).

- [ ] **Step 7: Commit** (own-model trailer; fill `<real-cause>` from Step 1):

```bash
git add src/core/boardRef.ts src/providers/BoardSyncController.ts src/test/unit/boardRef.test.ts
git commit --no-verify -m "fix(sync): force the board prune rmSync + surface materialize failures (TASK-26)

- boardRef prune loop used an unforced fs.rmSync between checkout-index and return, so a
  <real-cause> threw every ~20s poll before writeMaterialized ran — board.materialized froze
  at 10fdb770 since Jul 1 and refreshBoard re-materialized on every poll (hidden churn)
- fix: fs.rmSync(..., { force: true }) (+ <real-cause fix>); the marker now advances on success
- surface: BoardSyncController tick reflects the degraded state (status + de-duped log) instead
  of an invisible ext-host console.error
- TDD regression: unforced-prune no longer throws; a materialize failure is surfaced, not swallowed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none (independent of the `/execute-task` cores). Execute **after Task 7 and before Task 8** so the close gate covers it.

---

## Task 8: Docs + full gate + close [opus]

**Model:** Opus (judgment: CLAUDE.md bullet density/style, spec addendum, AGENTS.md cross-reference, gate + handback).

**Files:**

- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md`
- Review only: `AGENTS.md` (no change expected — see note)
- Verification/close only (no other code)

**Goal:** doc-sync the phase and hand back. Add the CLAUDE.md P5 bullet (✅), a one-line spec §5 addendum recording the launch-in-worktree deviation, confirm AGENTS.md already encodes the workflow (cross-reference, no rewrite), run the full regression gate, and stop at "worktree clean, all gates green, ledger updated" — the orchestrator lands the branch.

- [ ] **Step 1: CLAUDE.md — add the P5 bullet**

In `CLAUDE.md`, add the P5 bullet immediately after the P4 bullet closes (it is the last `- **Tech-tree …**` bullet before `## Conventions`), matching the existing bullets' density/style:

```markdown
- **Tech-tree execute skill + cancellation protocol (P5)** ✅: an `/execute-task` **skill**
  (`.claude/skills/execute-task/SKILL.md`) executes one task end-to-end in its worktree — load once
  (`get_active_task`, hold the ID) → **verify** worktree-rooted + `bun install` → `claim_task` →
  adaptive strategy (attached plan → `superpowers:executing-plans`; independent subtasks →
  `subagent-driven-development`; else `test-driven-development`; precedence plan > independent-subtasks
  > TDD, independence judged via `get_board` rows) → record via `edit_task` → **mandatory cancellation
  checkpoint** → `request_merge` (parity with the P2 board actions; subscription-safe — in-session,
  never `claude -p`). The **cancellation protocol** P2's Cancel-dispatch popover triggers lands here: a
  new pure core `src/core/cancellationMarker.ts` (mirrors `activeTask.ts`; **presence-only**
  `isCancelled`, never parses the marker) is written **first** in `cancelDispatch`
  (`marker → releaseClaim → setStatus → removeWorktree → disposeTerminal`) so a `git worktree remove
  --force` that sweeps `.taskwright/` can't resurrect the dir and silently defeat isolation on the next
  dispatch; dispatch clears any stale marker on seed (`clearCancellationMarker`, `dispatchActions.ts`).
  Detection is **presence-only OR worktree-vanished** (co-equal — POSIX deletes the marker with the
  worktree, Windows may keep it and leak the worktree until re-dispatch reuses it). `get_active_task`'s
  summary now surfaces `subtasks`/`parentTaskId` (so the SDD branch can fire), and the **Cancel-dispatch
  affordance** is gated on worktree-dir existence (`TasksController` `dispatchedWorktree` =
  `fs.existsSync(worktreePathFor(repoRoot, dispatchBranchName(task)))`; popover shows it when
  `dispatchedWorktree || hasWorktree`) so a dispatched-but-unclaimed task is teardownable — no new
  frontmatter (`dispatched_at` deliberately **not** added). `DEFAULT_DISPATCH_TEMPLATE` now says **launch
  inside `.worktrees/<branch>` and run `/execute-task`** (guardrails kept; the inline workflow prose moved
  into the skill) — users with a custom `taskwright.dispatchTemplate` keep their own and won't pick up the
  repoint. The MCP root is fixed at launch (`server.ts`), so `/execute-task` **verifies** it is
  worktree-rooted rather than self-creating a worktree (spec §5 direct-run descoped to launch-in-worktree).
  Coverage: `src/test/unit/{cancellationMarker,cancelDispatch,dispatchActions,dispatchPrompt,toSummary,TasksController}.test.ts`,
  `e2e/tree-popover.spec.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p5-execute-task-skill.md`.
```

- [ ] **Step 2: Spec — one-line §5 addendum**

In `docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md`, at the end of **§5 (Human dispatch trigger)** (after the "runnable directly" bullet, `~line 78`), append:

```markdown
> **P5 implementation deviation (2026-07-03):** the "runnable directly / self-creates the worktree" path (§5, last bullet) is descoped. The taskwright MCP server roots itself once at launch (`src/mcp/server.ts`) and `request_merge` aborts on the primary tree (`isPrimaryTree`), so a repo-root session cannot self-create a worktree and continue. `/execute-task` instead **verifies** it was launched inside `.worktrees/<branch>` (dispatch is the normal trigger) and stops with guidance otherwise. Also: the §6 "later prune succeeds / worktree reclaimed" note is corrected — `git worktree prune` only deregisters worktrees whose directory is already missing, and `cancelDispatch` fires once, so a Windows live-agent cancel **leaks** the worktree until a re-dispatch reuses it (with the stale marker cleared). See `.superpowers/tech-tree-run/p5-architecture-directives.md` (CENTRAL INVARIANT + GAP-2 + DEVIATIONS).
```

- [ ] **Step 3: AGENTS.md — no change needed (verify)**

`AGENTS.md` already encodes the task workflow (`get_active_task` → claim → work → `request_merge`, stay in your worktree, no root commits). `/execute-task` **formalizes** that workflow as a skill and adds no new step. Confirm no stale statement contradicts P5 (grep `AGENTS.md` for "dispatch" / "worktree" / "cancel"); if a genuinely misleading line exists, note it, but the default is **no AGENTS.md edit** (the skill is auto-discovered from `.claude/skills/`).

- [ ] **Step 4: Full regression gate**

Run, in the worktree:

```bash
bun run build && bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Expected: PASS. Record the exact new totals against the branch-base baselines captured at the start:
- **Unit:** baseline + new suites (`cancellationMarker`, `dispatchActions`, `toSummary`) + the reworked `cancelDispatch` + the added `dispatchPrompt`/`TasksController` cases.
- **Playwright:** baseline + the two new `tree-popover` cases.
- Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix".)

> The full CDP gate ran at **Task 6** (the last webview/controller change); no webview/controller code lands in Tasks 7–8, so re-running CDP here is optional regression only. If any Task 7/8 change unexpectedly touched a bundled path, run `bun run test:cdp` too.

- [ ] **Step 5: Visual proof (optional but preferred)**

Invoke the **`visual-proof`** skill to capture: the popover **Cancel dispatch** affordance appearing on a dispatched-but-unclaimed in-progress task (Vite fixture, fast), and — via `showboat exec` — a unit-test run of `cancellationMarker`/`cancelDispatch` as the marker-ordering evidence (the MCP surface can't be exercised live from the worktree — primary-build caveat). Save under the skill's git-ignored output location.

- [ ] **Step 6: Hand back to the orchestrator**

Confirm the worktree is clean (`git status` shows nothing uncommitted), all gates are green (unit + Playwright + the Task-6 CDP run + lint + typecheck), and update the run ledger (`.superpowers/tech-tree-run/`). **Do NOT run `request_merge`** — in this run the orchestrator lands the branch (ff-merge). Stop at "worktree clean, all gates green, ledger updated". (The docs commit below is the last commit.)

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-07-02-tech-tree-p5-execute-task-skill-design.md
git commit --no-verify -m "docs(tree P5): CLAUDE.md P5 bullet + spec launch-in-worktree addendum

- CLAUDE.md: P5 execute-skill + cancellation-protocol bullet (marked done)
- spec §5/§6 addendum: direct-run descoped to launch-in-worktree (fixed MCP root); correct
  the prune-reclaims record (Windows live-agent cancel leaks the worktree until re-dispatch)
- AGENTS.md already encodes the workflow the skill formalizes (no change)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** Tasks 1–7 **and Task 9** (Task 9 lands before this close so the full gate covers its `boardRef`/`BoardSyncController` changes; documents the whole phase).

---

## Self-Review

**1. Directive → task mapping (P5):**

- **CENTRAL INVARIANT** → the spine: step 2 of the skill is VERIFY-not-create (Task 7), the dispatch template says "launch inside" (Task 4), the affordance derives from the deterministic worktree path (Task 6), and the spec §5 deviation is recorded (Task 8).
- **GAP-1 (marker-first order + reordered `cancelDispatch.test.ts` incl. Windows-busy)** → Task 2.
- **GAP-2 (presence-only both-signals detection contract in SKILL.md; correct the "prune reclaims" record)** → Task 7 (contract) + Task 2 (reworded comment) + Task 8 (spec addendum).
- **GAP-3 (dispatch clears a stale marker on seed + test)** → Task 3.
- **GAP-4 (`src/core/cancellationMarker.ts` mirroring `activeTask.ts` + `CancelDispatchDeps` `writeCancellationMarker` dep + extension wiring with `worktreePathFor(repoRoot, branch)`)** → Task 1 (core) + Task 2 (dep + wiring).
- **GAP-5 (`toSummary` surfaces `subtasks`+`parentTaskId` + test; ordered adaptive selector plan > independent-subtasks > TDD, independence via `get_board`)** → Task 5 (data) + Task 7 (selector prose).
- **GAP-6 (SKILL.md step-2 VERIFY-not-create + Bash + `bun install` + stop-if-not-worktree-rooted)** → Task 7.
- **GAP-7 (`TasksController` `dispatchedWorktree` via `fs.existsSync(worktreePathFor(...))` + `DetailPopover` gate `dispatchedWorktree || hasWorktree` + controller test + Playwright popover touch)** → Task 6.
- **GAP-8 (do NOT add `dispatched_at`; reword the stale `cancelDispatch.ts:46-49` TODO)** → Task 2.
- **GAP-9 (repoint `DEFAULT_DISPATCH_TEMPLATE`, keep guardrails, migrate prose into SKILL.md, keep handoff in sync, template test, note custom-template users)** → Task 4 (template) + Task 7 (migrated prose) + Task 8 (custom-template note).

**2. Locked-name compliance:** new core `cancellationMarker.ts` with the four named exports; `CancelDispatchDeps.writeCancellationMarker` first; `TaskSummary.subtasks`/`parentTaskId`; `Task.dispatchedWorktree`. No new MCP tool, no new webview message, no new frontmatter.

**3. Parity:** the marker mirrors `activeTask.ts`; `cancelDispatch` reuses the injected-dep orchestrator; the affordance reuses the existing `taskwright.cancelDispatch` command + deterministic `worktreePathFor`/`dispatchBranchName`; every skill step (claim / execute / record / merge / cancel) has a P2 board equivalent.

**4. Scope discipline:** no `dispatched_at`, no `ensure_worktree`/`set_root`, no re-rootable MCP, no codebase-index bootstrap (P6). The direct-run ergonomic is descoped to launch-in-worktree, recorded in the spec addendum.

**5. Leaves-first build integrity:** Task 1 (marker core) is the substrate; Tasks 2–3 wire it into cancel/dispatch; Tasks 4–6 are independent seams (template / MCP summary / affordance), each green in isolation; Task 7 writes the skill over the surfaced data + repointed template; **Task 9 (folded, independent) fixes the frozen `board.materialized` via systematic-debugging + TDD, landing before the close**; Task 8 docs + close. Each task ends green (`bun run test` + `tree-` Playwright + lint + typecheck; `bun run build` where a bundle changed). The **full** Playwright + **full** CDP run is bound to Task 6 (the only webview/controller change, highest cross-view risk); Task 8 re-runs the full unit + Playwright gate at close (covering Task 9). **Directive→task mapping addendum:** Task 9 is not a P5 directive — it is a user-directed fold of a synced-board residual (`.superpowers/tech-tree-run/p5-plan-adjudications.md`, "NEW SCOPE"), tracked as its own bug node TASK-26.

**6. Verify commands are per-task and concrete** (`bun run test -- <suite>`, `bun run test:playwright -- tree-`, the full `bun run test:playwright`/`bun run test:cdp` at Task 6, the full gate at Task 8). Commits stage only named files and use `--no-verify` (Windows CRLF hook). Model tiers: Tasks 1–6, 8 opus (cores/integration/Svelte/judgment); Task 7 haiku (fully-provided SKILL.md — genuine transcription).

**7. Every test has a falsification path:** `cancellationMarker` (false→true flip + presence-only-on-non-JSON + never-throws-on-missing-root); `cancelDispatch` (order array asserts `marker` at index 0 + real-marker survives a failed removal); `dispatchActions` (stale marker present→absent, with a no-prior-marker positive control); `dispatchPrompt` (positive `/execute-task`/strategy/guardrail assertions replacing the removed-prose ones); `toSummary` (present vs undefined negative control); `TasksController` (worktree-dir exists→`true`, absent→`false`); `tree-popover` (affordance shows on dispatched-unclaimed, absent on no-worktree). No vacuous assertions.

## Open questions

None block implementation; the directives adjudicate every known fork. Three residual judgment calls are recorded inline rather than raised as blockers (surfaced to the orchestrator for optional override):

1. **`dispatchedWorktree` is gated to the tree tab** in `TasksController` (the only consumer is the tree popover) to avoid an `existsSync` per card on every kanban/list refresh. If a future board view (e.g. a kanban Cancel-dispatch card action) needs it, drop the `this.viewMode !== 'tree'` guard. Directive-compatible (GAP-7 specifies the computation, not the view scope).
2. **The GAP-7 coverage is a controller unit test + a Playwright popover touch + a full-CDP regression run**, not a new CDP spec — the directive says "may warrant a CDP **or** Playwright touch," and no real dispatch is needed to exercise the affordance (the enrichment is pure `fs.existsSync`). Port **9345** is reserved if the orchestrator wants a dedicated cross-view CDP proof (seed a `.worktrees/<branch>` dir on disk → popover shows Cancel dispatch → click tears it down).
3. **`cancellationMarker.ts` is marked opus**, not haiku, despite being a near-verbatim mirror of `activeTask.ts` — because it defines the central cancellation contract and its presence-only divergence needs the test's positive/negative controls to be exactly right. If the orchestrator prefers cost, it is a defensible haiku transcription (full code + tests are provided).
