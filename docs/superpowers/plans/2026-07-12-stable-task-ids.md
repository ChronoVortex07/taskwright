# Stable Task IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task carries the ID it will keep from creation — a draft is `TASK-112`, not `DRAFT-3` — so promotion never changes an ID and a reference written against a draft stays valid forever. Boards with existing `DRAFT-N` files migrate themselves automatically.

**Architecture:** Drafts mint from the *task* counter into `backlog/drafts/`; `folder === 'drafts'` remains the sole draftness marker, which it already is everywhere in the codebase. Promote and demote collapse to pure file moves. This forces three fixes that are latent bugs today: the next-ID scan must cover every folder, the allocation lock must move to one shared namespace (or the shared counter re-arms the TASK-48 clobber race), and archive/restore must route by folder instead of by ID prefix. A new pure `draftIdMigration` core converges legacy boards, driven from both extension activation and MCP server startup.

**Tech Stack:** TypeScript, Node `fs`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-stable-task-ids-design.md`

## Global Constraints

- **The folder is the draftness marker, never the ID.** `folder === 'drafts'`. Do not introduce a `draft: true` frontmatter field, and do not add any new branch on an ID prefix — this plan *removes* the last one.
- **Never break frontmatter byte-compatibility with Backlog.md.** All writes go through `BacklogWriter`'s existing `reconstructFile` / `extractFrontmatter` and `atomicWriteFileSync`. Field order and formatting rules are in `CLAUDE.md` under "Task YAML Frontmatter".
- **Every write preserves CRLF/LF.** Follow the existing `detectCRLF` / `normalizeToLF` / `restoreLineEndings` sandwich used in `promoteDraft` — this repo is developed on Windows and a line-ending flip corrupts the whole file in git.
- **Migration must never block activation.** It runs inside `createDeferredRunner` (`src/core/deferredBootstrap.ts`), which by contract never rejects into `activate()`. TASK-109 moved every git/fs burst out of the activation path; do not regress that.
- **Migration must be idempotent.** A board with no legacy drafts performs **zero writes**.
- **TDD**: write the failing test first, watch it fail, then implement.
- Verify commands: `bun run test`, `bun run lint`, `bun run typecheck`. All three must pass before a task is done.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/idRemap.ts` | **Create.** Pure: rewrite every inbound reference to a set of renamed IDs. Extracted from `promoteDrafts`, closing its three gaps. |
| `src/core/draftIdMigration.ts` | **Create.** Pure planner + executor that converges a legacy `DRAFT-N` board. |
| `src/core/BacklogWriter.ts` | **Modify.** Global next-ID scan; shared lock namespace; `createDraft` mints `TASK-N`; promote/demote become pure moves; archive/restore route by folder. |
| `src/core/promoteDrafts.ts` | **Modify.** Remap pass delegates to `idRemap`; fires only for legacy (`from !== to`) entries. |
| `src/core/boardDoctor.ts` | **Modify.** New `legacy-draft-ids` finding + `migrate-draft-ids` repair. |
| `src/extension.ts` | **Modify.** Run the migration inside the deferred bootstrap. |
| `src/mcp/server.ts` | **Modify.** Run the migration at startup; correct the tool descriptions that promise `DRAFT-N`. |
| `.claude/skills/create-task/SKILL.md`, `.claude/skills/index-codebase/SKILL.md` | **Modify.** IDs are now stable from birth. |
| `CLAUDE.md`, `AGENTS.md` | **Modify.** Document the one ID space. |

**Task order is load-bearing.** `idRemap` (Task 1) is a dependency of both `promoteDrafts` (Task 1) and the migration (Task 6). The allocator changes (Task 2) must land before `createDraft` starts minting task IDs (Task 3), or drafts and tasks will collide.

---

### Task 1: Extract the reference-remap core

**Files:**
- Create: `src/core/idRemap.ts`
- Create: `src/test/unit/idRemap.test.ts`
- Modify: `src/core/promoteDrafts.ts:96-125` (the remap pass)

**Interfaces:**
- Consumes: `BacklogParser`, `BacklogWriter`, `TreeFieldService` (existing).
- Produces:
  ```ts
  export interface IdRemapDeps { parser: BacklogParser; writer: BacklogWriter; treeFieldService: TreeFieldService; }
  export function remapIds(deps: IdRemapDeps, oldToNew: Map<string, string>): Promise<string[]>;
  ```
  Returns the IDs of every task whose references were rewritten. `oldToNew` keys are **uppercased**. Task 6 calls this.

`promoteDrafts` today rewrites only `dependencies` and bug `caused_by`. It silently dangles `parent_task_id`, `subtasks`, and `references[]`. The migration would reintroduce those three gaps if it rolled its own pass — so extract one core and fix them once.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/idRemap.test.ts`. Follow the existing fixture pattern in `src/test/unit/promoteDrafts.test.ts` (read it first — reuse its temp-board helper rather than inventing one).

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { remapIds } from '../../core/idRemap';
// ...plus the temp-board / parser / writer / treeFieldService setup copied from
// promoteDrafts.test.ts's beforeEach.

describe('remapIds', () => {
  it('rewrites dependencies', async () => {
    // Board: TASK-9 depends on DRAFT-3.
    const remapped = await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-12']);
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites a bug caused_by', async () => {
    // Board: TASK-9 is a bug caused by DRAFT-3.
    await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.causedBy).toBe('TASK-12');
  });

  it('rewrites parent_task_id (the gap promoteDrafts never closed)', async () => {
    // Board: TASK-9 has parent_task_id DRAFT-3.
    await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.parentTaskId).toBe('TASK-12');
  });

  it('rewrites subtasks (the gap promoteDrafts never closed)', async () => {
    // Board: TASK-9 has subtasks [DRAFT-3].
    await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.subtasks).toEqual(['TASK-12']);
  });

  it('rewrites references[] (the gap promoteDrafts never closed)', async () => {
    // Board: TASK-9 has references ['DRAFT-3'].
    await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.references).toEqual(['TASK-12']);
  });

  it('leaves unrelated ids untouched', async () => {
    // Board: TASK-9 depends on TASK-5.
    const remapped = await remapIds(deps, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-5']);
    expect(remapped).not.toContain('TASK-9');
  });

  it('does not partially rewrite an id that shares a prefix', async () => {
    // Board: TASK-9 depends on ['DRAFT-1', 'DRAFT-11'].
    // Remapping DRAFT-1 must NOT touch DRAFT-11.
    await remapIds(deps, new Map([['DRAFT-1', 'TASK-20']]));
    const t9 = await parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-20', 'DRAFT-11']);
  });

  it('performs no writes when nothing matches', async () => {
    const remapped = await remapIds(deps, new Map([['DRAFT-99', 'TASK-99']]));
    expect(remapped).toEqual([]);
  });
});
```

The prefix test matters: the remap must compare **whole IDs**, never do a substring/regex replace. `DRAFT-1` must not match inside `DRAFT-11`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun run test -- idRemap`
Expected: FAIL — cannot resolve `../../core/idRemap`.

- [ ] **Step 3: Write the implementation**

Create `src/core/idRemap.ts`:

```ts
/**
 * Rewrite every inbound reference to a set of renamed task ids. vscode-free.
 *
 * Extracted from promoteDrafts' remap pass, which only ever rewrote `dependencies` and
 * bug `caused_by` — leaving `parent_task_id`, `subtasks`, and `references[]` to dangle
 * silently. Both promoteDrafts (legacy re-id) and draftIdMigration use this one core, so
 * those gaps close in both places at once.
 *
 * Ids are compared as WHOLE, uppercased ids — never as substrings. A substring rewrite
 * would corrupt TASK-11 while remapping TASK-1.
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';

export interface IdRemapDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  treeFieldService: TreeFieldService;
}

/** Map a single id through the rename map, or return it unchanged. */
function mapped(id: string, oldToNew: Map<string, string>): string | undefined {
  return oldToNew.get(id.trim().toUpperCase());
}

/**
 * Rewrite dependencies / caused_by / parent_task_id / subtasks / references across the
 * whole live board (tasks + drafts). Returns the ids of every task actually rewritten.
 *
 * The board is re-read here, so callers must have finished their file moves first.
 */
