import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
import { runDraftIdMigration } from '../../core/draftIdMigration';
import type { IdRemapDeps } from '../../core/idRemap';

/**
 * TASK-121 — the acceptance test for the Stable Task IDs feature (TASK-113…TASK-120).
 *
 * This proves the FEATURE, not its parts. Every other suite in the chain tests one core in
 * isolation; this one asserts the single invariant the whole milestone exists to deliver:
 *
 *     A task carries the id it will keep, from creation. Promotion never changes it, so a
 *     reference written against a draft — in a dependency list, a subtask list, a spec, a
 *     handoff, or a sentence of English — stays valid forever.
 *
 * The PROSE reference is the load-bearing case. `remapIds` can rewrite structured fields; it
 * can never rewrite free text. Under the old `DRAFT-N` ids, the moment a draft was promoted
 * every sentence naming it pointed at an id that no longer existed — silently, with nothing to
 * detect it. That damage is unrecoverable, which is why the fix had to be stable ids at birth
 * rather than a better remap pass. (This repo's own TASK-77 description still cites a DRAFT-3
 * that ceased to exist on promotion — the bug, preserved in amber.)
 *
 * It must hold on a MIGRATED board too, not just a fresh one: a legacy board converges via
 * `runDraftIdMigration` and lands in exactly the same state.
 */

let root: string;
let backlogPath: string;
let deps: IdRemapDeps;
let parser: BacklogParser;
let writer: BacklogWriter;

const CONFIG =
  'project_name: "acceptance"\n' +
  'statuses: ["To Do", "In Progress", "Done"]\n' +
  'default_status: "To Do"\n' +
  'task_prefix: "task"\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-stable-ids-'));
  backlogPath = path.join(root, 'backlog');
  for (const dir of ['tasks', 'drafts', 'completed', 'archive/tasks', 'archive/drafts']) {
    fs.mkdirSync(path.join(backlogPath, ...dir.split('/')), { recursive: true });
  }
  fs.writeFileSync(path.join(backlogPath, 'config.yml'), CONFIG, 'utf-8');

  parser = new BacklogParser(backlogPath);
  writer = new BacklogWriter();
  deps = { parser, writer, treeFieldService: new TreeFieldService() };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Hand-write a task file — the only way to seed a LEGACY board, which no writer can produce. */
function seedFile(
  folder: string,
  fileName: string,
  fm: { id: string; title: string; deps?: string[]; extra?: string },
  description = ''
): void {
  const depBlock = fm.deps?.length
    ? `dependencies:\n${fm.deps.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  const content =
    `---\nid: ${fm.id}\ntitle: ${fm.title}\nstatus: To Do\nassignee: []\n` +
    `${depBlock}${fm.extra ?? ''}---\n\n` +
    `## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${description}\n<!-- SECTION:DESCRIPTION:END -->\n`;
  const dir = path.join(backlogPath, ...folder.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content, 'utf-8');
}

/**
 * Seed the legacy board every case-2/3 test starts from:
 *   drafts/draft-3          — id DRAFT-3, the unstable draft
 *   tasks/task-9            — depends on DRAFT-3 AND names it in prose
 * plus whatever extra inbound holders the caller adds.
 */
function seedLegacyBoard(): void {
  seedFile('drafts', 'draft-3 - Explore-caching.md', { id: 'DRAFT-3', title: 'Explore caching' });
  seedFile(
    'tasks',
    'task-9 - The-dependent.md',
    { id: 'TASK-9', title: 'The dependent', deps: ['DRAFT-3'] },
    'Blocked on DRAFT-3, which does the real work.'
  );
}

