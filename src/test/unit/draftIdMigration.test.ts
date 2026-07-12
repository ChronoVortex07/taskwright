/**
 * The legacy-draft-id migration core (TASK-118).
 *
 * A board written before stable ids (TASK-115) has drafts named `DRAFT-3`, whose id changes the
 * moment they are promoted — the exact instability the feature removes. The migration converges
 * such a board: it re-ids each legacy draft IN PLACE (it stays a draft — migration NEVER promotes),
 * relocates legacy archived drafts into `archive/drafts/`, and remaps every inbound reference
 * through the shared `remapIds` core (TASK-113).
 *
 * The planner half is pure (no fs at all). The executor half runs against a REAL temp board: the
 * contract under test is where files physically end up, what their frontmatter says, and — for
 * idempotence — that a converged board is not written to AT ALL (asserted on mtimes AND write
 * spies, never merely on the return value).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
import type { IdRemapDeps } from '../../core/idRemap';
import type { Task, BacklogConfig } from '../../core/types';
import {
  planDraftIdMigration,
  isLegacyDraftBoard,
  runDraftIdMigration,
} from '../../core/draftIdMigration';

// ---------------------------------------------------------------------------
// Pure-planner fixtures — no filesystem.
// ---------------------------------------------------------------------------

function taskFixture(
  id: string,
  folder: NonNullable<Task['folder']>,
  extra: Partial<Task> = {},
  filePath?: string
): Task {
  const dir = folder === 'archive' ? path.join('/b', 'archive', 'tasks') : path.join('/b', folder);
  return {
    id,
    title: `Title ${id}`,
    status: 'To Do',
    assignee: [],
    labels: [],
    dependencies: [],
    createdDate: '2026-01-01',
    filePath: filePath ?? path.join(dir, `${id.toLowerCase()} - Title-${id}.md`),
    folder,
    acceptanceCriteria: [],
    definitionOfDone: [],
    ...extra,
  } as unknown as Task;
}

const CONFIG = (over: Partial<BacklogConfig> = {}): BacklogConfig =>
  ({ task_prefix: 'TASK', ...over }) as BacklogConfig;

describe('planDraftIdMigration (pure)', () => {
  it('yields an empty plan for a board with no legacy drafts', () => {
    const plan = planDraftIdMigration([taskFixture('TASK-5', 'drafts')], [], CONFIG(), 10, '/b');

    expect(plan.renames).toEqual([]);
    expect(plan.relocations).toEqual([]);
    expect(isLegacyDraftBoard(plan)).toBe(false);
  });

  it('plans a legacy DRAFT-3 onto a fresh id above the current max', () => {
    const plan = planDraftIdMigration([taskFixture('DRAFT-3', 'drafts')], [], CONFIG(), 111, '/b');

    expect(plan.renames).toEqual([
      expect.objectContaining({ oldId: 'DRAFT-3', newId: 'TASK-111' }),
    ]);
    expect(plan.renames[0].toPath).toBe(path.join('/b', 'drafts', 'task-111 - Title-DRAFT-3.md'));
    expect(isLegacyDraftBoard(plan)).toBe(true);
  });

  it("classifies a custom-prefix board's own drafts as NOT legacy", () => {
    const plan = planDraftIdMigration(
      [taskFixture('STORY-4', 'drafts')],
      [],
      CONFIG({ task_prefix: 'STORY' }),
      9,
      '/b'
    );

    expect(plan.renames).toEqual([]);
  });

  it('honors zero-padded ids and a custom prefix when minting the new id', () => {
    const plan = planDraftIdMigration(
      [taskFixture('DRAFT-3', 'drafts')],
      [],
      CONFIG({ task_prefix: 'STORY', zero_padded_ids: 3 }),
      7,
      '/b'
    );

    expect(plan.renames[0].newId).toBe('STORY-007');
    expect(plan.renames[0].toPath).toContain(path.join('drafts', 'story-007 - '));
  });

  it('plans drafts dependency-first, so prerequisites get lower ids', () => {
    const a = taskFixture('DRAFT-1', 'drafts', { dependencies: ['DRAFT-2'] });
    const b = taskFixture('DRAFT-2', 'drafts');

    const plan = planDraftIdMigration([a, b], [], CONFIG(), 10, '/b');

    expect(plan.renames.map((r) => r.oldId)).toEqual(['DRAFT-2', 'DRAFT-1']);
    expect(plan.renames.map((r) => r.newId)).toEqual(['TASK-10', 'TASK-11']);
  });

  it('terminates on a dependency cycle between legacy drafts', () => {
    const a = taskFixture('DRAFT-1', 'drafts', { dependencies: ['DRAFT-2'] });
    const b = taskFixture('DRAFT-2', 'drafts', { dependencies: ['DRAFT-1'] });

    const plan = planDraftIdMigration([a, b], [], CONFIG(), 10, '/b');

    expect(plan.renames.map((r) => r.oldId).sort()).toEqual(['DRAFT-1', 'DRAFT-2']);
  });

  it('plans a legacy archived draft for relocation to archive/drafts/', () => {
    const archived = [
      taskFixture(
        'DRAFT-9',
        'archive',
        {},
        path.join('/b', 'archive', 'tasks', 'draft-9 - Old.md')
      ),
    ];

    const plan = planDraftIdMigration([], archived, CONFIG(), 10, '/b');

    expect(plan.relocations).toEqual([
      {
        id: 'DRAFT-9',
        fromPath: path.join('/b', 'archive', 'tasks', 'draft-9 - Old.md'),
        toPath: path.join('/b', 'archive', 'drafts', 'draft-9 - Old.md'),
      },
    ]);
    expect(isLegacyDraftBoard(plan)).toBe(true);
  });

  it('does not relocate a stable-id archived task, nor one already in archive/drafts/', () => {
    const archived = [
      taskFixture('TASK-4', 'archive', {}, path.join('/b', 'archive', 'tasks', 'task-4 - Real.md')),
      taskFixture(
        'DRAFT-9',
        'archive',
        {},
        path.join('/b', 'archive', 'drafts', 'draft-9 - Already.md')
      ),
    ];

    const plan = planDraftIdMigration([], archived, CONFIG(), 10, '/b');

    expect(plan.relocations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Executor — real temp board.
// ---------------------------------------------------------------------------

let root: string;
let backlogPath: string;
let deps: IdRemapDeps;

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-draftmig-'));
  backlogPath = path.join(root, 'backlog');
  for (const dir of ['tasks', 'drafts', 'completed', 'archive/tasks', 'archive/drafts']) {
    fs.mkdirSync(path.join(backlogPath, ...dir.split('/')), { recursive: true });
  }
  writeConfig();
  deps = {
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    treeFieldService: new TreeFieldService(),
  };
}

function writeConfig(prefix = 'task', padding?: number): void {
  const pad = padding ? `zero_padded_ids: ${padding}\n` : '';
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    `project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "${prefix}"\n${pad}`,
    'utf-8'
  );
}

function fileContent(id: string, title: string, deps_: string[], extra: string, status = 'To Do') {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nassignee: []\n${depBlock}${extra}---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nBody of ${id}.\n<!-- SECTION:DESCRIPTION:END -->\n`;
}

/** Write a file into any board folder, verbatim (so we can seed LEGACY shapes by hand). */
function seed(
  folder: string,
  fileName: string,
  id: string,
  title: string,
  deps_: string[] = [],
  extra = '',
  opts: { crlf?: boolean; status?: string } = {}
): string {
  const dir = path.join(backlogPath, ...folder.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  let content = fileContent(id, title, deps_, extra, opts.status ?? 'To Do');
  if (opts.crlf) content = content.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const listBlock = (field: string, ids: string[]) =>
  `${field}:\n${ids.map((i) => `  - ${i}`).join('\n')}\n`;

/** Every board file with its mtime — the write detector for the idempotence assertions. */
function snapshotBoard(): Map<string, { mtimeMs: number; content: string }> {
  const snap = new Map<string, { mtimeMs: number; content: string }>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        snap.set(full, {
          mtimeMs: fs.statSync(full).mtimeMs,
          content: fs.readFileSync(full, 'utf-8'),
        });
    }
  };
  walk(backlogPath);
  return snap;
}

