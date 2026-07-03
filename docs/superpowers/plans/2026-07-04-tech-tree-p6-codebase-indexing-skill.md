# Tech-tree P6 — `/index-codebase` Skill, `create_milestone` Tool & Status-Carrying Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Worker routing (directive-locked):** Task 1 & Task 4 are **Opus** (cross-cutting model change / judgment); Task 2 & Task 3 are self-contained specs for a **DeepSeek** worker (`ch worker --profile deepseek --spec <file> --worktree --scope <paths>`), each followed by a per-slice **Opus HARD-read-only review** — verify the gates yourself, never on the worker's say-so.

**Goal:** Bootstrap an initial tech-tree when Taskwright is mounted over an **existing** repo. P6 delivers three dependency-ordered workstreams: (1) a **foundation model fix** — *status-carrying drafts*: a draft becomes a provisional/discardable **overlay orthogonal to completion status** (the marker is `folder === 'drafts'`, never a synthetic `status: Draft`), so a draft can be **Done**, and promote/demote **preserve** the draft's real status; (2) a new **`create_milestone`** MCP tool wrapping the existing `BacklogWriter.createMilestone`; and (3) an **`/index-codebase` skill** that reads git history + module structure + docs ("forensics") to reconstruct the already-built foundation as **Done baseline drafts**, mine `TODO`/`FIXME` gaps as **To-Do drafts**, and apply everything **as drafts** the human reviews and promotes on the canvas. Parity: every tool the skill drives is one a human can drive via P3/P4; subscription-safe — never `claude -p`. P6 **completes the tech-tree spec set (P1–P6)**.