describe('stable task ids — acceptance (TASK-121)', () => {
  describe('case 1: a fresh board', () => {
    it('a reference written against a draft survives its promotion — structurally AND in prose', async () => {
      // 1. Author a draft. It is minted with a REAL task id from the shared counter (TASK-115).
      const draft = await writer.createDraft(backlogPath, parser, { title: 'The dependency' });
      expect(draft.id).toMatch(/^TASK-\d+$/);
      expect(draft.filePath).toContain(`${path.sep}drafts${path.sep}`);

      // 2. Reference it by id, both STRUCTURALLY and IN PROSE.
      const dependent = await writer.createTask(
        backlogPath,
        {
          title: 'The dependent',
          description: `Blocked on ${draft.id}, which does the real work.`,
        },
        parser
      );
      await writer.updateTask(dependent.id, { dependencies: [draft.id] }, parser);

      // 3. Promote. A pure file move (TASK-116) — nothing is remapped because nothing changed.
      const promotedId = await writer.promoteDraft(draft.id, parser);
      expect(promotedId).toBe(draft.id);

      // 4. Both references still resolve, and the target is a real task now.
      const t = await parser.getTask(dependent.id);
      expect(t!.dependencies).toEqual([draft.id]);
      // THE assertion. No remap pass can rewrite a sentence; under DRAFT-N ids this line
      // dangled the instant the draft was promoted.
      expect(t!.description).toContain(draft.id);

      const promoted = await parser.getTask(draft.id);
      expect(promoted).toBeDefined();
      expect(promoted!.folder).toBe('tasks');
    });

    it('the id survives a demote/promote round-trip, so the prose never goes stale', async () => {
      const { id } = await writer.createTask(backlogPath, { title: 'Round trip' }, parser);
      await writer.createTask(
        backlogPath,
        { title: 'Cites it', description: `See ${id} for the design.` },
        parser
      );

      expect(await writer.demoteTask(id, parser)).toBe(id);
      expect((await parser.getTask(id))!.folder).toBe('drafts');
      expect(await writer.promoteDraft(id, parser)).toBe(id);
      expect((await parser.getTask(id))!.folder).toBe('tasks');

      const citing = (await parser.getTasks()).find((t) => t.title === 'Cites it');
      expect(citing!.description).toContain(id);
      expect(await parser.getTask(id)).toBeDefined();
    });
  });

  describe('case 2: a legacy board reaches the same state after migration', () => {
    it('re-ids the draft in place, remaps its inbound reference, and keeps it a draft', async () => {
      seedLegacyBoard();

      const { migrated, mapping } = await runDraftIdMigration(deps, backlogPath);
      expect(migrated).toBe(1);
      expect(mapping[0].from).toBe('DRAFT-3');

      const newId = mapping[0].to;
      expect(newId).toMatch(/^TASK-\d+$/);

      // Still a draft — the migration re-ids, it never promotes. The human decides that.
      const migratedDraft = await parser.getTask(newId);
      expect(migratedDraft!.folder).toBe('drafts');

      // The structural inbound reference moved with it.
      expect((await parser.getTask('TASK-9'))!.dependencies).toEqual([newId]);
    });

    it('the invariant holds POST-migration: promoting the migrated draft does not change its id', async () => {
      seedLegacyBoard();
      const { mapping } = await runDraftIdMigration(deps, backlogPath);
      const newId = mapping[0].to;

      // A reference written against the MIGRATED id — structurally and in prose.
      const later = await writer.createTask(
        backlogPath,
        { title: 'Written after the migration', description: `Waits on ${newId}.` },
        parser
      );
      await writer.updateTask(later.id, { dependencies: [newId] }, parser);

      // Promote it now. On a migrated board, exactly as on a fresh one, the id is stable.
      expect(await writer.promoteDraft(newId, parser)).toBe(newId);
      expect((await parser.getTask(newId))!.folder).toBe('tasks');

      expect((await parser.getTask('TASK-9'))!.dependencies).toEqual([newId]);
      const laterTask = await parser.getTask(later.id);
      expect(laterTask!.dependencies).toEqual([newId]);
      expect(laterTask!.description).toContain(newId);
    });

    it('cannot repair the PROSE a legacy id already broke — which is why ids are stable at birth', async () => {
      seedLegacyBoard();
      const { mapping } = await runDraftIdMigration(deps, backlogPath);
      const newId = mapping[0].to;

      const t9 = await parser.getTask('TASK-9');
      // The structured field is remapped...
      expect(t9!.dependencies).toEqual([newId]);
      // ...but the sentence still says DRAFT-3, and always will. A remap pass cannot rewrite
      // free text, and a heuristic that tried would corrupt real prose. This is the damage the
      // legacy id space did, characterized here deliberately: it is unrecoverable, and it is
      // the whole reason the fix is "never change an id" rather than "remap harder".
      expect(t9!.description).toContain('DRAFT-3');
      expect(t9!.description).not.toContain(newId);
      // And the id it names is gone from the board — a genuinely dangling prose reference.
      expect(await parser.getTask('DRAFT-3')).toBeUndefined();
    });

    it('is idempotent — a converged board performs zero further writes', async () => {
      seedLegacyBoard();
      await runDraftIdMigration(deps, backlogPath);
      const second = await runDraftIdMigration(deps, backlogPath);
      expect(second).toEqual({ migrated: 0, mapping: [] });
    });
  });

  describe('case 3: inbound references held outside tasks/ and drafts/', () => {
    it('remaps a COMPLETED task’s dependency on a legacy draft', async () => {
      // A completed task is off the board but still on disk, and its dependency list is a real
      // record of what it was blocked on. If the migration cannot see it, the reference dangles
      // forever — the exact silent breakage stable ids exist to end.
      seedLegacyBoard();
      seedFile('completed', 'task-50 - Shipped.md', {
        id: 'TASK-50',
        title: 'Shipped',
        deps: ['DRAFT-3'],
      });

      const { mapping } = await runDraftIdMigration(deps, backlogPath);
      const newId = mapping[0].to;

      const completed = await parser.getTask('TASK-50');
      expect(completed!.folder).toBe('completed');
      expect(completed!.dependencies).toEqual([newId]);
    });

    it('remaps an ARCHIVED task’s references to a legacy draft', async () => {
      // Archived is a SOFT delete — restore brings the task back to the live board. A reference
      // the migration skipped comes back dangling.
      seedLegacyBoard();
      seedFile('archive/tasks', 'task-51 - Shelved.md', {
        id: 'TASK-51',
        title: 'Shelved',
        deps: ['DRAFT-3'],
        extra: 'parent_task_id: DRAFT-3\nreferences:\n  - DRAFT-3\n',
      });

      const { mapping } = await runDraftIdMigration(deps, backlogPath);
      const newId = mapping[0].to;

      const archived = await parser.getTask('TASK-51');
      expect(archived!.folder).toBe('archive');
      expect(archived!.dependencies).toEqual([newId]);
      expect(archived!.parentTaskId).toBe(newId);
      expect(archived!.references).toEqual([newId]);
    });

    it('remaps a bug caused_by held by an archived DRAFT (archive/drafts/)', async () => {
      seedLegacyBoard();
      seedFile('archive/drafts', 'task-52 - Archived-draft.md', {
        id: 'TASK-52',
        title: 'Archived draft',
        extra: 'type: bug\ncaused_by: DRAFT-3\n',
      });

      const { mapping } = await runDraftIdMigration(deps, backlogPath);
      const newId = mapping[0].to;

      const archivedDraft = await parser.getTask('TASK-52');
      expect(archivedDraft!.causedBy).toBe(newId);
    });

    it('leaves a completed task with no matching reference completely untouched', async () => {
      // Idempotence must not degrade into churn: a file with nothing to remap is not rewritten.
      seedLegacyBoard();
      seedFile('completed', 'task-50 - Unrelated.md', {
        id: 'TASK-50',
        title: 'Unrelated',
        deps: ['TASK-9'],
      });
      const filePath = path.join(backlogPath, 'completed', 'task-50 - Unrelated.md');
      const before = fs.readFileSync(filePath, 'utf-8');

      await runDraftIdMigration(deps, backlogPath);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    });
  });
});