export async function remapIds(
  deps: IdRemapDeps,
  oldToNew: Map<string, string>
): Promise<string[]> {
  if (oldToNew.size === 0) return [];

  const [tasks, drafts] = await Promise.all([deps.parser.getTasks(), deps.parser.getDrafts()]);
  const remapped: string[] = [];

  for (const t of [...tasks, ...drafts]) {
    const updates: Record<string, unknown> = {};

    const nextDeps = t.dependencies.map((d) => mapped(d, oldToNew) ?? d);
    if (nextDeps.some((d, i) => d !== t.dependencies[i])) {
      updates.dependencies = nextDeps;
    }

    if (t.parentTaskId) {
      const to = mapped(t.parentTaskId, oldToNew);
      if (to) updates.parentTaskId = to;
    }

    if (t.subtasks?.length) {
      const nextSubs = t.subtasks.map((s) => mapped(s, oldToNew) ?? s);
      if (nextSubs.some((s, i) => s !== t.subtasks![i])) {
        updates.subtasks = nextSubs;
      }
    }

    if (t.references?.length) {
      const nextRefs = t.references.map((r) => mapped(r, oldToNew) ?? r);
      if (nextRefs.some((r, i) => r !== t.references![i])) {
        updates.references = nextRefs;
      }
    }

    let changed = false;
    if (Object.keys(updates).length > 0) {
      await deps.writer.updateTask(t.id, updates, deps.parser);
      changed = true;
    }

    // causedBy is a Taskwright tree field, written surgically — not via updateTask.
    if (t.type === 'bug' && t.causedBy) {
      const to = mapped(t.causedBy, oldToNew);
      if (to) {
        await deps.treeFieldService.setCausedBy(t.id, to, deps.parser);
        changed = true;
      }
    }

    if (changed) remapped.push(t.id);
  }

  return remapped;
}
```

**Before implementing:** confirm `BacklogWriter.updateTask` actually accepts `parentTaskId`, `subtasks`, and `references` in its update payload, and confirm the exact property names on the parsed `Task` type (`src/core/types.ts`). If `updateTask` does not support a field, extend it — do not silently skip the field.

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun run test -- idRemap`
Expected: PASS — 8 tests.

- [ ] **Step 5: Repoint `promoteDrafts` at the shared core**

Replace `promoteDrafts.ts` lines 96-125 (the inline remap pass) with:

```ts
  // Remap inbound references across the live board. Reload happens inside remapIds, AFTER
  // promotion, so promoted files (now in tasks/) are seen with current content.
  //
  // Only LEGACY drafts (DRAFT-N → TASK-M) actually change id. A stable-id draft promotes in
  // place (from === to), so its map entry is dropped and there is nothing to rewrite.
  const oldToNew = new Map(
    promoted
      .filter((p) => p.from.trim().toUpperCase() !== p.to.trim().toUpperCase())
      .map((p) => [p.from.trim().toUpperCase(), p.to])
  );
  const remapped = await remapIds(deps, oldToNew);

  return { promoted, remapped };
```

Add the import at the top of `promoteDrafts.ts`:

```ts
import { remapIds } from './idRemap';
```

`PromoteDraftsDeps` is structurally identical to `IdRemapDeps`, so `deps` passes through unchanged.

- [ ] **Step 6: Run the promoteDrafts suite**

Run: `bun run test -- promoteDrafts`
Expected: PASS — the existing tests still pass through the extracted core.

- [ ] **Step 7: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/core/idRemap.ts src/core/promoteDrafts.ts src/test/unit/idRemap.test.ts
git commit -m "Extract the id-remap pass into a shared core