**Scope boundary (P6).** This plan implements the P6 architecture directives (`.superpowers/tech-tree-run/p6-architecture-directives.md`) in full: the D2 status-carrying-drafts foundation change (Task 1), the `create_milestone` tool D3/D4/D5/D6 (Task 2), the `/index-codebase` skill D7/D8 (Task 3), and docs + full gate + close (Task 4). It does **not** add semantic/embedding search (baseline keyword only), a `create_milestone {order}` param (D4 — dropped; band order is creation order), a config-line milestone clone (D3 — wraps the writer instead), any new webview message/component (drafts already render via P4 GAP-1's `folder==='drafts'` arm), any new frontmatter, or any promote/subtask MCP tool for the skill (D8 — the human promotes; coarse granularity). Executing the resulting bootstrap tasks is P5's job.

**Architecture.** The changes span three seams, all reusing existing cores (parity):
- **Draft model (`src/core`)** — `createTaskCore.ts` relaxes the `draft && status` throw so a draft may carry a valid status; `BacklogWriter.createDraft` writes the given status (default = `config.default_status`, else `To Do`) instead of hard `'Draft'`; `BacklogParser.getDrafts` reflects the **real** frontmatter status (legacy `status: Draft` files aliased to the board default on read); `BacklogWriter.promoteDraft` **preserves** status on promote (Done draft → Done task); `BacklogWriter.demoteTask` **preserves** status on demote (symmetric). The provisional marker stays `folder === 'drafts'` — the webview `isDraft` readers (`TreeNode`/`DetailPopover`/`TechTreeCanvas`, folder arm) are **unchanged**, so P1–P5 rendering is preserved.
- **MCP write tool (`src/mcp`)** — `createMilestoneHandler(deps, {name, description?})` wrapping `BacklogWriter.createMilestone` (idempotent on a case-insensitive name; reserved-guard `Backburner` only; `invalidateMilestoneCache` after write), registered via `runTool`. Schema `{ name, description? }` — **no `order`**.
- **The skill** — `.claude/skills/index-codebase/SKILL.md`, house format, encoding the Survey → Forensics → Reconstruct → Mine-gaps → Propose-as-drafts (confirm-before-write) → Hand-off-to-review loop, with baseline = **Done draft**, gap = **To-Do draft**, dedupe against the live board, and drafts emitted in dependency order.

**Tech Stack:** TypeScript, Vitest (pure cores + temp-dir `scaffold()` MCP handler tests + fs-mocked parser/writer unit tests), Playwright + CDP-over-WebSocket (full regression on the draft-model change — riskiest slice), esbuild (extension + MCP bundles). The MCP tools run as a **separate stdio process** reusing only `src/core`. **No webview/Svelte change in P6** (drafts already render via P4 GAP-1; the folder-arm `isDraft` styling is untouched), so there is **no new CDP file and no new port** — the full CDP suite runs as a regression check.

## Where this fits (the tech-tree overhaul)

- **Umbrella vision:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`.
- **Spec (approved brainstorm):** `docs/superpowers/specs/2026-07-02-tech-tree-p6-codebase-indexing-design.md` (context; **internally contradictory on drafts — D1 resolves it, follow D1**: baseline = Done DRAFT, not Done task).
- **Directives (orchestrator-locked, binding):** `.superpowers/tech-tree-run/p6-architecture-directives.md` (D1–D8, build slices, worker routing, verified anchors). Every directive is honored below; none are relitigated.
- **Base:** main `ec635f8`. Worktree `.worktrees/tech-tree-p6`, branch `tech-tree-p6`.
- **Builds on landed reality:** P1 (model, `wouldCreateCycle`, config `categories`/`priorities`, `deriveTreeLayout`), P2 (canvas + draft-node styling), P4 (`create_task`/`create_category`/`list_categories`/`list_milestones`/`get_board`/`search_tasks`/`promote_drafts`; GAP-1 draft-visibility union; the `folder==='drafts'` provisional styling). `create_task` is **already extended** with `category`/`type`/`causedBy`/`dependencies`/`draft` and, from P4 GAP-2, folds `priority`/`milestone`/`labels`/`assignee` on the draft path — P6 only adds a valid **`status`** to the draft path.

## Locked names & wire conventions (from the directives — do not rename)

- **New MCP tool:** `create_milestone` (snake_case tool name), schema **`{ name: string, description?: string }`** — **no `order`** (D4). Registered via `runTool` (throws surface as `isError`). Result shape `CreateMilestoneResult { created: boolean; id: string; milestone: string }` (D5).
- **New handler:** `createMilestoneHandler(deps: McpHandlerDeps, args: { name: string; description?: string }): Promise<CreateMilestoneResult>` in `src/mcp/handlers.ts` — mirrors `createCategoryHandler` (handlers.ts:568-592). Reserved-guard rejects **`Backburner` only** (case-insensitive), NOT `isReservedCategory` (D6).
- **Draft model contract (D2):** `createDraft(backlogPath, parser?, { title?, description?, status? })` writes the given status (default `config.default_status ?? 'To Do'`); `getDrafts()` returns each draft's **real** parsed status (legacy `'Draft'` aliased to the board default); `promoteDraft`/`demoteTask` **preserve** the real status. The provisional marker is `folder === 'drafts'`, never a synthetic status.
- **Skill:** `.claude/skills/index-codebase/SKILL.md` — `name: index-codebase`; `allowed-tools` = `Bash, Read, Grep, Glob, mcp__taskwright__{list_categories, list_milestones, get_board, search_tasks, create_category, create_milestone, create_task, edit_task}` + optional `Skill(superpowers:brainstorming)` (D8). **NOT** `promote_*` (human promotes), **NOT** `create_subtask` (coarse granularity).
- **No new webview message. No new frontmatter. No Svelte edit.**

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p6` on branch `tech-tree-p6`. Run all git/file/test commands inside the worktree. A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there **once** before the first build/test. Never commit/merge from the repo root; stage only the files each task names; commit with `--no-verify` (the repo's lint-staged pre-commit hook flips the whole tree CRLF→LF on Windows — see the memory note "Pre-commit hook autocrlf corruption").
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (`ec635f8`):** capture them **in the fresh worktree** (never the shared primary tree — it is prone to the root-flush incident) — after `bun install`, run `bun run test`, `bun run test:playwright`, `bun run test:cdp` once and **record the actual pass counts** (do not hardcode; the run's earlier phases nudge these). Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **MCP primary-build live-caveat:** the `taskwright` MCP server in a worktree runs the **primary** checkout's `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). The new `create_milestone` tool and the draft-status change are **NOT live** in the worktree until this branch is merged and the primary rebuilt. Exercise them via **unit tests** (temp-dir `scaffold()` / fs-mocked), never by calling the tool live from the worktree. A post-land smoke is the orchestrator's job, not a task gate.
- **Parity (mandatory):** every write the skill drives reuses an existing surgical writer — `create_milestone` wraps `BacklogWriter.createMilestone`; `create_task {draft, status}` routes through `createTaskWithTreeFields`; the human authors the identical shapes via P3/P4. No dependency write bypasses `wouldCreateCycle` (`src/core/treeGate.ts`).
- **Subscription-safety (mandatory):** nothing in P6 spawns `claude -p` or any headless agent. The skill uses Bash/Read/Grep/Glob for forensics and the `taskwright` MCP tools for writes; `superpowers:brainstorming` (optional) runs in-session.
- **TDD where a pure core or handler exists:** write the failing Vitest first, run **red**, implement, run **green** (falsification proof on every test). Task 3 is prose (skill), validated by review + a scenario walkthrough, not a unit test.
- **Verify gate per task:** each task runs `bun run test` (or a scoped `bun run test -- <suite>` mid-build) **plus** `bun run lint` and `bun run typecheck`, and `bun run test:playwright -- tree-` as a regression check. The **full** `bun run test:playwright` **and full** `bun run test:cdp` are bound to **Task 1** (the draft-model change touches the shared derivation the whole board renders over — highest cross-view-regression risk) and re-run at the **Task 4** close. **No new CDP file / port** (no webview change).
- **Root check-and-heal before/after every dispatch:** the shared root tree can accumulate autocrlf noise; heal per the memory notes before staging.
- **Commit trailer:** end each commit with `Co-Authored-By: <implementing model> <noreply@anthropic.com>` (opus tasks: `Claude Opus 4.8 (1M context)`; DeepSeek worker tasks substitute their own model line per `AGENTS.md`).

## Shape of the phase (the 4 tasks)

Following the directives' build slices (`§Build slices`, dep order) **exactly**:

1. **Status-carrying drafts (foundation, cross-cutting)** [opus]. The D2 model change across `createTaskCore`/`createDraft`/`getDrafts`/`promoteDraft`/`demoteTask` + a **mandatory blast-radius survey** of every `status === 'Draft'` reader + full unit/Playwright/CDP regression. **Hardest slice.**
2. **`create_milestone` MCP tool** [deepseek]. D3/D4/D5/D6 — `createMilestoneHandler` mirroring `createCategoryHandler` + server registration + tmpdir handler tests. Mechanical mirror; self-contained spec.
3. **`/index-codebase` SKILL.md** [deepseek]. D7/D8 — author `.claude/skills/index-codebase/SKILL.md` in the house style. Transcription-grade (exact text provided). Depends on Tasks 1+2 for coherence.
4. **Docs + full gate + hand back** [opus]. CLAUDE.md P6 bullet (before `## Conventions`), plan doc path, run-notes, full regression gate. For this orchestrated run it does **not** call `request_merge`/`complete_task` — landing is the orchestrator's root `git merge --ff-only` (with explicit user authorization, per HANDOFF), matching the shipped P4/P5 close tasks.

**Recommended execution order (green at every commit):** `1 → 2 → 3 → 4`.

- **1** makes drafts status-carrying — the model every P6 deliverable rides. **2** adds the age-creation tool the skill needs. **3** writes the skill over the surfaced model + tool (transcription; no runtime dep). **4** docs + full gate + close.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. `handlers.ts`/`server.ts` line numbers may drift; the quoted before/after snippets are authoritative. All line numbers here are verified against the working tree at `ec635f8`.

---

## File Structure

**Create:**

- `.claude/skills/index-codebase/SKILL.md` — the `/index-codebase` skill (Task 3).

**Modify:**

- `src/core/createTaskCore.ts` — relax the `draft && status` throw; pass `status` through to `createDraft` (Task 1).
- `src/core/BacklogWriter.ts` — `createDraft` writes the given status (default `config.default_status ?? 'To Do'`); `promoteDraft` preserves status; `demoteTask` preserves status (Task 1). Add `createMilestoneHandler` **consumes** `createMilestone` unchanged (no edit needed there).
- `src/core/BacklogParser.ts` — `getDrafts` reflects the real parsed status (legacy `'Draft'` aliased to the board default) instead of forcing `'Draft'` (Task 1).
- `src/mcp/handlers.ts` — new `createMilestoneHandler` + `CreateMilestoneResult` (Task 2).
- `src/mcp/server.ts` — import + register `create_milestone` via `runTool` (Task 2).
- `CLAUDE.md` — P6 bullet before `## Conventions` (Task 4).
- Existing tests (Task 1): `src/test/unit/createTaskCore.test.ts` (invert the status-throw test; add status-carry; fix two `createDraft` call assertions), `src/test/unit/BacklogWriter.test.ts` (createDraft default/given-status; promoteDraft preserve; demoteTask preserve), `src/test/unit/BacklogParser.test.ts` (getDrafts reflects real status), `src/test/unit/mcpWriteHandlers.test.ts` (Done-draft round-trip + promote; demote-preserve; **flip the GAP-2 draft test's `status: Draft` assertion to `status: To Do`**), `src/test/unit/treeGate.test.ts` (positive control: a Done baseline draft unlocks its dependent).
- Existing tests (Task 2): `src/test/unit/mcpWriteHandlers.test.ts` (`createMilestoneHandler` describe).

---

## Task 1: Status-carrying drafts (D2 foundation + blast-radius survey) [opus]

**Model:** Opus (cross-cutting correctness change over the shared draft/derivation plumbing; the blast-radius reasoning + backward-compat alias need care).

**Files:**

- Modify: `src/core/createTaskCore.ts`, `src/core/BacklogWriter.ts`, `src/core/BacklogParser.ts`
- Test: `src/test/unit/createTaskCore.test.ts`, `src/test/unit/BacklogWriter.test.ts`, `src/test/unit/BacklogParser.test.ts`, `src/test/unit/mcpWriteHandlers.test.ts`, `src/test/unit/treeGate.test.ts`

**Why (D1/D2):** the spec is internally contradictory (§2 "baseline = Done tasks" vs §3/§5 "all nodes are drafts"). D1 resolves it: **drafts are status-carrying and orthogonal to completion status.** A draft is a provisional/discardable overlay whose only marker is `folder === 'drafts'`; it can be **Done**. So the plumbing must stop treating `'Draft'` as a synthetic status: (a) `create_task {draft:true}` accepts a valid `status`; (b) `createDraft` writes it (default = board default); (c) `getDrafts` reflects the real status; (d) `promoteDraft` preserves it (Done draft → Done task); (e) `demoteTask` preserves it (symmetric). This is the substrate the `/index-codebase` skill's **Done baseline drafts** ride. It is the riskiest slice because the synthetic `'Draft'` status may be relied on for filtering/rendering — hence the mandatory blast-radius survey below.

### Step 1: Capture branch-base baselines

- [ ] In the worktree (after `bun install`), run `bun run test`, `bun run test:playwright`, `bun run test:cdp` once and record the actual pass counts (Windows: ~22 known POSIX-path unit failures are pre-existing — record but ignore). These are the regression floor for Step 8.

### Step 2: Blast-radius survey (MANDATORY — enumerate every `status === 'Draft'` reader)

- [ ] Run `rg -n "'Draft'|\"Draft\"|status === 'Draft'|folder === 'drafts'" src` and reconcile against the table below (verified at `ec635f8`). For each **production** site, confirm the stated verdict holds before you finish; adjust code so **P1–P5 behavior is preserved**. **Also survey the tests** — `rg -n "status === 'Draft'|status:\s*Draft" src/test` — because every test assertion that encodes the old synthetic-`'Draft'` status goes RED under D2 (e.g. the GAP-2 draft test at `mcpWriteHandlers.test.ts:108`, updated in Step 3d). Enumerate the full RED set here **before** you implement so nothing surfaces only at the Step 7 catch-all. Record the survey in the task's implementation notes (`edit_task`).

| # | Site | What it does | Verdict |
|---|------|--------------|---------|
| 1 | `BacklogParser.ts:284` (`getDrafts`) | forces `status:'Draft'` on read | **CHANGE (2c)** — reflect real status; alias legacy `'Draft'` → board default |
| 2 | `BacklogParser.ts:1008` (`parseStatus`) | maps on-disk `status: Draft` → the `'Draft'` TaskStatus | **KEEP** — this is the backward-compat hook; `getDrafts`/`promoteDraft` alias its output to the board default |
| 3 | `BacklogWriter.ts:776` (`createDraft`) | hard-writes `status:'Draft'` | **CHANGE (2b)** — write the given status; default `config.default_status ?? 'To Do'` |
| 4 | `BacklogWriter.ts:401` (`promoteDraft`) | resets `status = default_status` | **CHANGE (2d)** — preserve real status; only reset a legacy/blank `'Draft'` |
| 5 | `BacklogWriter.ts:449` (`demoteTask`) | sets `status = 'Draft'` | **CHANGE (2e)** — preserve the task's real status (symmetric); folder is the marker |
| 6 | `TreeNode.svelte:38` `isDraft = status==='Draft' \|\| folder==='drafts'` | provisional node styling | **SAFE — do NOT change** (the `folder` arm covers a To-Do/Done draft; drafts always carry `folder:'drafts'` from `getTasksFromFolder`, BacklogParser.ts:242) |
| 7 | `TechTreeCanvas.svelte:142` promote-all filter | `status==='Draft' \|\| folder==='drafts'` | **SAFE — do NOT change** (folder arm) |
| 8 | `DetailPopover.svelte:42` `isDraft` | popover restricts drafts to Promote/edit | **SAFE — do NOT change** (folder arm) |
| 9 | `handlers.ts:709` `draft: task.folder === 'drafts'` | board-summary `draft` flag | **SAFE** — folder-based |
| 10 | `TaskDetailProvider.ts:524` `isDraft: task.folder === 'drafts'` | detail panel draft flag | **SAFE** — folder-based |
| 11 | `statusColors` (`statusToClass`, lowercase-keyed — no literal `'Draft'` in src) | badge color by status | **VERIFY (cosmetic)** — a To-Do/Done draft now renders its real status color in the list/drafts tab (expected under the orthogonal-draft model); tree/popover provisional styling stays folder-driven, so nodes still read as proposed |
| 12 | Kanban board + `drafts` tab | `getTasks()` never reads `drafts/`; the drafts **tab** is `viewMode==='drafts'`/`activeTab==='drafts'` (tab-driven, not status-driven — `TasksController.ts:241`, `Tasks.svelte`/`TabBar.svelte`) | **SAFE** — a draft in the drafts tab now shows its real status badge (cosmetic, expected) |
| 13 | Cross-branch loaders | scan `tasks/`, not `drafts/`; sync-on excludes the board ref | **SAFE** — no draft-status dependence |

> **Backward-compat decision (existing on-disk `status: Draft` drafts) — LOCKED:** treat a parsed/frontmatter `'Draft'` as a **migrate-on-read alias** to the board default (`config.default_status ?? 'To Do'`). `getDrafts` (2c) and `promoteDraft` (2d) both apply the alias; the file is **not** rewritten on read (only on the next promote/edit). `parseStatus` (site 2) is left untouched so the alias input is stable. Net effect: a pre-P6 draft that literally says `status: Draft` behaves exactly as before (renders provisional, promotes to the board default); a new P6 draft with a real status round-trips and promotes to that status.

> **Symmetric new consequence (Done baseline drafts satisfy `status === doneStatus`) — EXPECTED / INTENDED, not a P1–P5 regression:** once a draft carries a real status, a **Done** baseline draft matches the board's done status, so the `status === doneStatus` readers now see a draft as done. No Done drafts existed pre-P6, so none of these predicates ever fired on a draft before — every effect below is intended:
> - `treeLayout.ts:42` `isDone` (bug-lane ordering, sort at :117-118) — a Done draft sorts as done. Cosmetic; fine.
> - `treeGate.ts:27` `computeBlockedBy` — a dependent of a Done baseline draft becomes **UNLOCKED** (`dependencySatisfied` keys off `status === doneStatus`). This is **exactly the point**: it is what lets a Done baseline unlock its gap To-Do dependents.
> - `listMilestonesHandler` `doneCount` (`handlers.ts:650`, `if (t.status === doneStatus) agg.doneCount++`) — a Done draft counts toward its age's done tally. Intended.
>
> Guard this with a **positive control** (Step 3e): a Done draft unlocks its dependent (and is counted done).

### Step 3: Write the failing tests

- [ ] **3a — `createTaskCore.test.ts` (draft accepts a valid status; the throw is gone).** The file's `makeDeps()` stubs `createDraft`/`createTask`/`updateTask` (createTaskCore.test.ts:7-35). **Replace** the existing `it('draft create with an explicit status throws (drafts are always Draft)', ...)` (lines 153-159) with the inverted contract, and **add** a positive control:

```ts
  it('draft create accepts a valid status and passes it to createDraft (P6/D2a)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Baseline', draft: true, status: 'Done' });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Baseline', description: undefined, status: 'Done',
    });
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it('draft create with no status passes status: undefined (writer applies the default)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Gap', draft: true });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Gap', description: undefined, status: undefined,
    });
  });
```

> **Also fix the two existing `createDraft` call assertions** that will break once the core passes `status` in the opts object (exact-match `toHaveBeenCalledWith`): line 80 `{ title: 'Spike', description: 'd' }` → `{ title: 'Spike', description: 'd', status: undefined }`; line 127 `{ title: 'Spike caching', description: undefined }` → `{ title: 'Spike caching', description: undefined, status: undefined }`.

- [ ] **3b — `BacklogWriter.test.ts` (createDraft status; promoteDraft/demoteTask preserve).**

`createDraft` describe (BacklogWriter.test.ts:1776) — change the existing default-status assertion and add given-status + config-default cases. The existing test at 1776-1795 calls `writer.createDraft('/fake/backlog')` (no parser) and asserts `frontmatter.status === 'Draft'`; change that assertion to `'To Do'` (default when unspecified + no parser). Add:

```ts
    it('writes the given status when specified (P6/D2b — a Done baseline draft)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      await writer.createDraft('/fake/backlog', undefined, { title: 'Baseline', status: 'Done' });
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Done');
    });

    it('defaults unspecified status to config.default_status via the parser', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({ default_status: 'Backlog' } as never);
      await writer.createDraft('/fake/backlog', mockParser, { title: 'X' });
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Backlog');
    });
```

`promoteDraft` describe (BacklogWriter.test.ts:1660) — the existing "should update status from Draft to To Do" test (1697-1731) feeds a **legacy** `status: Draft` source and asserts written `'To Do'`; that still passes under the alias (leave it, it now pins the backward-compat path). **Add** the status-preserve cases:

```ts
    it('preserves a real status on promote (P6/D2d — Done draft → Done task)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1', title: 'Baseline', status: 'Done', folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - Baseline.md',
        description: '', labels: [], assignee: [], dependencies: [],
        acceptanceCriteria: [], definitionOfDone: [],
      } as never);
      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});
      vi.mocked(fs.readFileSync).mockReturnValue('---\nid: DRAFT-1\ntitle: Baseline\nstatus: Done\n---\n');
      await writer.promoteDraft('DRAFT-1', mockParser);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const frontmatter = yaml.load(writtenContent.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Done');
      expect(frontmatter.id).toBe('TASK-1');
    });
```

`demoteTask` describe (BacklogWriter.test.ts:3221) — the existing test (3222-3235) feeds `status: In Progress` and asserts the written content contains `status: Draft`; **change** that assertion to `expect(writtenContent).toContain('status: In Progress')` and rename it to `'should preserve the task status on demote (P6/D2e)'`.

- [ ] **3c — `BacklogParser.test.ts` (getDrafts reflects the real status).** In the `getDrafts` describe (~2180): the first test (2185-2197) feeds `status: To Do` and asserts `drafts[0].status === 'Draft'` → **change** to `'To Do'`. The "should enforce Draft status on all drafts" test (2199-2214) feeds `status: In Progress` and asserts `'Draft'` → **rename** to `'reflects the real frontmatter status of a draft (P6/D2c)'` and **change** the assertion to `'In Progress'`. Add a legacy-alias case:

```ts
      it('aliases a legacy status: Draft on-disk draft to the board default (P6 back-compat)', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['draft-1 - Legacy.md']);
        vi.mocked(fs.readFileSync).mockReturnValue('---\nid: DRAFT-1\ntitle: Legacy\nstatus: Draft\n---\n');
        const parser = new BacklogParser('/fake/backlog');
        const drafts = await parser.getDrafts();
        expect(drafts[0].status).toBe('To Do'); // no config default → 'To Do'
        expect(drafts[0].folder).toBe('drafts'); // provisional marker intact
      });
```

> **Harness note:** these `getDrafts` tests mock `fs` and construct a bare `new BacklogParser('/fake/backlog')` with no config on disk, so `getConfig()` yields no `default_status` and the alias fallback is `'To Do'`. Confirm the existing describe's `fs` mock setup (it already mocks `existsSync`/`readdirSync`/`readFileSync`).

- [ ] **3d — `mcpWriteHandlers.test.ts` (end-to-end Done-draft round-trip; demote-preserve).** Append to the `draft lifecycle` describe (mcpWriteHandlers.test.ts:174) — the **key P6 acceptance test** (real files, tmpdir `deps()` idiom, no `vi.mock('fs')`):

```ts
  it('a Done baseline draft round-trips its status and promotes to a Done task (P6/D2)', async () => {
    const d = deps();
    const draft = await createTaskHandler(d, { title: 'Auth subsystem', draft: true, status: 'Done', category: 'Platform' });
    expect(draft.id).toBe('DRAFT-1');
    const file = fs.readFileSync(
      path.join(backlogPath, 'drafts', 'draft-1 - Auth-subsystem.md'), 'utf-8'
    );
    expect(file).toMatch(/^status:\s*Done/m); // NOT a synthetic 'Draft'
    const promoted = await promoteDraftHandler(d, { taskId: 'DRAFT-1' });
    expect(promoted.id).toMatch(/^TASK-\d+$/);
    expect(promoted.status).toBe('Done'); // preserved on promote
  });
```

And **update** the existing `demotes a task to a draft` test (mcpWriteHandlers.test.ts:183-188): it creates a task with no status (→ default `'To Do'`) and asserts `demoted.status === 'Draft'`; under demote-preserve the demoted draft keeps `'To Do'` → change the assertion to `expect(demoted.status).toBe('To Do')`. (The `promotes a draft to a task` test at 175-181 creates a no-status draft → default `'To Do'` → promote preserves `'To Do'`, so it **passes unchanged** — leave it.)

Also **update** the existing `draft create writes priority + milestone into the DRAFT file (GAP-2)` test (mcpWriteHandlers.test.ts:95-109): it creates a **no-status** draft and asserts at :108 `expect(file).toMatch(/^status:\s*Draft/m); // never rewritten to a board status`. Under D2 a no-status draft defaults to the board status (`'To Do'` from the scaffold's `default_status`, config.yml at :34-38), so **change** that assertion to `expect(file).toMatch(/^status:\s*To Do/m);` and replace the trailing `// never rewritten to a board status` comment with `// D2: a no-status draft defaults to the board status, not a synthetic 'Draft'`. This is a **RED** test under D2 — it belongs in the Step 4 fail set and the Step 6 green set (do not let it surface only at the Step 7 catch-all).

- [ ] **3e — `treeGate.test.ts` (positive control: a Done baseline draft unlocks its dependent — EXPECTED under the orthogonal-draft model).** Append to the `computeBlockedBy / isLocked` describe (treeGate.test.ts:51; use the file's `task()`/`byId()` helpers at :12-28). This is a **positive control** — it is green **before and after** the model change (`computeBlockedBy` is unchanged) and documents/guards the intended consequence that a Done draft (which `getDrafts` now surfaces with its real `Done` status) satisfies a dependent's gate:

```ts
  it('a Done baseline draft satisfies a dependent (P6/D2 — Done draft unlocks its gap dependent)', () => {
    const dependent = task({ id: 'TASK-2', dependencies: ['DRAFT-1'] });
    const map = byId([
      dependent,
      task({ id: 'DRAFT-1', status: 'Done', folder: 'drafts' }), // a Done baseline draft
    ]);
    expect(computeBlockedBy(dependent, map, done)).toEqual([]); // unlocked
    expect(isLocked(dependent, map, done)).toBe(false);
  });
```

> The `listMilestonesHandler` `doneCount` facet of the same consequence (a Done draft counts toward its age's done tally, via the identical `status === doneStatus` predicate at handlers.ts:650) is already proven by the Step 3d Done-draft round-trip's `status: Done` file assertion — no separate handler test is needed here.

### Step 4: Run the tests to verify they fail

- [ ] Run: `bun run test -- createTaskCore BacklogWriter BacklogParser mcpWriteHandlers`
  Expected: FAIL — the throw-test inversion, createDraft given/default status, promoteDraft/demoteTask preserve, getDrafts real-status, the updated GAP-2 draft test (now asserting `status: To Do`), and the Done-draft round-trip all fail before the implementation lands. (Positive controls: the no-status draft still routes with `status: undefined`; the legacy `'Draft'` alias still resolves to the board default; the Step 3e `treeGate` Done-draft-unlock test is green throughout.)

### Step 5: Implement the model change

- [ ] **5a — `createTaskCore.ts` (relax the throw; pass `status`).** Remove the throw at lines 85-87 (keep the `const dependencies = ...` line) and pass `status` through on the draft branch:

Delete (createTaskCore.ts:85-87):

```ts
  if (args.draft && args.status !== undefined) {
    throw new Error('drafts always have status Draft; do not set status on a draft.');
  }
```

Replace the draft branch (createTaskCore.ts:90-94):

```ts
  if (args.draft) {
    ({ id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
    }));
  } else {
```

with:

```ts
  if (args.draft) {
    // P6/D2a: a draft is status-carrying (orthogonal to the provisional folder marker).
    // The MCP handler already rejects an unknown status (assertValidStatus); the core just
    // routes the caller's status to createDraft, which defaults it when unspecified.
    ({ id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
      status: args.status,
    }));
  } else {
```

> The MCP path validates status for **all** creates (draft or not) via `assertValidStatus(args.status, config.statuses)` in `createTaskHandler` (handlers.ts:825) — so "reject an unknown status" (D2a) is already enforced for the skill/agent path; the core keeps its "callers layer validation" contract. The GAP-2 draft-field fold (priority/milestone/labels/assignee via the shared `updateTask`, createTaskCore.ts:111-125) is untouched.

- [ ] **5b — `BacklogWriter.createDraft` (write the given status; default via config).** Extend the `opts` type and resolve the status. Change the signature (BacklogWriter.ts:752-756):

```ts
  async createDraft(
    backlogPath: string,
    _parser?: BacklogParser,
    opts?: { title?: string; description?: string }
  ): Promise<{ id: string; filePath: string }> {
```

to (use the parser to resolve the board default):

```ts
  async createDraft(
    backlogPath: string,
    parser?: BacklogParser,
    opts?: { title?: string; description?: string; status?: string }
  ): Promise<{ id: string; filePath: string }> {
```

Then resolve the status just before building `frontmatter` and use it in place of the hard `'Draft'` (BacklogWriter.ts:773-782). Replace:

```ts
    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: draftId,
      title,
      status: 'Draft',
      labels: [],
      assignee: [],
      dependencies: [],
      created_date: today,
      updated_date: today,
    };
```

with:

```ts
    // P6/D2b: a draft carries a real status (the drafts/ folder is the provisional marker,
    // not a synthetic 'Draft'). Default to the board default when unspecified so authoring a
    // draft without a status, then promoting, is byte-identical to the pre-P6 flow.
    const config = parser ? await parser.getConfig() : undefined;
    const status = opts?.status?.trim() || config?.default_status || 'To Do';
    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: draftId,
      title,
      status,
      labels: [],
      assignee: [],
      dependencies: [],
      created_date: today,
      updated_date: today,
    };
```

> `parser` was previously the unused `_parser`; it is now read for `getConfig()`. All production/test callers pass either `deps.parser` (createTaskCore) or nothing (the four `BacklogWriter.test.ts` direct calls) — the `parser ? … : undefined` guard keeps the no-parser callers on the `'To Do'` fallback.

- [ ] **5c — `BacklogParser.getDrafts` (reflect the real status; alias legacy).** Replace (BacklogParser.ts:282-285):

```ts
  async getDrafts(): Promise<Task[]> {
    const tasks = await this.getTasksFromFolder('drafts');
    return tasks.map((t) => ({ ...t, status: 'Draft' }));
  }
```

with:

```ts
  async getDrafts(): Promise<Task[]> {
    const tasks = await this.getTasksFromFolder('drafts');
    // P6/D2c: a draft is a provisional OVERLAY (folder === 'drafts', set by
    // getTasksFromFolder), orthogonal to completion status — the folder is the marker, not a
    // synthetic 'Draft' status. Reflect each draft's real parsed status. Legacy drafts written
    // pre-P6 (frontmatter status: Draft, which parseStatus normalizes to 'Draft') are aliased
    // on read to the board default so they land in a real column (migrate-on-read; the file is
    // not rewritten until its next promote/edit).
    const config = await this.getConfig();
    const fallback = config.default_status || 'To Do';
    return tasks.map((t) => (t.status === 'Draft' ? { ...t, status: fallback } : t));
  }
```

- [ ] **5d — `BacklogWriter.promoteDraft` (preserve status).** Replace (BacklogWriter.ts:400-402):

```ts
    frontmatter.id = newTaskId;
    frontmatter.status = config.default_status || 'To Do';
    frontmatter.updated_date = nowTimestamp();
```

with:

```ts
    frontmatter.id = newTaskId;
    // P6/D2d: preserve the draft's real status on promote — a Done draft promotes to a Done
    // task (drafts are orthogonal to status). Only a legacy/blank synthetic 'Draft' (which has
    // no real status to preserve) is reset to the board default.
    const rawStatus = String(frontmatter.status ?? '').trim();
    if (!rawStatus || rawStatus.toLowerCase() === 'draft') {
      frontmatter.status = config.default_status || 'To Do';
    }
    frontmatter.updated_date = nowTimestamp();
```

> `frontmatter.status` here is the **raw** value from `extractFrontmatter` (the file on disk), not `parseStatus`'s normalization — so a P6 draft's real status (`'Done'`, `'To Do'`, …) is preserved verbatim, and only the literal legacy `Draft` string is reset.

- [ ] **5e — `BacklogWriter.demoteTask` (preserve status, symmetric).** Replace (BacklogWriter.ts:448-450):

```ts
    frontmatter.id = newDraftId;
    frontmatter.status = 'Draft';
    frontmatter.updated_date = nowTimestamp();
```

with:

```ts
    frontmatter.id = newDraftId;
    // P6/D2e: preserve the task's real status on demote (symmetric with promoteDraft) — the
    // drafts/ folder is the provisional marker, so demoting no longer clobbers status to a
    // synthetic 'Draft' (which would silently lose e.g. a Done task's status).
    frontmatter.updated_date = nowTimestamp();
```

### Step 6: Run the tests to green (targeted)

- [ ] Run: `bun run test -- createTaskCore BacklogWriter BacklogParser mcpWriteHandlers treeGate` → PASS (new + updated). The **updated GAP-2 test** (`mcpWriteHandlers` `draft create writes priority + milestone …`, now asserting `status:\s*To Do`) and the **Step 3e positive control** (`treeGate` Done-draft-unlocks-dependent, green throughout) are both in this PASS set — neither may be left to surface as a surprise red at the Step 7 catch-all. Then `bun run typecheck` → PASS.

### Step 7: Run the FULL unit suite + fix any model-driven fallout

- [ ] Run: `bun run test`. Every previously-green test must stay green **or** be a legitimate model change updated minimally with a `P6/D2` justification comment. Pay special attention to any other test that constructs a draft and asserts `status === 'Draft'` (grep confirmed the production sites; a stray test fixture may also assert it). If a test genuinely encodes the old synthetic-status behavior, update it to the orthogonal-draft model; do **not** weaken an assertion to hide a real regression.

### Step 8: Full regression gate (riskiest slice — full Playwright + full CDP)

- [ ] Run, in the worktree:

```bash
bun run build && bun run test && bun run lint && bun run typecheck && bun run test:playwright && bun run test:cdp
```

Expected: PASS against the Step-1 baselines. The **full CDP** run (esp. `tree-promote` on port 9344, which drives drafts-from-disk → promote-all) proves the draft-model change did not break cross-view rendering or the promote path. If a CDP/Playwright fixture writes legacy `status: Draft` drafts, the alias keeps its promoted status at the board default — confirm no assertion flips; if one does, it is a real behavior surface — reconcile it against the orthogonal-draft model, not by masking.

### Step 9: Commit

```bash
git add src/core/createTaskCore.ts src/core/BacklogWriter.ts src/core/BacklogParser.ts \
  src/test/unit/createTaskCore.test.ts src/test/unit/BacklogWriter.test.ts \
  src/test/unit/BacklogParser.test.ts src/test/unit/mcpWriteHandlers.test.ts \
  src/test/unit/treeGate.test.ts
git commit --no-verify -m "feat(tree P6): status-carrying drafts — a draft can be Done (D2)

- a draft is a provisional OVERLAY (folder === 'drafts'), orthogonal to completion status;
  the synthetic 'Draft' status is retired as the marker
- create_task {draft} accepts a valid status (createTaskCore); createDraft writes it
  (default = config.default_status ?? 'To Do'); getDrafts reflects the real status (legacy
  'Draft' aliased on read to the board default); promoteDraft/demoteTask PRESERVE status
  (Done draft -> Done task; symmetric on demote)
- webview isDraft styling stays folder-driven (TreeNode/DetailPopover/TechTreeCanvas
  unchanged); blast-radius survey recorded; full Playwright + CDP regression green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Dependencies:** none (foundation).

---

## Task 2: `create_milestone` MCP tool (D3/D4/D5/D6) [deepseek]

**Model:** DeepSeek worker — `ch worker --profile deepseek --spec <this-task> --worktree --scope src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts`. Mechanical mirror of `create_category`. **Per-slice Opus HARD-read-only review after the worker returns** — verify the gates yourself.

**Files (the ONLY files this slice may edit):**

- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/mcpWriteHandlers.test.ts`

**Self-contained context (a DeepSeek worker implements this from the plan alone — everything you need is here).**

- The MCP server (`src/mcp/server.ts` + `src/mcp/handlers.ts`) is a separate vscode-free stdio process reusing `src/core`. Handlers are plain async functions taking `McpHandlerDeps` (handlers.ts:71-77 — `{ root, backlogPath, parser, writer, claimService, planService, treeFieldService, … }`); `server.ts` wires each to a registered tool. A **write** tool is wrapped in `runTool(() => handler(deps, args))` (server.ts:52-63) so a thrown error surfaces as `{ isError: true }`.
- **Mirror this exactly** — the landed `createCategoryHandler` (handlers.ts:568-592) and its registration (server.ts:223-234). Your handler is the milestone analogue.
- **The writer you wrap already exists (do NOT edit it):** `BacklogWriter.createMilestone(backlogPath, title, description?, parser?): Promise<Milestone>` (BacklogWriter.ts:108-155). It writes `backlog/milestones/m-N - Title.md` (frontmatter `{ id, title }`, body `## Description`), mkdirs `milestones/` on first call, and — **only when `parser` is passed** — throws `'A milestone with this title or ID already exists'` on a dup. It returns `{ id: 'm-N', name, description }` (`Milestone`, types.ts:141-145 — `{ id, name, description? }`, **no `order`**). IDs are allocated `max+1` across active+archived; **first = `m-0`**, monotonic, never reused — so **creation order == numeric id order == band left-to-right order** (this is why D4 drops `order`).
- **The reader is already registered:** `list_milestones` → `listMilestonesHandler` (handlers.ts:634-658) returns bands in canvas order with a **derived** `order` = band index. A milestone-FILE write must invalidate `parser.invalidateMilestoneCache()` (BacklogParser.ts:193) — NOT `invalidateConfigCache()`.
- `BACKBURNER_BAND` (`'Backburner'`) is already imported in handlers.ts:36 (`import { laneOf, MISC_LANE, BUGS_LANE, BACKBURNER_BAND, … } from '../core/treeLayout';`) — reuse it for the reserved guard.

### Step 1: Write the failing tests

- [ ] Append a `createMilestoneHandler` describe to `src/test/unit/mcpWriteHandlers.test.ts`. Use the file's existing tmpdir idiom (`scaffold()` at :30-51 makes a real `backlog/` with a config; `deps()` builds a real `BacklogParser`/`BacklogWriter`; `beforeEach(scaffold)`/`afterEach` clean up). **Do NOT `vi.mock('fs')`.** Add **BOTH** `createMilestoneHandler` and `listMilestonesHandler` to the EXISTING multiline `from '../../mcp/handlers'` import block (`src/test/unit/mcpWriteHandlers.test.ts:10-23` — **neither is currently imported**). Do **NOT** add a second import statement from that module (a duplicate `import … from '../../mcp/handlers'` trips ESLint `import/no-duplicates` and fails the lint gate):

```ts
describe('createMilestoneHandler', () => {
  it('creates the first milestone as m-0, writes the file, and list_milestones reflects it', async () => {
    const d = deps();
    const res = await createMilestoneHandler(d, { name: 'Foundation', description: 'The baseline age.' });
    expect(res).toEqual({ created: true, id: 'm-0', milestone: 'Foundation' });
    const files = fs.readdirSync(path.join(backlogPath, 'milestones'));
    expect(files.some((f) => /^m-0 - Foundation\.md$/.test(f))).toBe(true);
    const bands = await listMilestonesHandler(d);
    expect(bands.some((b) => b.name === 'Foundation')).toBe(true);
  });

  it('is idempotent on a case-insensitive name dupe (created:false, same id)', async () => {
    const d = deps();
    await createMilestoneHandler(d, { name: 'v1.0' });
    const res = await createMilestoneHandler(d, { name: 'V1.0' });
    expect(res.created).toBe(false);
    expect(res.id).toBe('m-0');
    expect(res.milestone).toBe('v1.0'); // returns the existing canonical name
    expect(fs.readdirSync(path.join(backlogPath, 'milestones'))).toHaveLength(1); // not duplicated
  });

  it('allocates ids in creation order (m-0 then m-1) so band order is creation order (D4)', async () => {
    const d = deps();
    const a = await createMilestoneHandler(d, { name: 'Alpha' });
    const b = await createMilestoneHandler(d, { name: 'Beta' });
    expect(a.id).toBe('m-0');
    expect(b.id).toBe('m-1');
    const bands = await listMilestonesHandler(d);
    const order = bands.filter((x) => x.name === 'Alpha' || x.name === 'Beta').sort((x, y) => x.order - y.order);
    expect(order.map((x) => x.name)).toEqual(['Alpha', 'Beta']); // Alpha (m-0) left of Beta (m-1)
  });

  it('rejects the reserved Backburner band (case-insensitive) — D6', async () => {
    const d = deps();
    await expect(createMilestoneHandler(d, { name: 'Backburner' })).rejects.toThrow(/reserved|Backburner/i);
    await expect(createMilestoneHandler(d, { name: 'backburner' })).rejects.toThrow(/reserved|Backburner/i);
  });

  it('rejects a blank name', async () => {
    await expect(createMilestoneHandler(deps(), { name: '   ' })).rejects.toThrow(/required/);
  });

  it('passes the description through to the milestone file', async () => {
    const d = deps();
    await createMilestoneHandler(d, { name: 'Gamma', description: 'Third age notes.' });
    const file = fs.readdirSync(path.join(backlogPath, 'milestones')).find((f) => /^m-0 - Gamma/.test(f))!;
    const content = fs.readFileSync(path.join(backlogPath, 'milestones', file), 'utf-8');
    expect(content).toContain('Third age notes.');
  });
});
```

### Step 2: Run the tests to verify they fail

- [ ] Run: `bun run test -- mcpWriteHandlers`
  Expected: FAIL — `createMilestoneHandler` does not exist.

### Step 3: Add `createMilestoneHandler` to `handlers.ts`

- [ ] Add the handler + result interface near the other write handlers (immediately after `createCategoryHandler` / `CreateCategoryResult`, handlers.ts:560-592). No new imports needed (`BACKBURNER_BAND` is already imported at :36; `Milestone` is already imported/used at :643):

```ts
export interface CreateMilestoneResult {
  created: boolean;
  id: string;
  milestone: string;
}

/** Add a milestone band (age) to the board by wrapping BacklogWriter.createMilestone (files
 *  under backlog/milestones/). Idempotent on a case-insensitive NAME match against the existing
 *  milestones -> { created:false, id, milestone }. Rejects blank and the reserved 'Backburner'
 *  band (the virtual rightmost band for no-milestone tasks). Band order is CREATION order
 *  (monotonic m-N ids), so there is no `order` param. */
export async function createMilestoneHandler(
  deps: McpHandlerDeps,
  args: { name: string; description?: string }
): Promise<CreateMilestoneResult> {
  const name = args.name?.trim();
  if (!name) throw new Error('A milestone name is required.');
  if (name.toLowerCase() === BACKBURNER_BAND.toLowerCase()) {
    throw new Error(
      `"${name}" is the reserved virtual band (Backburner, for no-milestone tasks) and cannot be created as a milestone.`
    );
  }
  // Idempotent on a case-insensitive name match (mirror create_category's dupe contract).
  const existing = await deps.parser.getMilestones();
  const match = existing.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (match) return { created: false, id: match.id, milestone: match.name };

  const milestone = await deps.writer.createMilestone(
    deps.backlogPath,
    name,
    args.description,
    deps.parser // dedup backstop
  );
  deps.parser.invalidateMilestoneCache();
  return { created: true, id: milestone.id, milestone: milestone.name };
}
```

> The pre-check returns `{created:false}` on a dupe **before** calling the writer, so the writer's own dup-throw never fires on the idempotent path. Passing `deps.parser` to `createMilestone` keeps the writer's throw as a belt-and-suspenders backstop. `invalidateMilestoneCache()` (NOT `invalidateConfigCache()`) is required so the very next `getMilestones()`/`listMilestonesHandler` re-reads the new file.

### Step 4: Register `create_milestone` in `server.ts`

- [ ] Add `createMilestoneHandler` to the `./handlers` import block (server.ts:23-44 — insert alongside `createCategoryHandler`). Then register the tool immediately after the `create_category` block (server.ts:223-234), wrapped in `runTool`:

```ts
  server.registerTool(
    'create_milestone',
    {
      title: 'Create milestone',
      description:
        'Add a new milestone band (age) to the board. Milestones are ordered by CREATION order (oldest → newest, left → right on the tech-tree), so create them in chronological order. Idempotent: an existing milestone (case-insensitive name) returns { created:false, id, milestone } rather than erroring. The reserved virtual band "Backburner" (the rightmost band for tasks with no milestone) is refused. See list_milestones for the current bands.',
      inputSchema: {
        name: z.string().describe('The milestone/age name, e.g. "v1.0" or "Foundation".'),
        description: z.string().optional().describe('Optional milestone description.'),
      },
    },
    async (args) => runTool(() => createMilestoneHandler(deps, args))
  );
```

### Step 5: Build + tests + typecheck

- [ ] Run: `bun run test -- mcpWriteHandlers && bun run typecheck && bun run lint && bun run build` → PASS.

### Step 6: Full task gate

- [ ] **Worktree prerequisites (restated inline for a worker dispatched with only this slice):** in the fresh worktree run `bun install` **once** before the first `bun run build`/`test`. On Windows, ~22 upstream POSIX-path unit tests fail pre-existing — that is the **pass floor**; do **not** try to fix them or treat them as regressions.
- [ ] Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS (no webview change; the tree Playwright set is a regression check).

### Step 7: Commit

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit --no-verify -m "feat(tree P6): create_milestone MCP tool (wraps BacklogWriter.createMilestone)

- createMilestoneHandler mirrors createCategoryHandler: idempotent on a case-insensitive
  name (created:false + existing id), reserved-guard on 'Backburner' only (D6), blank
  rejected; wraps BacklogWriter.createMilestone (files under backlog/milestones/, D3) and
  invalidateMilestoneCache after write
- schema { name, description? } — no order param; band order is creation order (monotonic
  m-N ids, D4). Registered via runTool
- tmpdir handler tests: m-0 first + list_milestones reflects it, idempotent dup, m-0/m-1
  creation order, Backburner rejected, blank rejected, description passed through

Co-Authored-By: <DeepSeek model line per AGENTS.md>"
```

**Dependencies:** none (additive to `handlers.ts`/`server.ts`).

---

## Task 3: `/index-codebase` SKILL.md (D7/D8) [deepseek]

**Model:** DeepSeek worker — `ch worker --profile deepseek --spec <this-task> --worktree --scope .claude/skills/index-codebase/SKILL.md`. **Transcription-grade** — the full SKILL.md is provided verbatim below; byte-copy it. **Per-slice Opus HARD-read-only review** confirms the frontmatter parses and the `allowed-tools` names match registered tools/skills.

**Files:**

- Create: `.claude/skills/index-codebase/SKILL.md`

**Goal (D7/D8):** the skill is P6's user-facing deliverable. It encodes the spec §3 six-step loop adapted to D1/D7 (baseline = **Done draft**, gap = **To-Do draft**; **confirm before writing**; drafts emitted **dependency-order**; the skill does **not** promote), with the D8 `allowed-tools` set, a mission paragraph ending in a **Parity** sentence, a `## When to use` (with a negative), a `## Subscription safety` (never `claude -p`), the six-step `## The loop`, a domain section on **dedupe / re-runnability**, and terse `## Rules of thumb`. It is validated by review + a scenario walkthrough, not a unit test. **It depends on Tasks 1+2** (Done drafts + `create_milestone`) for coherence, but is transcription-only — green in isolation.

### Step 1: Create the skill (byte-copy the content below)

- [ ] Create `.claude/skills/index-codebase/SKILL.md` with exactly this content (frontmatter matches the house YAML-fence format of `.claude/skills/create-task/SKILL.md:1-5`). The written file's **first** line must be `---` and its **last** line the final rule-of-thumb; do **NOT** copy the plan's surrounding fenced-code wrapper (the `` ```markdown `` opening line and its matching closing fence below) — that fence is only the plan's delimiter, not part of the skill file:

````markdown
---
name: index-codebase
description: Bootstrap an initial Taskwright tech-tree over an EXISTING repo. Reads git history, module structure, and docs ("forensics") to reconstruct the already-built foundation as Done baseline drafts and mine visible gaps (TODO/FIXME) as To-Do drafts, then applies everything as draft nodes the human reviews and promotes on the board. Use when the user says /index-codebase, or asks to "bootstrap the tree", "index the codebase", "reconstruct the board from the repo", or "populate the tech-tree from history". Re-runnable and deduped against the live board; never promotes for you.
allowed-tools: Bash, Read, Grep, Glob, mcp__taskwright__list_categories, mcp__taskwright__list_milestones, mcp__taskwright__get_board, mcp__taskwright__search_tasks, mcp__taskwright__create_category, mcp__taskwright__create_milestone, mcp__taskwright__create_task, mcp__taskwright__edit_task, Skill(superpowers:brainstorming)
---

# Index codebase (Taskwright tree bootstrap)

Reconstruct an initial tech-tree from an existing repository: read git history, module
structure, and docs ("forensics"), infer the major built foundation and the visible gaps, and
propose the result as **draft nodes** — **Done** baseline drafts for what already exists,
**To-Do** drafts for the gaps — that the human reviews and promotes on the canvas. Parity:
every tool here is one a human can drive by hand via the P3/P4 board — you are deriving a
proposal from the repo, not bypassing review.

## When to use

- The user invokes `/index-codebase`, or asks you to bootstrap / reconstruct / populate the
  tech-tree from an existing codebase or its history.
- Best on a **fresh** Taskwright mount over a repo with real history — an empty (or nearly
  empty) board that needs a foundation for new work to attach to.
- Not for authoring a single feature's tasks from a brief — that is `/create-task`. This skill
  reconstructs the *existing* structure; it does not decompose new scope.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any
headless agent. Forensics use local `Bash`/`Read`/`Grep`/`Glob`; every board write goes through
the `taskwright` MCP tools. `superpowers:brainstorming` (optional, for genuinely ambiguous
scope) runs in-session.

## The loop

Granularity is deliberately **coarse** — tens of nodes for a typical project, capturing major
subsystems, releases, and decisions, not per-file detail.

1. **Survey** — see what already exists so the bootstrap is **additive**:
   - `list_categories` — the existing lanes (with counts; reserved: Misc/Bugs).
   - `list_milestones` — the existing bands in board order (Backburner = no milestone).
   - `get_board` — the live board (active tasks + existing drafts) to dedupe against.

2. **Forensics** — inspect the repo (read-only Bash/Read/Grep/Glob):
   - **git** — tags/releases (`git tag`, `git log --tags`), commit clusters and file churn,
     dates/authors (`git log --stat`, `git shortlog`) for chronology and phases.
   - **structure** — top-level modules/dirs, package manifests (package.json, pyproject,
     Cargo.toml, go.mod…), entry points, and the module dependency graph.
   - **docs** — README, CHANGELOG, `backlog/decisions/` or ADRs, architecture notes.

3. **Reconstruct (coarse)** — form the proposal in memory (do not write yet):
   - top-level modules/areas → **lanes** (reuse existing categories by sideways traversal;
     only a genuinely new area becomes a new `create_category`).
   - git tags/releases (or inferred phases when untagged) → **milestone ages**, ordered
     **oldest → newest** (they render left→right by creation order — so you will create them
     oldest-first in step 5).
   - major subsystems/features/decisions → **Done baseline drafts** in the age they were built.
   - module dependency graph + build chronology → **dependencies** (each checked so it never
     forms a cycle; design the graph acyclic — the tools reject cycles).

4. **Mine gaps** — scan `TODO`/`FIXME`/`XXX` markers (`Grep`) and obvious structural gaps →
   **To-Do drafts**, attached (as dependents) to the relevant baseline module, in the current
   age (or Backburner when the flow position is unknown). A `FIXME` is a candidate **bug**
   (`type: "bug"`, `causedBy` the baseline it regresses) but defaults to a plain task unless it
   is clearly a defect.

5. **Propose as drafts (confirm before writing)** — first print a **reconstruction summary**:
   *N lanes (X new), M ages, K Done baseline drafts, J To-Do gap drafts, and the key edges.*
   **Wait for the user's confirmation** before any write — lanes (`create_category`) and ages
   (`create_milestone`) land in config/on-disk immediately, and Done baseline drafts touch the
   board. On confirmation, write in this order so every reference resolves:
   - `create_category` for each approved new lane; `create_milestone` for each age, **oldest
     first** (creation order = left→right band order).
   - `create_task` for each node, in **dependency order (prerequisites first)** — edges are the
     `dependencies` array and a prerequisite must exist before a dependent can name it. Set
     `draft: true`, `status: "Done"` for a **baseline** node (a Done draft) and `draft: true`
     with **no status** (defaults to To Do) for a **gap** node, plus `category`, `priority`,
     `milestone`, and `dependencies` in the one call (drafts carry all of these). Use
     `type: "bug"` + `causedBy` for a bug node.
   - Acceptance criteria are **not** a `create_task` field — add them to a gap draft with a
     follow-up `edit_task` after the draft exists.
   - Everything renders as **proposed (draft) nodes** on the tree canvas.

6. **Hand off to review** — tell the user the reconstruction is on the tree as draft nodes.
   They edit / reslot / connect / disconnect (P3 gestures) and **promote** what they accept —
   single (per-node Promote) or all at once ("Promote all proposed"). **Do not promote for
   them; discarded drafts leave no trace.**

## Dedupe & re-runnability

The skill is **re-runnable** (e.g. after more history accrues). Before proposing anything, and
before each write, dedupe against the live board:

- Use `get_board` and `search_tasks` (on a node's key terms) to find existing nodes; **extend
  or link** to them rather than creating a near-duplicate.
- The board universe the tools see is **tasks + drafts only** — completed and archived tasks
  are invisible to `get_board`/`search_tasks`, so a foundation already archived will not be
  detected; note this limit to the user rather than re-proposing archived work.
- Prefer a dependency edge to an existing node over a duplicate baseline.
- A **config-only** milestone (a `milestones:` entry in `config.yml` with no file in
  `backlog/milestones/` yet) is matched by `create_milestone`'s idempotency check and returns
  `{ created: false }` **without** writing a file; because milestone reads are file-first, a
  config-only age is shadowed once any real `m-N` file exists — so when bootstrapping ages,
  prefer (re)creating the intended ages as **real milestone files**.

## Rules of thumb

- Coarse, not exhaustive — major subsystems/releases/decisions, tens of nodes.
- Baseline = **Done draft**; gap = **To-Do draft**; everything provisional until the human promotes.
- Ages are created oldest-first (creation order = left→right band order).
- Emit drafts prerequisites-first; design the dependency graph acyclic.
- Reuse a lane before creating one; a new lane is a decision to surface, not assume.
- Confirm the reconstruction summary before writing; never promote — the human does.
- Subscription-safe: forensics via Bash/Read/Grep/Glob, writes via MCP, never `claude -p`.
````

### Step 2: Sanity-check the skill loads

- [ ] Confirm the frontmatter parses (YAML fence; `name`/`description`/`allowed-tools`) and that every `allowed-tools` name matches a registered MCP tool (`mcp__taskwright__list_categories`, `…list_milestones`, `…get_board`, `…search_tasks`, `…create_category`, `…create_milestone`, `…create_task`, `…edit_task`) or a real skill (`Skill(superpowers:brainstorming)`). No unit test — skills are prose, validated by review + a scenario walkthrough.

### Step 3: Full task gate

- [ ] **Worktree prerequisites (restated inline for a worker dispatched with only this slice):** in the fresh worktree run `bun install` **once** before the first `bun run build`/`test`. On Windows, ~22 upstream POSIX-path unit tests fail pre-existing — that is the **pass floor**; do **not** try to fix them or treat them as regressions.
- [ ] Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS (skill-only; the gate is a regression check).

### Step 4: Commit

```bash
git add .claude/skills/index-codebase/SKILL.md
git commit --no-verify -m "docs(tree P6): /index-codebase skill

- .claude/skills/index-codebase/SKILL.md: survey -> forensics (git/structure/docs) ->
  reconstruct (lanes/ages/Done baseline drafts/deps w cycle-check) -> mine gaps (TODO/FIXME
  -> To-Do drafts) -> propose as drafts (confirm-before-write; AC via follow-up edit_task;
  dependency-order) -> hand off to review (human promotes; skill never promotes)
- allowed-tools per D8 (read/traverse + create_category/create_milestone/create_task/
  edit_task + brainstorming); dedupe/re-runnability domain section; subscription-safe

Co-Authored-By: <DeepSeek model line per AGENTS.md>"
```

**Dependencies:** Tasks 1 (Done drafts) + 2 (`create_milestone`) for coherence — the skill's prose references both. Transcription-only, so no build/runtime dependency (green in isolation).

---

## Task 4: Docs + full gate + close [opus]

**Model:** Opus (judgment: CLAUDE.md bullet density/style, run-notes, gate + close discipline).

**Files:**

- Modify: `CLAUDE.md`
- Verification/close only (no other code)

**Goal:** doc-sync the phase and run the final gate. Add the CLAUDE.md P6 bullet before `## Conventions`, reference the plan doc path, update the run ledger, and run the full regression gate. **This task does NOT call `request_merge` or `complete_task`** — for this autonomous orchestrated run the branch is landed by the **orchestrator** via a root `git merge --ff-only` (with explicit user `AskUserQuestion` authorization), matching the shipped P4/P5 close tasks. Task 4 hands back at "docs committed, worktree clean, all gates green, ledger updated."

### Step 1: CLAUDE.md — add the P6 bullet

- [ ] In `CLAUDE.md`, insert the P6 bullet immediately after the P5 bullet (which currently ends at line 195, `plan: …p5-execute-task-skill.md`) and **before** `## Conventions` (line 197), matching the existing `- **Tech-tree …**` bullets' density/style:

```markdown
- **Tech-tree codebase-indexing skill + status-carrying drafts (P6)** ✅: bootstraps an initial
  tree over an **existing** repo. Foundation fix — **status-carrying drafts**: a draft is a
  provisional/discardable *overlay* orthogonal to completion status (the marker is
  `folder==='drafts'`, never a synthetic `status: Draft`), so a draft can be **Done**.
  `create_task {draft:true}` now accepts a valid `status` (`src/core/createTaskCore.ts`; an unknown
  status is still rejected by the MCP handler), `BacklogWriter.createDraft` writes the given status
  (default = `config.default_status`, else `To Do`), `BacklogParser.getDrafts` reflects the **real**
  frontmatter status (legacy `status: Draft` files aliased to the board default on read), and
  `promoteDraft`/`demoteTask` **preserve** status (a Done draft promotes to a Done task; symmetric on
  demote) instead of clobbering to default/`Draft`. Webview provisional styling stays folder-driven
  (`TreeNode`/`DetailPopover`/`TechTreeCanvas` `isDraft` — the folder arm), so P1–P5 rendering is
  unchanged. New MCP tool **`create_milestone`** `{name, description?}` (`createMilestoneHandler`,
  `src/mcp/handlers.ts`) wraps `BacklogWriter.createMilestone` (files under `backlog/milestones/`,
  D3): idempotent on a case-insensitive name → `{created:false,id,milestone}`, reserved-guard on
  `Backburner` only (D6), band order = **creation order** (monotonic `m-N` ids, so ages are created
  oldest→newest; **no `order` param**, D4). The **`/index-codebase` skill**
  (`.claude/skills/index-codebase/SKILL.md`) reads git history + module structure + docs
  ("forensics") to reconstruct the built foundation as **Done baseline drafts** and mine
  `TODO`/`FIXME` gaps as **To-Do drafts**, all deduped against the live board (tasks+drafts only) and
  applied **as drafts** the human reviews and promotes — the skill prints a reconstruction summary and
  **confirms before writing**, emits drafts in dependency order, and does **not** promote (parity:
  every tool is one a human can drive via P3/P4; subscription-safe — never `claude -p`). Completes the
  tech-tree spec set (P1–P6). Coverage:
  `src/test/unit/{createTaskCore,BacklogWriter,BacklogParser,mcpWriteHandlers}.test.ts` (+ full
  Playwright/CDP regression on the draft-model change). Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p6-codebase-indexing-design.md`; plan:
  `docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md`.
```

### Step 2: Update the run ledger

- [ ] Update `.superpowers/tech-tree-run/` (HANDOFF.md / ledger) to mark P6 built: link this plan, note the three workstreams landed (status-carrying drafts, `create_milestone`, `/index-codebase`), and record the branch (`tech-tree-p6`) + final gate counts.

### Step 3: Full regression gate

- [ ] Run, in the worktree:

```bash
bun run build && bun run test && bun run lint && bun run typecheck && bun run test:playwright && bun run test:cdp
```

Expected: PASS. Record the exact new totals against the branch-base baselines captured in Task 1 Step 1:
- **Unit:** baseline + the new/updated cases (`createTaskCore`, `BacklogWriter`, `BacklogParser`, `mcpWriteHandlers`).
- **Playwright + CDP:** baseline (no webview change; the draft-model regression was already proven at Task 1 Step 8 — re-run here as the close gate).
- Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix".)

### Step 4: Commit the docs

```bash
git add CLAUDE.md .superpowers/tech-tree-run/
git commit --no-verify -m "docs(tree P6): CLAUDE.md P6 bullet + run ledger

- CLAUDE.md: P6 codebase-indexing + status-carrying-drafts bullet (marked done),
  before ## Conventions; links the plan + design docs
- run ledger updated: P6 built (status-carrying drafts, create_milestone, /index-codebase)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Step 5: Hand back for the orchestrator to land

- [ ] Confirm the worktree is clean (`git status` shows nothing uncommitted), the docs are committed, the ledger is updated, and all gates are green — then **hand back to the orchestrator**. **Do NOT call `request_merge` or `complete_task`.** For this autonomous orchestrated run the branch is landed by the **orchestrator** via a root `git merge --ff-only` (with explicit user `AskUserQuestion` authorization), per `.superpowers/tech-tree-run/HANDOFF.md` — this **supersedes** the generic `request_merge` close and matches the shipped P4/P5 close tasks. Do not merge/commit/push from the repo root yourself; the orchestrator owns the root ff-merge step.

**Dependencies:** Tasks 1–3 (documents the whole phase; the close gate covers all three slices).

---

## Self-Review

**1. Directive → task mapping (P6):**

- **D1 (baseline = Done DRAFT; drafts orthogonal to status)** → the whole Task 1 model + the skill's baseline=Done-draft prose (Task 3 step 5).
- **D2 (status-carrying drafts foundation: a create_task draft accepts status; createDraft writes it; getDrafts reflects real status; promoteDraft preserves; align demote)** → Task 1 (a–e) + the mandatory blast-radius survey + backward-compat alias.
- **D3 (create_milestone wraps the writer, not a config clone)** → Task 2 handler wrapping `BacklogWriter.createMilestone` + `invalidateMilestoneCache`.
- **D4 (drop `order`; schema `{name, description?}`; creation order = band order)** → Task 2 schema + the "creation order" test + the skill's oldest-first creation prose.
- **D5 (idempotent; result `{created,id,milestone}`; register via runTool)** → Task 2 handler pre-check + registration.
- **D6 (reserved guard = Backburner only, not isReservedCategory)** → Task 2 guard + the Backburner-rejected test.
- **D7 (skill applies drafts; does NOT promote; confirms before writing; baseline=Done draft / gap=To-Do draft; dedupe; AC via edit_task; drafts dependency-order)** → Task 3 SKILL.md loop + dedupe section.
- **D8 (allowed-tools set; mission ends in Parity; dedicated Subscription safety)** → Task 3 frontmatter + body.

**2. Locked-name compliance:** `create_milestone` `{name, description?}` (no `order`); `createMilestoneHandler`; `CreateMilestoneResult {created,id,milestone}`; reserved = `Backburner` only; `createDraft(…, {…, status?})`; `getDrafts` real status; `promoteDraft`/`demoteTask` preserve. No new webview message, no new frontmatter, no Svelte edit.

**3. Parity:** `create_milestone` wraps the same writer a human's board flow uses; `create_task {draft, status}` routes through the shared `createTaskWithTreeFields`; the skill only derives a proposal from the repo — the human promotes (identical to `/create-task`). No dependency write bypasses `wouldCreateCycle`.

**4. Scope discipline:** no `order` param, no config-line milestone clone, no semantic search, no promote/subtask tool for the skill, no new webview surface/CDP file, no new frontmatter. The demote alignment (D2e) is included (not deferred) to prevent silent status loss — a small symmetric change with two bounded test updates.

**5. Leaves-first build integrity:** Task 1 (draft model) is the substrate; Task 2 (independent, additive) adds the age tool; Task 3 writes the skill over the surfaced model+tool (transcription; green in isolation); Task 4 docs + full gate + close. Each task ends green (`bun run test` + `tree-` Playwright + lint + typecheck; `bun run build` where a bundle changed). The **full** Playwright + **full** CDP run is bound to Task 1 (the only cross-view-risk change — the shared draft derivation) and re-run at the Task 4 close.

**6. Verify commands are per-task and concrete** (`bun run test -- <suite>`, `bun run test:playwright -- tree-`, the full `bun run test:playwright`/`bun run test:cdp` at Tasks 1 & 4). Commits stage only named files and use `--no-verify` (Windows CRLF hook). Model tiers: Tasks 1 & 4 opus (cross-cutting model change / judgment); Tasks 2 & 3 DeepSeek (self-contained mechanical mirror + verbatim transcription), each with an Opus hard-read-only review.

**7. Every test has a falsification path:** `createTaskCore` (draft passes a valid status to createDraft vs the inverted throw; no-status → `status: undefined` positive control); `BacklogWriter` (createDraft given/default status; promoteDraft preserves a real `Done` while the legacy `Draft`→default test still passes; demote preserves `In Progress`); `BacklogParser` (getDrafts reflects `To Do`/`In Progress`, legacy `Draft`→`To Do` alias with folder intact); `mcpWriteHandlers` (Done-draft round-trips to a `status: Done` file and promotes to a Done task; demote preserves `To Do`; `create_milestone` m-0-first/idempotent/creation-order/Backburner-rejected/blank-rejected/description-through). No vacuous assertions.

## Open questions

None block implementation; the directives adjudicate every known fork. Three residual judgment calls are recorded inline rather than raised as blockers:

1. **`createDraft` default status = `config.default_status ?? 'To Do'`** (not literally `'To Do'` as the directive's shorthand reads). This is a deliberate refinement so authoring a draft without a status, then promoting, is **byte-identical** to the pre-P6 flow when the board default is not `'To Do'`. Falls back to `'To Do'` with no config. **RATIFIED by orchestrator** — keep `config.default_status ?? 'To Do'` (it preserves the byte-identical pre-P6 promote behavior when the board default differs); no code change, this records the ratification only.
2. **Demote alignment (D2e) is included, not deferred.** The directive permits "or note as an explicit follow-up"; aligning demote (drop the synthetic `'Draft'` write) prevents a real bug under the new model (a Done task demoted would otherwise silently become a To-Do draft) and costs only two test updates. **RATIFIED by orchestrator** — the demote-to-draft status-**PRESERVE** alignment (D2e) is **IN scope** (it prevents a Done task silently becoming a To-Do draft on demote); do **not** defer, no code change, this records the ratification only.
3. **The full CDP run is a regression check at Task 1**, not a new CDP spec — P6 adds no webview/controller code (drafts already render via P4 GAP-1's folder arm), so there is no new cross-view behavior to author; the existing `tree-promote` CDP suite exercises the draft-promote path the model change touches.