function expectNoWrites(before: Map<string, { mtimeMs: number; content: string }>): void {
  const after = snapshotBoard();
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [file, state] of after) {
    expect(state.content).toBe(before.get(file)!.content);
    expect(state.mtimeMs).toBe(before.get(file)!.mtimeMs);
  }
}

/** Spies over every write path the migration can reach. */
function writeSpies() {
  return {
    reid: vi.spyOn(deps.writer, 'reidTaskFile'),
    update: vi.spyOn(deps.writer, 'updateTask'),
    causedBy: vi.spyOn(deps.treeFieldService, 'setCausedBy'),
  };
}

beforeEach(scaffold);
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runDraftIdMigration', () => {
  it('re-ids a legacy draft IN PLACE and remaps every inbound reference kind', async () => {
    seed('drafts', 'draft-3 - Legacy.md', 'DRAFT-3', 'Legacy');
    seed(
      'tasks',
      'task-9 - Dependent.md',
      'TASK-9',
      'Dependent',
      ['DRAFT-3'],
      `parent_task_id: DRAFT-3\n${listBlock('subtasks', ['DRAFT-3'])}${listBlock('references', ['DRAFT-3'])}`
    );

    const { migrated, mapping } = await runDraftIdMigration(deps, backlogPath);

    expect(migrated).toBe(1);
    expect(mapping).toHaveLength(1);
    expect(mapping[0].from).toBe('DRAFT-3');
    const newId = mapping[0].to;
    expect(newId).toMatch(/^TASK-\d+$/);

    // It is STILL a draft — the migration re-ids, it never promotes.
    const migratedDraft = await deps.parser.getTask(newId);
    expect(migratedDraft!.folder).toBe('drafts');
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-3 - Legacy.md'))).toBe(false);
    expect(fs.readdirSync(path.join(backlogPath, 'tasks'))).toEqual(['task-9 - Dependent.md']);

    // All five inbound reference kinds, via the shared remapIds core.
    const t9 = await deps.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual([newId]);
    expect(t9!.parentTaskId).toBe(newId);
    expect(t9!.subtasks).toEqual([newId]);
    expect(t9!.references).toEqual([newId]);
  });

  it('remaps a bug caused_by pointing at a legacy draft', async () => {
    seed('drafts', 'draft-3 - Cause.md', 'DRAFT-3', 'Cause');
    seed(
      'tasks',
      'task-9 - Regression.md',
      'TASK-9',
      'Regression',
      [],
      'type: bug\ncaused_by: DRAFT-3\n'
    );

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    const t9 = await deps.parser.getTask('TASK-9');
    expect(t9!.causedBy).toBe(mapping[0].to);
  });

  it('mints the new id above the max across ALL folders, not just tasks/', async () => {
    seed('drafts', 'draft-1 - Legacy.md', 'DRAFT-1', 'Legacy');
    seed('tasks', 'task-2 - Live.md', 'TASK-2', 'Live');
    seed('completed', 'task-20 - Done.md', 'TASK-20', 'Done', [], '', { status: 'Done' });
    seed('archive/tasks', 'task-31 - Gone.md', 'TASK-31', 'Gone');

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    expect(mapping[0].to).toBe('TASK-32');
  });

  it('remaps a dependency BETWEEN two legacy drafts (both ends move)', async () => {
    seed('drafts', 'draft-1 - Dependent.md', 'DRAFT-1', 'Dependent', ['DRAFT-2']);
    seed('drafts', 'draft-2 - Prereq.md', 'DRAFT-2', 'Prereq');

    const { migrated, mapping } = await runDraftIdMigration(deps, backlogPath);

    expect(migrated).toBe(2);
    const byOld = new Map(mapping.map((m) => [m.from, m.to]));
    // Dependency-first: the prerequisite takes the lower id.
    expect(byOld.get('DRAFT-2')).toBe('TASK-1');
    expect(byOld.get('DRAFT-1')).toBe('TASK-2');

    const dependent = await deps.parser.getTask(byOld.get('DRAFT-1')!);
    expect(dependent!.dependencies).toEqual([byOld.get('DRAFT-2')]);
    expect(dependent!.folder).toBe('drafts');
  });

  it('relocates a legacy archived draft into archive/drafts/', async () => {
    seed('archive/tasks', 'draft-9 - Old.md', 'DRAFT-9', 'Old');

    await runDraftIdMigration(deps, backlogPath);

    expect(fs.existsSync(path.join(backlogPath, 'archive', 'tasks', 'draft-9 - Old.md'))).toBe(
      false
    );
    expect(fs.readdirSync(path.join(backlogPath, 'archive', 'drafts'))).toEqual([
      'draft-9 - Old.md',
    ]);
  });

  it('preserves the draft status and the body across the re-id', async () => {
    seed('drafts', 'draft-4 - Baseline.md', 'DRAFT-4', 'Baseline', [], '', { status: 'Done' });

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    const migrated = await deps.parser.getTask(mapping[0].to);
    expect(migrated!.status).toBe('Done');
    expect(migrated!.folder).toBe('drafts');
    expect(fs.readFileSync(migrated!.filePath, 'utf-8')).toContain('Body of DRAFT-4.');
  });

  it('preserves CRLF line endings across the re-id', async () => {
    seed('drafts', 'draft-5 - Windows.md', 'DRAFT-5', 'Windows', [], '', { crlf: true });

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    const migrated = await deps.parser.getTask(mapping[0].to);
    const raw = fs.readFileSync(migrated!.filePath, 'utf-8');
    expect(raw).toContain('\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n'); // no mixed endings
    expect(raw).toContain(`id: ${mapping[0].to}`);
  });

  it('keeps the frontmatter byte-compatible — field order and shape survive', async () => {
    seed(
      'drafts',
      'draft-6 - Compat.md',
      'DRAFT-6',
      'Compat',
      ['TASK-2'],
      'priority: high\nlabels:\n  - ui\n'
    );
    seed('tasks', 'task-2 - Prereq.md', 'TASK-2', 'Prereq');

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    const migrated = await deps.parser.getTask(mapping[0].to);
    const fm = fs.readFileSync(migrated!.filePath, 'utf-8').split('---')[1];
    const order = fm
      .split('\n')
      .filter((l) => /^\w+:/.test(l))
      .map((l) => l.split(':')[0]);
    // Upstream serialization order: id, title, status, assignee, ..., labels, ..., dependencies, ..., priority
    expect(order.indexOf('id')).toBe(0);
    expect(order.indexOf('title')).toBe(1);
    expect(order.indexOf('status')).toBe(2);
    expect(order.indexOf('labels')).toBeLessThan(order.indexOf('dependencies'));
    expect(order.indexOf('dependencies')).toBeLessThan(order.indexOf('priority'));
    expect(migrated!.dependencies).toEqual(['TASK-2']); // untouched — not a renamed id
    expect(migrated!.priority).toBe('high');
  });

  it('does nothing at all on a clean board — ZERO writes', async () => {
    seed('tasks', 'task-1 - Live.md', 'TASK-1', 'Live');
    seed('drafts', 'task-2 - Stable draft.md', 'TASK-2', 'Stable draft');
    const before = snapshotBoard();
    const spies = writeSpies();

    const result = await runDraftIdMigration(deps, backlogPath);

    expect(result).toEqual({ migrated: 0, mapping: [] });
    expect(spies.reid).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.causedBy).not.toHaveBeenCalled();
    expectNoWrites(before);
  });

  it('is IDEMPOTENT — a second run performs zero writes', async () => {
    seed('drafts', 'draft-3 - Legacy.md', 'DRAFT-3', 'Legacy');
    seed('tasks', 'task-9 - Dependent.md', 'TASK-9', 'Dependent', ['DRAFT-3']);
    seed('archive/tasks', 'draft-9 - Old.md', 'DRAFT-9', 'Old');

    const first = await runDraftIdMigration(deps, backlogPath);
    expect(first.migrated).toBe(1);

    const before = snapshotBoard();
    const spies = writeSpies();

    const second = await runDraftIdMigration(deps, backlogPath);

    expect(second).toEqual({ migrated: 0, mapping: [] });
    expect(spies.reid).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.causedBy).not.toHaveBeenCalled();
    expectNoWrites(before);
  });

  it('does not churn a custom-prefix board that owns its own draft ids', async () => {
    writeConfig('story');
    seed('drafts', 'story-4 - Mine.md', 'STORY-4', 'Mine');
    const before = snapshotBoard();

    const result = await runDraftIdMigration(deps, backlogPath);

    expect(result.migrated).toBe(0);
    expectNoWrites(before);
  });

  it('honors zero-padded ids when re-iding', async () => {
    writeConfig('task', 3);
    seed('drafts', 'draft-3 - Padded.md', 'DRAFT-3', 'Padded');

    const { mapping } = await runDraftIdMigration(deps, backlogPath);

    expect(mapping[0].to).toBe('TASK-001');
    expect((await deps.parser.getTask('TASK-001'))!.folder).toBe('drafts');
  });
});