promoteDrafts only rewrote dependencies and caused_by, silently dangling
parent_task_id, subtasks and references[]. One core now rewrites all five,
comparing whole ids (never substrings, so TASK-1 can't corrupt TASK-11).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Global next-ID scan and a shared allocation lock

**Files:**
- Modify: `src/core/BacklogWriter.ts:1041-1075` (`getNextTaskId`), `:891-929` (`allocateAndWrite`), `:756-761` (`createTask` call site)
- Test: `src/test/unit/BacklogWriter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getNextTaskId(backlogPath: string, prefix: string, crossBranchIds?: string[]): number` — **signature changes**: it now takes the **backlog root**, not `tasksDir`, and scans `tasks/`, `drafts/`, `completed/`, `archive/tasks/`, `archive/drafts/`. Tasks 3, 4, and 6 call it.
  - `allocateAndWrite<T>(backlogPath, dir, startId, lockDirName, buildFile)` — **signature changes**: it takes the backlog root so the lock lives in one shared `backlog/.locks/` directory regardless of which subfolder the file lands in.

**Why the lock must move.** `allocateAndWrite` is the mutex that fixed the TASK-48 concurrent-create clobber. It works by `mkdir`-ing a lock dir keyed on the numeric ID — but *inside the target directory*: `tasks/.task-N.lock` vs `drafts/.draft-N.lock`. Two directories, two lock namespaces that cannot see each other. That is harmless while the counters are separate and a **live clobber race** the moment they share one. This must land before Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/BacklogWriter.test.ts`:

```ts
describe('getNextTaskId (global scan)', () => {
  it('takes the max across tasks/, drafts/, completed/ and archive/', async () => {
    // Seed: tasks/task-3, drafts/task-7, completed/task-5, archive/tasks/task-9
    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(id).toBe('TASK-10');   // 9 is the max anywhere, not 3 (tasks/ alone)
  });

  it('does not let a restored archived task collide with a live task', async () => {
    // Seed: archive/tasks/task-12; tasks/ has only task-2.
    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(id).toBe('TASK-13');
  });

  it('ignores a legacy draft-N filename when scanning drafts/ for the task prefix', async () => {
    // Seed: drafts/draft-99 (legacy), tasks/task-2.
    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(id).toBe('TASK-3');   // draft-99 does not carry the task prefix
  });
});

describe('allocateAndWrite (shared lock namespace)', () => {
  it('gives distinct ids to a concurrent createTask and createDraft', async () => {
    // The TASK-48 clobber, re-armed by the shared counter. Both scan the same max,
    // both try to claim it; the shared lock dir must let exactly one win.
    const [a, b] = await Promise.all([
      writer.createTask(backlogPath, { title: 'A' }, parser),
      writer.createDraft(backlogPath, parser, { title: 'B' }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(fs.existsSync(a.filePath)).toBe(true);
    expect(fs.existsSync(b.filePath)).toBe(true);
  });
});
```

The concurrency test depends on Task 3's `createDraft` minting task IDs. Write it now, expect it to fail, and let Task 3 turn it green — note that in the commit.

- [ ] **Step 2: Run and verify they fail**

Run: `bun run test -- BacklogWriter`
Expected: FAIL on the global-scan cases (`TASK-4` instead of `TASK-10`).

- [ ] **Step 3: Rewrite `getNextTaskId` to scan every folder**

Replace `getNextTaskId` (lines 1037-1075):

```ts
  /**
   * The folders a task id can live in. A task id must be unique across ALL of them:
   * scanning only tasks/ is why a restore from archive/ could land on a live task's id,
   * and — since drafts now mint from this same counter — why a draft could collide with
   * a task.
   */
  private static readonly ID_SCAN_DIRS = [
    'tasks',
    'drafts',
    'completed',
    path.join('archive', 'tasks'),
    path.join('archive', 'drafts'),
  ];

  /**
   * Get the next available task ID number, scanning EVERY folder a task id can occupy
   * (tasks, drafts, completed, archive) plus any cross-branch ids.
   *
   * Takes the BACKLOG ROOT, not a single directory — a single-directory scan is exactly
   * the bug this closes.
   */
  private getNextTaskId(
    backlogPath: string,
    prefix: string = 'task',
    crossBranchIds?: string[]
  ): number {
    let maxId = 0;
    const pattern = new RegExp(`^${prefix}-(\\d+)`, 'i');

    for (const sub of BacklogWriter.ID_SCAN_DIRS) {
      const dir = path.join(backlogPath, sub);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const file of files) {
        const match = file.match(pattern);
        if (match) {
          const id = parseInt(match[1], 10);
          if (id > maxId) maxId = id;
        }
      }
    }

    // Also check cross-branch task IDs to avoid collisions.
    if (crossBranchIds) {
      const idPattern = new RegExp(`^${prefix}-(\\d+)$`, 'i');
      for (const taskId of crossBranchIds) {
        const match = taskId.match(idPattern);
        if (match) {
          const id = parseInt(match[1], 10);
          if (id > maxId) maxId = id;
        }
      }
    }

    return maxId + 1;
  }
```

Note the filename pattern is anchored on the configured `prefix`, so a legacy `draft-99 - X.md` sitting in `drafts/` contributes nothing to the max and cannot collide.

- [ ] **Step 4: Move the lock to a shared namespace**

Change `allocateAndWrite`'s signature and lock path (lines 891-929). The lock dir now lives under the backlog root, not the target dir:

```ts
  private allocateAndWrite<T>(
    backlogPath: string,
    startId: number,
    lockDirName: (id: number) => string,
    buildFile: (id: number) => { filePath: string; content: string; result: T }
  ): T {
    // ONE shared lock namespace for the whole board. Previously the lock dir lived inside
    // the TARGET directory (tasks/.task-N.lock vs drafts/.draft-N.lock) — two namespaces
    // that cannot see each other. Harmless while tasks and drafts had separate counters;
    // a live clobber race (the TASK-48 bug) now that they share one.
    const locksDir = path.join(backlogPath, '.locks');
    if (!fs.existsSync(locksDir)) {
      fs.mkdirSync(locksDir, { recursive: true });
    }

    let candidate = startId;
    for (let attempts = 0; attempts < 10_000; attempts++) {
      const lockDir = path.join(locksDir, lockDirName(candidate));
      try {
        fs.mkdirSync(lockDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          candidate++;
          continue;
        }
        throw err;
      }

      const { filePath, content, result } = buildFile(candidate);
      try {
        fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          candidate++;
          continue;
        }
        throw err;
      }

      try {
        fs.rmdirSync(lockDir);
      } catch {
        // best-effort cleanup; a leftover lock dir only retires that one id number
      }
      return result;
    }
    throw new Error(`Could not allocate a unique id under ${backlogPath} after 10000 attempts`);
  }
```

- [ ] **Step 5: Update `createTask`'s call sites**

In `createTask` (lines 756-761), pass the backlog root to both:

```ts
    const scannedId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);

    return this.allocateAndWrite(
      backlogPath,
      scannedId,
      (id) => `.${lowerPrefix}-${id}.lock`,
      (id) => {
        // ...unchanged buildFile body; it still writes into tasksDir
```

Then `grep -rn "getNextTaskId\|allocateAndWrite" src/` and update every remaining caller (`promoteDraft` at `:426` is one; Task 4 rewrites it anyway).

- [ ] **Step 6: Make sure `.locks/` is never parsed as a task**

`backlog/.locks/` is a new directory inside the backlog root. Confirm `BacklogParser.getTasksFromFolder` only reads the named subfolders (`tasks`, `drafts`, …) and never enumerates the backlog root, so `.locks/` cannot be mistaken for content.

Run: `bun run test -- BacklogParser`
Expected: PASS. If the parser *does* scan the root, add `.locks` to its ignore list and add a test.

Also add `.locks/` to the board's gitignore treatment if the board is versioned: check whether `boardRef.ts`'s snapshot paths or the `git-auto` pathspec would sweep it in. It is transient lock state and must never be committed.

- [ ] **Step 7: Run the tests**

Run: `bun run test -- BacklogWriter`
Expected: the three `getNextTaskId` global-scan tests PASS. The `allocateAndWrite` concurrency test still FAILS (it needs Task 3's `createDraft`) — that is expected.

- [ ] **Step 8: Commit**

```bash
git add src/core/BacklogWriter.ts src/test/unit/BacklogWriter.test.ts
git commit -m "Scan every folder for the next task id; share one allocation lock

getNextTaskId scanned only tasks/, so a restore from archive/ could land on
a live task's id. It now takes the backlog root and scans tasks, drafts,
completed and archive.

allocateAndWrite's lock dir lived inside the TARGET directory, so tasks/ and
drafts/ had two lock namespaces that could not see each other — about to
become a live clobber race once drafts mint from the task counter. One shared
backlog/.locks/ namespace now.

The concurrent createTask/createDraft test is red until drafts mint task ids.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `createDraft` mints a task ID

**Files:**
- Modify: `src/core/BacklogWriter.ts:818-875` (`createDraft`), and delete `getNextDraftId` (`:931-949`)
- Test: `src/test/unit/BacklogWriter.test.ts`

**Interfaces:**
- Consumes: `getNextTaskId(backlogPath, prefix, crossBranchIds?)` and the shared-lock `allocateAndWrite` from Task 2.
- Produces: `createDraft` now returns `{ id: 'TASK-112', filePath: '<backlog>/drafts/task-112 - Title.md' }`. Tasks 4 and 6 depend on this.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/BacklogWriter.test.ts`:

```ts
describe('createDraft (stable task ids)', () => {
  it('mints a TASK-N id and writes into drafts/', async () => {
    const { id, filePath } = await writer.createDraft(backlogPath, parser, { title: 'Explore caching' });
    expect(id).toMatch(/^TASK-\d+$/);
    expect(filePath).toContain(path.join('drafts', 'task-'));
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain(`id: ${id}`);
  });

  it('shares one counter with createTask — ids are distinct and increasing', async () => {
    const a = await writer.createTask(backlogPath, { title: 'A' }, parser);
    const b = await writer.createDraft(backlogPath, parser, { title: 'B' });
    const c = await writer.createTask(backlogPath, { title: 'C' }, parser);
    const num = (id: string) => parseInt(id.split('-')[1], 10);
    expect(num(b.id)).toBe(num(a.id) + 1);
    expect(num(c.id)).toBe(num(b.id) + 1);
  });

  it('is still parsed as a draft — the FOLDER is the marker, not the id', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'D' });
    const drafts = await parser.getDrafts();
    expect(drafts.map((d) => d.id)).toContain(id);
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('drafts');
  });

  it('honors a custom task_prefix and zero padding', async () => {
    // config.yml: task_prefix: 'STORY', zero_padded_ids: 3
    const { id, filePath } = await writer.createDraft(backlogPath, parser, { title: 'E' });
    expect(id).toMatch(/^STORY-\d{3}$/);
    expect(filePath).toContain(path.join('drafts', 'story-'));
  });

  it('still carries a real status (P6/D2b)', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'F', status: 'Done' });
    const task = await parser.getTask(id);
    expect(task!.status).toBe('Done');
    expect(task!.folder).toBe('drafts');
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `bun run test -- BacklogWriter`
Expected: FAIL — `id` is `DRAFT-1`, not `TASK-N`.

- [ ] **Step 3: Rewrite `createDraft`**

Replace lines 811-875:

```ts
  /**
   * Create a new draft in the drafts/ directory.
   *
   * The draft carries a REAL task id (TASK-N) from birth, minted from the same shared
   * counter as createTask — so promoting it never changes its id, and a reference written
   * against it (in a spec, a handoff, another task's dependencies) stays valid forever.
   * The drafts/ FOLDER is the provisional marker; the id says nothing about draftness.
   *
   * `opts.status` sets the draft's real status (P6/D2b — drafts are status-carrying);
   * it defaults to `config.default_status ?? 'To Do'`.
   */
  async createDraft(
    backlogPath: string,
    parser?: BacklogParser,
    opts?: { title?: string; description?: string; status?: string },
    crossBranchIds?: string[]
  ): Promise<{ id: string; filePath: string }> {
    const draftsDir = path.join(backlogPath, 'drafts');
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true });
    }

    const title = opts?.title?.trim() || 'Untitled';
    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);

    const config = parser ? await parser.getConfig() : {};
    const taskPrefix = config.task_prefix || 'TASK';
    const zeroPadding = config.zero_padded_ids || 0;
    const lowerPrefix = taskPrefix.toLowerCase();
    const status = opts?.status?.trim() || config.default_status || 'To Do';

    // Scan the WHOLE board for the next id (drafts share the task counter), then claim it
    // atomically under the shared lock namespace — a concurrent createTask must not land
    // on the same number.
    const scannedId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);

    return this.allocateAndWrite(
      backlogPath,
      scannedId,
      (id) => `.${lowerPrefix}-${id}.lock`,
      (id) => {
        const paddedId = zeroPadding > 0 ? String(id).padStart(zeroPadding, '0') : String(id);
        const draftId = `${taskPrefix}-${paddedId}`.toUpperCase();
        const fileName = `${lowerPrefix}-${paddedId} - ${sanitizedTitle}.md`;
        const filePath = path.join(draftsDir, fileName);

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

        const descBlock = opts?.description
          ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${opts.description}\n<!-- SECTION:DESCRIPTION:END -->`
          : '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->';
        const body = `\n## Description\n\n${descBlock}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;

        const content = this.reconstructFile(frontmatter, body);
        return { filePath, content, result: { id: draftId, filePath } };
      }
    );
  }
```

Note the lock name is now `.${lowerPrefix}-${id}.lock` — **identical** to `createTask`'s. That shared name, in the shared `.locks/` dir, is what makes the mutex work across the two writers.

- [ ] **Step 4: Delete `getNextDraftId`**

Remove lines 931-949 entirely. Then `grep -rn "getNextDraftId" src/` — the only remaining caller should be `demoteTask`, which Task 4 rewrites. If Task 4 has not landed yet, leave `getNextDraftId` in place and delete it there instead; do not leave a broken build.

- [ ] **Step 5: Run the tests**

Run: `bun run test -- BacklogWriter`
Expected: PASS — the five `createDraft` tests **and** Task 2's previously-red `allocateAndWrite` concurrency test both go green.

- [ ] **Step 6: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

Some existing tests will assert `DRAFT-N`. Update them to the new contract — a draft's id is `TASK-N` and its *folder* makes it a draft. Do **not** weaken an assertion to make it pass; if a test asserted `id.startsWith('DRAFT-')` as a proxy for draftness, repoint it at `folder === 'drafts'`, which is what it always meant.

```bash
git add src/core/BacklogWriter.ts src/test/unit/
git commit -m "Mint a real TASK-N id for drafts from the shared counter

A draft is now TASK-112 in drafts/, not DRAFT-3. The drafts/ folder remains
the sole draftness marker (it already was, everywhere in the codebase), so
promoting can no longer change an id — and a reference written against a
draft stays valid forever. getNextDraftId retires.

Closes the concurrent createTask/createDraft clobber test from the previous
commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Promote and demote become pure moves

**Files:**
- Modify: `src/core/BacklogWriter.ts:400-462` (`promoteDraft`), `:464-513` (`demoteTask`)
- Test: `src/test/unit/BacklogWriter.test.ts`

**Interfaces:**
- Consumes: `getNextTaskId(backlogPath, …)` from Task 2; the fact that drafts carry task IDs from Task 3.
- Produces: `promoteDraft` returns the **unchanged** ID for a stable-ID draft, and a fresh `TASK-M` for a legacy `DRAFT-N` draft. `promoteDrafts` (Task 1) already handles both — it remaps only when `from !== to`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('promoteDraft', () => {
  it('is a PURE MOVE for a stable-id draft — same id, same status, file relocated', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Stable', status: 'In Progress' });
    const newId = await writer.promoteDraft(id, parser);

    expect(newId).toBe(id);                       // THE POINT: the id never changes
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('tasks');
    expect(task!.status).toBe('In Progress');     // preserved (P6/D2d)
    expect(task!.filePath).toContain(path.join('tasks', 'task-'));
    expect(fs.existsSync(path.join(backlogPath, 'drafts', path.basename(task!.filePath)))).toBe(false);
  });

  it('preserves a Done draft as a Done task', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'D', status: 'Done' });
    await writer.promoteDraft(id, parser);
    expect((await parser.getTask(id))!.status).toBe('Done');
  });

  it('LEGACY: still re-ids a DRAFT-N draft to a fresh TASK-M', async () => {
    // Seed drafts/draft-3 - Legacy.md with `id: DRAFT-3` by hand.
    const newId = await writer.promoteDraft('DRAFT-3', parser);
    expect(newId).toMatch(/^TASK-\d+$/);
    expect(newId).not.toBe('DRAFT-3');
    expect((await parser.getTask(newId))!.folder).toBe('tasks');
  });
});

describe('demoteTask', () => {
  it('is a PURE MOVE — same id, same status, file relocated to drafts/', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'T', status: 'In Progress' }, parser);
    const newId = await writer.demoteTask(id, parser);

    expect(newId).toBe(id);
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('drafts');
    expect(task!.status).toBe('In Progress');
  });

  it('round-trips: create -> demote -> promote keeps one id throughout', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'RT' }, parser);
    expect(await writer.demoteTask(id, parser)).toBe(id);
    expect(await writer.promoteDraft(id, parser)).toBe(id);
    expect((await parser.getTask(id))!.folder).toBe('tasks');
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `bun run test -- BacklogWriter`
Expected: FAIL — `promoteDraft` returns a fresh ID, not the same one.

- [ ] **Step 3: Rewrite `promoteDraft`**

Replace lines 400-462:

```ts
  /**
   * Promote a draft to a regular task.
   *
   * For a STABLE-ID draft (the normal case) this is a PURE MOVE: drafts/ → tasks/, id and
   * status untouched. Nothing needs remapping because no id changed — that is the whole
   * point of minting task ids at draft creation.
   *
   * LEGACY FALLBACK: a draft whose id does not carry the configured task_prefix (an old
   * DRAFT-N file, or one written by the upstream Backlog.md CLI) is re-id'd to a fresh
   * TASK-M, exactly as before. Callers that need inbound references rewritten for that case
   * should go through `promoteDrafts`, which runs `remapIds` when the id changes.
   */
  async promoteDraft(
    taskId: string,
    parser: BacklogParser,
    crossBranchIds?: string[]
  ): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const backlogPath = path.dirname(path.dirname(task.filePath));
    const destDir = path.join(backlogPath, 'tasks');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const config = await parser.getConfig();
    const taskPrefix = config.task_prefix || 'TASK';
    const zeroPadding = config.zero_padded_ids || 0;
    const lowerPrefix = taskPrefix.toLowerCase();

    const isLegacy = !idHasPrefix(task.id, taskPrefix);

    let newTaskId: string;
    let paddedId: string;
    if (isLegacy) {
      const nextId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);
      paddedId = zeroPadding > 0 ? String(nextId).padStart(zeroPadding, '0') : String(nextId);
      newTaskId = `${taskPrefix}-${paddedId}`.toUpperCase();
    } else {
      newTaskId = task.id;
      paddedId = task.id.slice(task.id.lastIndexOf('-') + 1);
    }

    const sanitizedTitle = (task.title || 'Untitled')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const newFileName = `${lowerPrefix}-${paddedId} - ${sanitizedTitle}.md`;
    const destPath = path.join(destDir, newFileName);

    fs.renameSync(task.filePath, destPath);
    parser.invalidateTaskCache(task.filePath);

    const rawContent = fs.readFileSync(destPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    frontmatter.id = newTaskId;
    // P6/D2d: preserve the draft's real status — a Done draft promotes to a Done task.
    // Only a legacy/blank synthetic 'Draft' status (which has no real status to preserve)
    // is reset to the board default.
    const rawStatus = String(frontmatter.status ?? '').trim();
    if (!rawStatus || rawStatus.toLowerCase() === 'draft') {
      frontmatter.status = config.default_status || 'To Do';
    }
    frontmatter.updated_date = nowTimestamp();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(destPath, updatedContent);
    parser.invalidateTaskCache(destPath);

    return newTaskId;
  }
```

- [ ] **Step 4: Add the `idHasPrefix` helper**

Add near the other module-level helpers in `BacklogWriter.ts` (and export it — Task 6's migration uses the same predicate, and the two MUST agree or a draft could be classified legacy by one and stable by the other):

```ts
/**
 * Does this id belong to the board's task namespace (i.e. carry the configured prefix)?
 *
 * This is the ONLY legacy-draft test in the codebase. It deliberately does not look for the
 * literal string 'DRAFT-': a board with a custom task_prefix must classify its own drafts as
 * stable, not legacy. Both promoteDraft and draftIdMigration use this one predicate.
 */
export function idHasPrefix(id: string, taskPrefix: string): boolean {
  return new RegExp(`^${taskPrefix}-\\d+`, 'i').test(id.trim());
}
```

- [ ] **Step 5: Rewrite `demoteTask` as a pure move**

Replace lines 464-513:

```ts
  /**
   * Demote a task to a draft: a PURE MOVE from tasks/ to drafts/. The id and the status are
   * both preserved — the drafts/ folder is the provisional marker (P6/D2e), and the id is
   * stable for life. Nothing needs remapping because no id changed.
   *
   * (Before stable ids this re-id'd TASK-11 → DRAFT-9 and remapped nothing at all, so every
   * inbound `dependencies: [TASK-11]` dangled instantly. That bug is gone.)
   */
  async demoteTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const backlogPath = path.dirname(path.dirname(task.filePath));
    const destDir = path.join(backlogPath, 'drafts');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const config = await parser.getConfig();
    const lowerPrefix = (config.task_prefix || 'TASK').toLowerCase();
    const numericPart = task.id.slice(task.id.lastIndexOf('-') + 1);

    const sanitizedTitle = (task.title || 'Untitled')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const newFileName = `${lowerPrefix}-${numericPart} - ${sanitizedTitle}.md`;
    const destPath = path.join(destDir, newFileName);

    fs.renameSync(task.filePath, destPath);
    parser.invalidateTaskCache(task.filePath);

    const rawContent = fs.readFileSync(destPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    // id and status both preserved — only the timestamp moves.
    frontmatter.updated_date = nowTimestamp();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(destPath, updatedContent);
    parser.invalidateTaskCache(destPath);

    return task.id;
  }
```

Now delete `getNextDraftId` if Task 3 left it behind (`grep -rn "getNextDraftId" src/` must return nothing).

- [ ] **Step 6: Run the tests**

Run: `bun run test -- BacklogWriter`
Expected: PASS — all promote/demote tests including the legacy fallback and the round-trip.

- [ ] **Step 7: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/core/BacklogWriter.ts src/test/unit/
git commit -m "Make promote and demote pure moves

A stable-id draft promotes in place: same id, same status, file relocated.
Nothing to remap because nothing changed. Demote is the mirror (and stops
dangling every inbound reference, which the old re-id-with-no-remap did
instantly). A legacy DRAFT-N draft still re-ids, via the one shared
idHasPrefix predicate — never a literal 'DRAFT-' match, so a custom
task_prefix board classifies its own drafts correctly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Archive and restore route by folder

**Files:**
- Modify: `src/core/BacklogWriter.ts:371-386` (`archiveTask`, `restoreArchivedTask`)
- Test: `src/test/unit/BacklogWriter.test.ts`

**Interfaces:**
- Consumes: `Task.folder` from the parser.
- Produces: `archiveTask` sends a draft to `archive/drafts/`; `restoreArchivedTask` returns it to `drafts/`. No signature change.

`restoreArchivedTask:384` is the **last** runtime branch on an ID prefix in the codebase (`taskId.startsWith('DRAFT-') ? 'drafts' : 'tasks'`). With a draft named `TASK-112` it can no longer work. Route by folder — the invariant that already holds everywhere else.

- [ ] **Step 1: Write the failing tests**

```ts
describe('archive/restore round-trip', () => {
  it('archives a draft to archive/drafts/ and restores it to drafts/', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Arch' });

    const archived = await writer.archiveTask(id, parser);
    expect(archived).toContain(path.join('archive', 'drafts'));
    expect((await parser.getTask(id))!.folder).toBe('archive');

    await writer.restoreArchivedTask(id, parser);
    const restored = await parser.getTask(id);
    expect(restored!.folder).toBe('drafts');            // NOT tasks/ — it was a draft
    expect(restored!.id).toBe(id);                      // id never changed
  });

  it('archives a task to archive/tasks/ and restores it to tasks/', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'T' }, parser);
    const archived = await writer.archiveTask(id, parser);
    expect(archived).toContain(path.join('archive', 'tasks'));

    await writer.restoreArchivedTask(id, parser);
    expect((await parser.getTask(id))!.folder).toBe('tasks');
  });

  it('routes by FOLDER, not by id prefix — a TASK-N draft restores to drafts/', async () => {
    // This is the regression the old `taskId.startsWith('DRAFT-')` branch could not survive.
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Folder routed' });
    expect(id).toMatch(/^TASK-\d+$/);
    await writer.archiveTask(id, parser);
    await writer.restoreArchivedTask(id, parser);
    expect((await parser.getTask(id))!.folder).toBe('drafts');
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `bun run test -- BacklogWriter`
Expected: FAIL — the draft archives to `archive/tasks/` and restores to `tasks/`.

- [ ] **Step 3: Implement folder routing**

Replace lines 371-386:

```ts
  /**
   * Archive a task (cancelled/duplicate). Routes by SOURCE FOLDER: a draft goes to
   * archive/drafts/, a task to archive/tasks/ — so restore can put it back where it came
   * from without ever reading the id. (archive/drafts/ has been scaffolded by initBacklog
   * since the beginning and nothing has ever written to it.)
   */
  async archiveTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const destFolder = task.folder === 'drafts' ? 'archive/drafts' : 'archive/tasks';
    const destinationPath = await this.moveTaskToFolder(taskId, destFolder, parser);
    await this.sanitizeArchivedTaskLinks(taskId, parser);
    return destinationPath;
  }

  /**
   * Restore an archived task to the folder it was archived FROM: archive/drafts/ → drafts/,
   * archive/tasks/ → tasks/.
   *
   * This replaces the last id-prefix branch in the codebase (`startsWith('DRAFT-')`), which
   * could not survive a draft being named TASK-112. The folder is — and always was — the
   * draftness marker.
   */
  async restoreArchivedTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    // The parser reports both archive subfolders as folder 'archive', so inspect the path.
    const inArchivedDrafts = task.filePath
      .split(path.sep)
      .join('/')
      .includes('/archive/drafts/');
    const destFolder = inArchivedDrafts ? 'drafts' : 'tasks';
    return this.moveTaskToFolder(taskId, destFolder, parser);
  }
```

**Before implementing:** confirm `moveTaskToFolder` accepts a nested `'archive/drafts'` folder string — `archiveTask` already passes `'archive/tasks'`, so it should, but read it (`:518`) and confirm it joins the path rather than treating the argument as a single segment. Confirm `BacklogParser` actually enumerates `archive/drafts/` (it reads `archive/tasks` today — `getTasksFromFolder('archive/tasks')`); if it does not, the restored draft will be invisible to `getTask` and this task must also add `archive/drafts` to the parser's scanned folders. **Write a test for that specifically** — an archived draft that the parser cannot see is a data-loss bug, not a cosmetic one.

- [ ] **Step 4: Run the tests**

Run: `bun run test -- BacklogWriter`
Expected: PASS — all three round-trip tests.

- [ ] **Step 5: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/core/BacklogWriter.ts src/core/BacklogParser.ts src/test/unit/
git commit -m "Route archive and restore by folder, not by id prefix

restoreArchivedTask's `taskId.startsWith('DRAFT-')` was the last runtime
branch on an id prefix in the codebase, and it cannot survive a draft named
TASK-112. archiveTask now routes a draft to archive/drafts/ (scaffolded since
day one, never written to) and restore returns it to drafts/.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The migration core

**Files:**
- Create: `src/core/draftIdMigration.ts`
- Create: `src/test/unit/draftIdMigration.test.ts`

**Interfaces:**
- Consumes: `idHasPrefix` (Task 4), `remapIds` (Task 1), `BacklogWriter.promoteDraft`'s legacy re-ID path — **no**: the migration must *not* promote. A legacy draft must stay a draft, so the migration does its own rename **within `drafts/`**.
- Produces:
  ```ts
  export interface DraftIdMigrationPlan {
    renames: Array<{ oldId: string; newId: string; fromPath: string; toPath: string }>;
    /** Legacy archived drafts to relocate from archive/tasks/ to archive/drafts/. */
    relocations: Array<{ id: string; fromPath: string; toPath: string }>;
  }
  export function planDraftIdMigration(
    drafts: Task[], archived: Task[], config: BacklogConfig, nextId: number, backlogPath: string
  ): DraftIdMigrationPlan;
  export function isLegacyDraftBoard(plan: DraftIdMigrationPlan): boolean;
  export async function runDraftIdMigration(deps: IdRemapDeps, backlogPath: string): Promise<{ migrated: number; mapping: Array<{ from: string; to: string }> }>;
  ```
  Task 7 calls `runDraftIdMigration`.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/draftIdMigration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planDraftIdMigration, runDraftIdMigration } from '../../core/draftIdMigration';

describe('planDraftIdMigration (pure)', () => {
  it('yields an empty plan for a board with no legacy drafts', () => {
    const drafts = [taskFixture('TASK-5', 'drafts')];
    const plan = planDraftIdMigration(drafts, [], { task_prefix: 'TASK' }, 10, '/b');
    expect(plan.renames).toEqual([]);
    expect(plan.relocations).toEqual([]);
  });

  it('plans a legacy DRAFT-3 onto a fresh id above the current max', () => {
    const drafts = [taskFixture('DRAFT-3', 'drafts')];
    const plan = planDraftIdMigration(drafts, [], { task_prefix: 'TASK' }, 111, '/b');
    expect(plan.renames).toEqual([
      expect.objectContaining({ oldId: 'DRAFT-3', newId: 'TASK-111' }),
    ]);
  });

  it('classifies a custom-prefix board\'s own drafts as NOT legacy', () => {
    const drafts = [taskFixture('STORY-4', 'drafts')];
    const plan = planDraftIdMigration(drafts, [], { task_prefix: 'STORY' }, 9, '/b');
    expect(plan.renames).toEqual([]);
  });

  it('plans drafts dependency-first, so prerequisites get lower ids', () => {
    const a = taskFixture('DRAFT-1', 'drafts', { dependencies: ['DRAFT-2'] });
    const b = taskFixture('DRAFT-2', 'drafts');
    const plan = planDraftIdMigration([a, b], [], { task_prefix: 'TASK' }, 10, '/b');
    expect(plan.renames.map((r) => r.oldId)).toEqual(['DRAFT-2', 'DRAFT-1']);
    expect(plan.renames.map((r) => r.newId)).toEqual(['TASK-10', 'TASK-11']);
  });

  it('plans a legacy archived draft for relocation to archive/drafts/', () => {
    const archived = [taskFixture('DRAFT-9', 'archive', { filePath: '/b/archive/tasks/draft-9 - X.md' })];
    const plan = planDraftIdMigration([], archived, { task_prefix: 'TASK' }, 10, '/b');
    expect(plan.relocations[0].toPath).toContain(path.join('archive', 'drafts'));
  });
});

describe('runDraftIdMigration (integration on a temp board)', () => {
  it('renames the file, rewrites the id, and remaps every inbound reference', async () => {
    // Temp board: drafts/draft-3, and TASK-9 with dependencies [DRAFT-3],
    // parent_task_id DRAFT-3, subtasks [DRAFT-3], references [DRAFT-3].
    const { migrated, mapping } = await runDraftIdMigration(deps, backlogPath);

    expect(migrated).toBe(1);
    const newId = mapping[0].to;
    expect(mapping[0].from).toBe('DRAFT-3');
    expect(newId).toMatch(/^TASK-\d+$/);

    // It is STILL a draft — migration never promotes.
    const migratedDraft = await parser.getTask(newId);
    expect(migratedDraft!.folder).toBe('drafts');

    const t9 = await parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual([newId]);
    expect(t9!.parentTaskId).toBe(newId);
    expect(t9!.subtasks).toEqual([newId]);
    expect(t9!.references).toEqual([newId]);
  });

  it('is idempotent — a second run performs zero writes', async () => {
    await runDraftIdMigration(deps, backlogPath);
    const second = await runDraftIdMigration(deps, backlogPath);
    expect(second.migrated).toBe(0);
    expect(second.mapping).toEqual([]);
  });

  it('does nothing at all on a clean board', async () => {
    // Board with only TASK-N tasks and TASK-N drafts.
    const result = await runDraftIdMigration(deps, backlogPath);
    expect(result.migrated).toBe(0);
  });

  it('relocates a legacy archived draft into archive/drafts/', async () => {
    // Temp board: archive/tasks/draft-9 - Old.md
    await runDraftIdMigration(deps, backlogPath);
    expect(fs.existsSync(path.join(backlogPath, 'archive', 'tasks', 'draft-9 - Old.md'))).toBe(false);
    const relocated = fs.readdirSync(path.join(backlogPath, 'archive', 'drafts'));
    expect(relocated).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `bun run test -- draftIdMigration`
Expected: FAIL — cannot resolve `../../core/draftIdMigration`.

- [ ] **Step 3: Write the implementation**

Create `src/core/draftIdMigration.ts`:

```ts
/**
 * Converge a legacy DRAFT-N board onto stable task ids. vscode-free.
 *
 * A board written before stable ids has drafts named DRAFT-3 whose id changes the moment
 * they are promoted — the exact instability this feature removes. Rather than leaving those
 * boards on a compat path forever (where the confusion persists until each draft happens to
 * be promoted), we migrate them automatically and idempotently.
 *
 * A migrated draft STAYS A DRAFT. This is a re-id in place, not a promotion — the human,
 * not the migration, decides what gets promoted.
 *
 * Run from BOTH extension activation (deferred) and MCP server startup, so an agent-only
 * session converges the same way a UI session does.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Task, BacklogConfig } from './types';
import type { IdRemapDeps } from './idRemap';
import { remapIds } from './idRemap';
import { idHasPrefix } from './BacklogWriter';

export interface DraftIdMigrationPlan {
  renames: Array<{ oldId: string; newId: string; fromPath: string; toPath: string }>;
  relocations: Array<{ id: string; fromPath: string; toPath: string }>;
}

function sanitize(title: string): string {
  return (title || 'Untitled')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);
}

/** Order legacy drafts so an in-set dependency precedes its dependent (deps → dependents). */
function topoOrder(drafts: Task[]): Task[] {
  const byUpper = new Map(drafts.map((d) => [d.id.trim().toUpperCase(), d]));
  const ordered: Task[] = [];
  const visited = new Set<string>();
  const visit = (upper: string) => {
    if (visited.has(upper)) return;
    visited.add(upper);
    const d = byUpper.get(upper);
    if (!d) return;
    for (const dep of d.dependencies ?? []) {
      const u = dep.trim().toUpperCase();
      if (byUpper.has(u)) visit(u);
    }
    ordered.push(d);
  };
  for (const d of drafts) visit(d.id.trim().toUpperCase());
  return ordered;
}

/**
 * Plan the migration. Pure — no filesystem writes, no reads.
 *
 * `nextId` is the first free task number (from BacklogWriter's global scan). Legacy drafts
 * are assigned sequentially from it in dependency-first order.
 */
export function planDraftIdMigration(
  drafts: Task[],
  archived: Task[],
  config: BacklogConfig,
  nextId: number,
  backlogPath: string
): DraftIdMigrationPlan {
  const taskPrefix = config.task_prefix || 'TASK';
  const zeroPadding = config.zero_padded_ids || 0;
  const lowerPrefix = taskPrefix.toLowerCase();

  // Legacy = the id does not carry the board's task prefix. NEVER a literal 'DRAFT-' match:
  // a board with task_prefix STORY must classify STORY-4 as its own, not as legacy.
  const legacyDrafts = drafts.filter((d) => !idHasPrefix(d.id, taskPrefix));

  let next = nextId;
  const renames = topoOrder(legacyDrafts).map((d) => {
    const n = next++;
    const padded = zeroPadding > 0 ? String(n).padStart(zeroPadding, '0') : String(n);
    const newId = `${taskPrefix}-${padded}`.toUpperCase();
    return {
      oldId: d.id,
      newId,
      fromPath: d.filePath,
      toPath: path.join(backlogPath, 'drafts', `${lowerPrefix}-${padded} - ${sanitize(d.title)}.md`),
    };
  });

  // A legacy archived draft sits in archive/tasks/ (where the old archiveTask put it) with a
  // draft-N filename. Move it to archive/drafts/ so the new folder-routed restore finds it.
  const relocations = archived
    .filter((t) => /[/\\]archive[/\\]tasks[/\\]/.test(t.filePath))
    .filter((t) => !idHasPrefix(t.id, taskPrefix))
    .map((t) => ({
      id: t.id,
      fromPath: t.filePath,
      toPath: path.join(backlogPath, 'archive', 'drafts', path.basename(t.filePath)),
    }));

  return { renames, relocations };
}

export function isLegacyDraftBoard(plan: DraftIdMigrationPlan): boolean {
  return plan.renames.length > 0 || plan.relocations.length > 0;
}

/**
 * Execute the migration. Idempotent: a board with no legacy drafts performs ZERO writes.
 *
 * Order matters — every file must be in its final place before remapIds re-reads the board,
 * or it would rewrite references to point at ids that do not exist yet.
 */
export async function runDraftIdMigration(
  deps: IdRemapDeps,
  backlogPath: string
): Promise<{ migrated: number; mapping: Array<{ from: string; to: string }> }> {
  const [drafts, config] = await Promise.all([deps.parser.getDrafts(), deps.parser.getConfig()]);
  const archived = await deps.parser.getArchivedTasks();

  const nextId = deps.writer.peekNextTaskId(backlogPath, config.task_prefix || 'TASK');
  const plan = planDraftIdMigration(drafts, archived, config, nextId, backlogPath);
  if (!isLegacyDraftBoard(plan)) {
    return { migrated: 0, mapping: [] };
  }

  // 1. Relocate legacy archived drafts.
  for (const r of plan.relocations) {
    fs.mkdirSync(path.dirname(r.toPath), { recursive: true });
    fs.renameSync(r.fromPath, r.toPath);
    deps.parser.invalidateTaskCache(r.fromPath);
    deps.parser.invalidateTaskCache(r.toPath);
  }

  // 2. Rename each legacy draft in place (drafts/ → drafts/) and rewrite its frontmatter id.
  //    This is a RE-ID, NOT a promotion — the file stays in drafts/.
  for (const r of plan.renames) {
    await deps.writer.reidTaskFile(r.fromPath, r.toPath, r.newId, deps.parser);
  }

  // 3. Now that every file is in its final place, rewrite every inbound reference.
  const oldToNew = new Map(plan.renames.map((r) => [r.oldId.trim().toUpperCase(), r.newId]));
  await remapIds(deps, oldToNew);

  return {
    migrated: plan.renames.length,
    mapping: plan.renames.map((r) => ({ from: r.oldId, to: r.newId })),
  };
}
```

- [ ] **Step 4: Add the two `BacklogWriter` methods the migration needs**

`runDraftIdMigration` calls two methods that do not exist yet. Add both to `BacklogWriter`:

```ts
  /** The next free task number, without claiming it. Used by the draft-id migration planner. */
  peekNextTaskId(backlogPath: string, prefix: string): number {
    return this.getNextTaskId(backlogPath, prefix);
  }

  /**
   * Rename a task file and rewrite its frontmatter `id` IN PLACE, without moving it between
   * folders. Used by the draft-id migration to re-id a legacy draft while it stays a draft.
   *
   * Preserves CRLF/LF and every other frontmatter field, including status.
   */
  async reidTaskFile(
    fromPath: string,
    toPath: string,
    newId: string,
    parser: BacklogParser
  ): Promise<void> {
    fs.renameSync(fromPath, toPath);
    parser.invalidateTaskCache(fromPath);

    const rawContent = fs.readFileSync(toPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    frontmatter.id = newId;
    frontmatter.updated_date = nowTimestamp();
    const updated = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(toPath, updated);
    parser.invalidateTaskCache(toPath);
  }
```

Also confirm `BacklogParser` exposes `getArchivedTasks()`. If it does not, use whatever the parser's existing archive accessor is (`getTasksFromFolder('archive/tasks')` plus `archive/drafts`) — read `BacklogParser.ts:236-360` and use the real API rather than inventing one.

- [ ] **Step 5: Run the tests**

Run: `bun run test -- draftIdMigration`
Expected: PASS — all 9 tests, including idempotence.

- [ ] **Step 6: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/core/draftIdMigration.ts src/core/BacklogWriter.ts src/test/unit/draftIdMigration.test.ts
git commit -m "Add the legacy-draft-id migration core

Pure planner + executor. A legacy DRAFT-3 is re-id'd IN PLACE to a fresh
TASK-N (it stays a draft — migration never promotes), legacy archived drafts
move to archive/drafts/, and every inbound reference is remapped through the
shared idRemap core. Idempotent: a clean board performs zero writes.

Legacy detection is 'lacks the configured task_prefix', never a literal
'DRAFT-' match, so a custom-prefix board does not churn its own drafts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Run the migration automatically

**Files:**
- Modify: `src/extension.ts` (inside the `startupBootstrap` deferred runner, `:962`)
- Modify: `src/mcp/server.ts` (after board-root resolution)
- Modify: `src/core/boardDoctor.ts:30-53` (finding + repair types), `:216` (`diagnoseBoard`)
- Test: `src/test/unit/boardDoctor.test.ts`

**Interfaces:**
- Consumes: `runDraftIdMigration(deps, backlogPath)` from Task 6.
- Produces: a `legacy-draft-ids` doctor finding with a `migrate-draft-ids` repair.

- [ ] **Step 1: Wire it into the deferred bootstrap**

In `src/extension.ts`, inside the existing `createDeferredRunner` callback at line 962, add the migration. Read the surrounding block first — the git-auto engine depends on the ordering of the existing steps, so **append** rather than inserting into the middle.

```ts
    // Converge a legacy DRAFT-N board onto stable task ids. Idempotent (a clean board does
    // zero writes) and non-fatal: a failure logs and surfaces as a doctor finding rather
    // than breaking activation — the deferred runner never rejects into activate().
    try {
      const result = await runDraftIdMigration(
        { parser, writer, treeFieldService },
        parser.getBacklogPath()
      );
      if (result.migrated > 0) {
        const pairs = result.mapping.map((m) => `${m.from} → ${m.to}`).join(', ');
        output.appendLine(`[taskwright] Migrated ${result.migrated} draft(s) to stable task ids: ${pairs}`);
        vscode.window.showInformationMessage(
          `Taskwright migrated ${result.migrated} draft(s) to stable task IDs. Draft IDs no longer change on promotion.`
        );
      }
    } catch (err) {
      output.appendLine(`[taskwright] Draft id migration failed: ${err}`);
    }
```

Confirm the real names of `parser.getBacklogPath()`, the output channel, and the `treeFieldService` instance in scope at that point — read the block; do not assume.

- [ ] **Step 2: Wire it into the MCP server startup**

In `src/mcp/server.ts`, after the board root resolves (`resolveWorkspaceBacklogRoot`) and the parser/writer are constructed, run the same core. A dispatched or headless agent session must converge too.

```ts
// Converge a legacy DRAFT-N board. Idempotent; a failure must never prevent the server from
// serving tools. stdout is the JSON-RPC channel — log to stderr only.
try {
  const result = await runDraftIdMigration({ parser, writer, treeFieldService }, backlogRoot);
  if (result.migrated > 0) {
    console.error(`[taskwright] Migrated ${result.migrated} draft(s) to stable task ids.`);
  }
} catch (err) {
  console.error(`[taskwright] Draft id migration failed: ${err}`);
}
```

**Note the stdout rule:** the MCP server's stdout is the JSON-RPC channel. Any log must go to stderr (`console.error`), which is the convention already enforced in this file.

**Cross-process safety:** an extension host and an MCP server can start simultaneously. Both take the existing cross-process board lock before migrating. Find that lock (the `autoSync` engine uses one — `src/core/autoSync.ts`) and wrap both call sites in it. If the two migrate concurrently without it, the second sees the first's partial state. **This is the riskiest step in the plan — verify the lock is actually acquired by writing a test that runs two migrations concurrently against one temp board and asserts a single, consistent result.**

- [ ] **Step 3: Add the doctor finding**

In `src/core/boardDoctor.ts`, extend the two union types (lines 30-53):

```ts
export type DoctorFindingType =
  | 'dangling-active-task'
  // ...existing...
  | 'board-mode-mismatch'
  | 'legacy-draft-ids';

export type DoctorRepair =
  | 'clear-active-task'
  // ...existing...
  | 'restore-board-to-primary'
  | 'migrate-draft-ids';
```

Then in `diagnoseBoard` (line 216), add the check. It needs the drafts and the task prefix, so extend `BoardDoctorInput` accordingly:

```ts
  // A draft whose id does not carry the board's task prefix is a legacy DRAFT-N file: its id
  // will change when promoted, dangling every reference written against it. The automatic
  // migration normally converges this at activation; a finding here is the visible safety net
  // for when it failed or was skipped (e.g. a board opened read-only).
  const legacyDrafts = input.drafts.filter((d) => !idHasPrefix(d.id, input.taskPrefix));
  if (legacyDrafts.length > 0) {
    findings.push({
      type: 'legacy-draft-ids',
      repair: 'migrate-draft-ids',
      message: `${legacyDrafts.length} draft(s) still use unstable DRAFT-N ids, which change on promotion.`,
      detail: legacyDrafts.map((d) => d.id).join(', '),
    });
  }
```

- [ ] **Step 4: Route the repair**

In `src/providers/doctorActions.ts`, add a `migrate-draft-ids` case to the repair switch that calls `runDraftIdMigration` — the same core, so the manual repair and the automatic pass cannot diverge.

- [ ] **Step 5: Write the doctor test**

Add to `src/test/unit/boardDoctor.test.ts`:

```ts
it('flags legacy DRAFT-N drafts with a migrate repair', () => {
  const findings = diagnoseBoard({
    ...baseInput,
    taskPrefix: 'TASK',
    drafts: [doctorTask('DRAFT-3'), doctorTask('TASK-9')],
  });
  const f = findings.find((x) => x.type === 'legacy-draft-ids');
  expect(f).toBeDefined();
  expect(f!.repair).toBe('migrate-draft-ids');
  expect(f!.detail).toBe('DRAFT-3');
});

it('does not flag a clean board', () => {
  const findings = diagnoseBoard({ ...baseInput, taskPrefix: 'TASK', drafts: [doctorTask('TASK-9')] });
  expect(findings.find((x) => x.type === 'legacy-draft-ids')).toBeUndefined();
});
```

- [ ] **Step 6: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/extension.ts src/mcp/server.ts src/core/boardDoctor.ts src/providers/doctorActions.ts src/test/unit/
git commit -m "Run the draft-id migration automatically at activation and MCP startup

Both entry points call the identical core under the shared board lock, so an
agent-only session converges the same way a UI session does. Activation runs
it inside the deferred bootstrap (never inline — TASK-109 moved every git/fs
burst off the activation path). A failure degrades to a legacy-draft-ids
doctor finding; it never blocks activation or the MCP server.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Correct every agent-facing description

**Files:**
- Modify: `src/mcp/server.ts:302, 404-405, 415, 419, 430` (tool descriptions)
- Modify: `.claude/skills/create-task/SKILL.md`, `.claude/skills/index-codebase/SKILL.md`
- Modify: `CLAUDE.md`, `AGENTS.md`

The MCP tool descriptions currently promise `DRAFT-N`. Agents read these. Leaving them stale means agents keep writing draft-flavored references into specs and handoffs — the exact failure this whole feature exists to prevent.

- [ ] **Step 1: Correct the MCP tool descriptions**

- `server.ts:302` — `'Create as a draft (DRAFT-N in drafts/).'` becomes:
  `'Create as a draft: a provisional task in drafts/ that a human reviews and promotes. It carries a NORMAL task id (TASK-N) from birth — drafts and tasks share one id space, and promoting NEVER changes the id, so it is safe to reference a draft by id in specs, handoffs, and dependencies.'`
- `:404-405, :415, :419, :430` — the `promote_draft` / `promote_drafts` / `demote_task` descriptions. Replace the `["DRAFT-1","DRAFT-2"]` example with `["TASK-111","TASK-112"]`, and state that promotion moves a task out of `drafts/` **without changing its id**.

- [ ] **Step 2: Simplify the skills**

Both `.claude/skills/create-task/SKILL.md` and `.claude/skills/index-codebase/SKILL.md` wire dependencies between drafts by ID. They get *simpler*: add a line to each stating that the ID `create_task` returns for a draft is **final** — it will not change when the human promotes it, so it is safe to write into a spec, a plan, or another task's `dependencies`.

- [ ] **Step 3: Document the one ID space**

Add to `CLAUDE.md`'s Taskwright-additions list a new bullet:

> - **Stable task IDs (one ID space)** ✅: a draft is created with a real `TASK-N` id in `backlog/drafts/` — `folder === 'drafts'` is the sole draftness marker, never the id. `promoteDraft`/`demoteTask` are **pure moves** (id and status preserved; nothing to remap). `getNextTaskId` scans every folder (`tasks`/`drafts`/`completed`/`archive`), and `allocateAndWrite` locks in ONE shared `backlog/.locks/` namespace — a per-directory lock would let a concurrent `create_task` and draft-create both claim the same number (the TASK-48 clobber, re-armed by the shared counter). Archive/restore route by **folder** (`archive/drafts/` ↔ `drafts/`), which deletes the last id-prefix branch in the codebase. Legacy `DRAFT-N` boards **migrate automatically** and idempotently (`src/core/draftIdMigration.ts`, run from the deferred bootstrap and MCP startup; re-id in place — it never promotes), remapping references through the shared `src/core/idRemap.ts` (which also closes `promoteDrafts`' old `parent_task_id`/`subtasks`/`references[]` gaps). Design: `docs/superpowers/specs/2026-07-12-stable-task-ids-design.md`.

And in `AGENTS.md`, under the task-workflow section, add one line: a draft's ID is final — reference it freely.

- [ ] **Step 4: Full verification and commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`

```bash
git add src/mcp/server.ts .claude/skills/ CLAUDE.md AGENTS.md
git commit -m "Document the one id space in every agent-facing surface

The MCP tool descriptions promised DRAFT-N. Agents read these, so a stale
description means agents keep writing draft-flavored references into specs
and handoffs — the exact confusion this feature removes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The acceptance test

**Files:**
- Create/extend: `src/test/unit/stableTaskIds.integration.test.ts`

This is the test that proves the *feature*, not its parts.

- [ ] **Step 1: Write it**

```ts
describe('stable task ids (acceptance)', () => {
  it('a reference written against a draft survives its promotion', async () => {
    // 1. Author a draft.
    const draft = await writer.createDraft(backlogPath, parser, { title: 'The dependency' });

    // 2. Reference it by id, both structurally and IN PROSE — the prose is the case no
    //    remap pass could ever have fixed, and the reason stable ids matter.
    const dependent = await writer.createTask(
      backlogPath,
      { title: 'The dependent', description: `Blocked on ${draft.id}, which does the real work.` },
      parser
    );
    await writer.updateTask(dependent.id, { dependencies: [draft.id] }, parser);

    // 3. Promote.
    const promotedId = await writer.promoteDraft(draft.id, parser);
    expect(promotedId).toBe(draft.id);

    // 4. Both references still resolve.
    const t = await parser.getTask(dependent.id);
    expect(t!.dependencies).toEqual([draft.id]);
    expect(t!.description).toContain(draft.id);
    expect(await parser.getTask(draft.id)).toBeDefined();
  });

  it('a legacy board reaches the same state after migration', async () => {
    // Seed a legacy board: drafts/draft-3 (id DRAFT-3), and TASK-9 depending on DRAFT-3.
    const { mapping } = await runDraftIdMigration(deps, backlogPath);
    const newId = mapping[0].to;

    // The draft is still a draft, with a stable id.
    expect((await parser.getTask(newId))!.folder).toBe('drafts');

    // Its inbound reference was remapped.
    expect((await parser.getTask('TASK-9'))!.dependencies).toEqual([newId]);

    // And NOW promoting it does not change the id — the invariant holds on a migrated board.
    expect(await writer.promoteDraft(newId, parser)).toBe(newId);
    expect((await parser.getTask('TASK-9'))!.dependencies).toEqual([newId]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run test -- stableTaskIds`
Expected: PASS — both tests.

- [ ] **Step 3: Full suite, then commit**

Run: `ch run "bun run test && bun run lint && bun run typecheck"`
Expected: everything green.

```bash
git add src/test/unit/stableTaskIds.integration.test.ts
git commit -m "Add the stable-task-id acceptance test

Proves the feature, not its parts: a reference written against a draft —
structurally AND in prose — survives promotion unchanged, on both a fresh
board and a migrated legacy one.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Drafts mint `TASK-N` into `drafts/`; folder is the marker | 3 |
| `getNextTaskId` scans every folder | 2 |
| Shared allocation lock (`backlog/.locks/`) | 2 |
| `getNextDraftId` retires | 3 (or 4) |
| `promoteDraft` is a pure move | 4 |
| `demoteTask` is a pure move | 4 |
| Legacy re-ID fallback via `idHasPrefix` | 4 |
| `promoteDrafts` remaps only when `from !== to` | 1 |
| Shared `idRemap` core, closing the 3 dangling-field gaps | 1 |
| Archive routes by source folder to `archive/drafts/` | 5 |
| Restore routes by archive subfolder, not ID prefix | 5 |
| `draftIdMigration` pure planner + executor | 6 |
| Migration is idempotent | 6 |
| Migration re-IDs in place (never promotes) | 6 |
| Legacy archived drafts relocated | 6 |
| Runs at extension activation, in the deferred bootstrap | 7 |
| Runs at MCP server startup | 7 |
| Cross-process lock so the two cannot double-migrate | 7 (flagged as the riskiest step, with a required test) |
| Migration is visible (logged mapping + notification) | 7 |
| `legacy-draft-ids` doctor finding + repair | 7 |
| MCP tool descriptions corrected | 8 |
| Skills + CLAUDE.md + AGENTS.md updated | 8 |
| Acceptance: a draft reference survives promotion | 9 |

Full coverage; no gaps.

**Type consistency:** `idHasPrefix(id, taskPrefix)` is defined and exported in Task 4 and consumed by Task 6's planner and Task 7's doctor check — one predicate, so a draft cannot be classified legacy by one and stable by another. `IdRemapDeps` (Task 1) is the deps type for `remapIds` (Task 1) and `runDraftIdMigration` (Task 6), and is structurally identical to the existing `PromoteDraftsDeps`. `getNextTaskId(backlogPath, prefix, crossBranchIds?)` and `allocateAndWrite(backlogPath, startId, lockDirName, buildFile)` are re-signatured in Task 2 and called with those signatures in Tasks 3, 4, and 6 (via `peekNextTaskId`). `runDraftIdMigration(deps, backlogPath)` returns `{migrated, mapping}` in Task 6 and is destructured as such in Tasks 7 and 9.

**Assumptions flagged inline rather than assumed away:** Task 1 Step 3 requires confirming `updateTask` accepts `parentTaskId`/`subtasks`/`references`. Task 2 Step 6 requires confirming the parser ignores `backlog/.locks/` and that the board-sync pathspec never commits it. Task 5 Step 3 requires confirming `moveTaskToFolder` handles a nested `archive/drafts` path **and that `BacklogParser` actually enumerates `archive/drafts/`** — if it does not, a restored draft would be invisible, which is data loss, not cosmetics. Task 6 Step 4 requires confirming `BacklogParser.getArchivedTasks()` exists. Task 7 Step 2 flags the cross-process lock as the riskiest step and demands a concurrency test.
