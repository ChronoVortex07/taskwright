/**
 * ID allocation: the GLOBAL next-id scan and the SHARED allocation lock (TASK-114).
 *
 * These run against a REAL temp board (no `fs` mock). The whole point of this task is
 * filesystem-level atomicity — `mkdir` EEXIST is the mutex — so a mocked `fs` would prove
 * nothing. The other BacklogWriter suites mock `fs`; this one deliberately does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { BOARD_SUBDIRS } from '../../core/boardRef';
import { boardTrackedPaths } from '../../core/boardMigration';

let root: string;
let backlogPath: string;
let writer: BacklogWriter;
let parser: BacklogParser;

function scaffold(taskPrefix = 'task', zeroPad = 0): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-idalloc-'));
  backlogPath = path.join(root, 'backlog');
  for (const sub of ['tasks', 'drafts', 'completed', 'archive/tasks', 'archive/drafts']) {
    fs.mkdirSync(path.join(backlogPath, ...sub.split('/')), { recursive: true });
  }
  const padLine = zeroPad > 0 ? `zero_padded_ids: ${zeroPad}\n` : '';
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    `project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "${taskPrefix}"\n${padLine}`,
    'utf-8'
  );
  writer = new BacklogWriter();
  parser = new BacklogParser(backlogPath);
}

/** Drop a task file straight into a board folder, bypassing the writer. */
function seed(folder: string, fileName: string, id: string): void {
  fs.writeFileSync(
    path.join(backlogPath, ...folder.split('/'), fileName),
    `---\nid: ${id}\ntitle: Seeded\nstatus: To Do\nassignee: []\ndependencies: []\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}

const locksDir = (): string => path.join(backlogPath, '.locks');

beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('getNextTaskId (global scan)', () => {
  it('takes the max across tasks/, drafts/, completed/ and archive/ — not tasks/ alone', async () => {
    seed('tasks', 'task-3 - A.md', 'TASK-3');
    seed('drafts', 'task-7 - B.md', 'TASK-7');
    seed('completed', 'task-5 - C.md', 'TASK-5');
    seed('archive/tasks', 'task-9 - D.md', 'TASK-9');

    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    // 9 is the max ANYWHERE. Scanning tasks/ alone would have said TASK-4.
    expect(id).toBe('TASK-10');
  });

  it('scans archive/drafts/ too', async () => {
    seed('tasks', 'task-2 - A.md', 'TASK-2');
    seed('archive/drafts', 'task-30 - Archived draft.md', 'TASK-30');

    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(id).toBe('TASK-31');
  });

  it('does not let a restored archived task collide with a live task', async () => {
    // The bug: archive/ was invisible to the scan, so restoring TASK-12 would land on a
    // live id minted in the meantime.
    seed('tasks', 'task-2 - Live.md', 'TASK-2');
    seed('archive/tasks', 'task-12 - Archived.md', 'TASK-12');

    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(id).toBe('TASK-13');
  });

  it('ignores a legacy draft-N filename in drafts/ (it does not carry the task prefix)', async () => {
    seed('tasks', 'task-2 - A.md', 'TASK-2');
    seed('drafts', 'draft-99 - Legacy.md', 'DRAFT-99');

    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    // draft-99 must contribute nothing — the scan is anchored on the configured task prefix.
    expect(id).toBe('TASK-3');
  });

  it('honours a custom task_prefix across every scanned folder', async () => {
    scaffold('story', 3);
    seed('archive/tasks', 'story-041 - Archived.md', 'STORY-041');
    seed('tasks', 'task-77 - Foreign prefix.md', 'TASK-77');

    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    // STORY-41 is the max in the STORY namespace; the stray task-77 is not our prefix.
    expect(id).toBe('STORY-042');
  });

  it('still honours crossBranchIds', async () => {
    seed('tasks', 'task-2 - A.md', 'TASK-2');
    const { id } = await writer.createTask(backlogPath, { title: 'Next' }, parser, ['TASK-50']);
    expect(id).toBe('TASK-51');
  });
});

describe('allocateAndWrite (shared lock namespace)', () => {
  it('locks in ONE shared backlog/.locks/ dir, not inside the target directory', async () => {
    // Hold the lock for id 5 as a concurrent writer in another process would, mid-write.
    seed('tasks', 'task-4 - A.md', 'TASK-4'); // scan → 5
    fs.mkdirSync(locksDir(), { recursive: true });
    fs.mkdirSync(path.join(locksDir(), '.task-5.lock'));

    const { id } = await writer.createTask(backlogPath, { title: 'Contender' }, parser);

    // The held lock must be SEEN. Under the old per-directory lock (tasks/.task-5.lock)
    // this lock was invisible and the writer would have clobbered TASK-5.
    expect(id).toBe('TASK-6');
  });

  it('createDraft locks in the same shared namespace', async () => {
    fs.mkdirSync(locksDir(), { recursive: true });
    fs.mkdirSync(path.join(locksDir(), '.draft-1.lock'));

    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Contender' });

    // Both writers' locks now live in ONE directory — which is what makes the mutex work
    // across them once they share a counter (and, from Task 3, a lock name).
    expect(id).toBe('DRAFT-2');
  });

  it('releases the lock after a successful allocation', async () => {
    await writer.createTask(backlogPath, { title: 'A' }, parser);
    expect(fs.readdirSync(locksDir())).toEqual([]);
  });

  it('gives distinct ids to a concurrent createTask and createDraft', async () => {
    // AC#5 — the TASK-48 clobber, re-armed by the shared counter. This is the end-to-end
    // contract; it becomes load-bearing the moment createDraft mints TASK-N (Task 3).
    const [a, b] = await Promise.all([
      writer.createTask(backlogPath, { title: 'A' }, parser),
      writer.createDraft(backlogPath, parser, { title: 'B' }),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(fs.existsSync(a.filePath)).toBe(true);
    expect(fs.existsSync(b.filePath)).toBe(true);
  });

  it('gives distinct ids to concurrent createTask calls (TASK-48 regression)', async () => {
    const made = await Promise.all(
      ['A', 'B', 'C', 'D'].map((t) => writer.createTask(backlogPath, { title: t }, parser))
    );
    const ids = made.map((m) => m.id);
    expect(new Set(ids).size).toBe(4);
    for (const m of made) expect(fs.existsSync(m.filePath)).toBe(true);
    expect(new Set(made.map((m) => m.filePath)).size).toBe(4);
  });

  it('two OVERLAPPING writers contending for the same id from different target dirs get distinct ids', async () => {
    // The re-armed clobber, proven directly against the mutex.
    //
    // Two allocators start from the SAME scanned id (two processes that both scanned before
    // either wrote), targeting DIFFERENT directories, under the SAME lock name — exactly what
    // createTask and a task-id-minting createDraft (TASK-115) will do.
    //
    // The lock is released as soon as the file is written, so it only guards an OVERLAPPING
    // writer — which is what real concurrency is. We reproduce that overlap faithfully by
    // running the second allocation inside the first's `buildFile`, the window in which the
    // first still holds its lock.
    //
    // Under the old per-directory lock these were two namespaces that could not see each
    // other: tasks/.task-5.lock and drafts/.task-5.lock BOTH succeed, both writers return id
    // 5, and two files claim TASK-5. One shared dir fixes it.
    const alloc = writer as unknown as {
      allocateAndWrite<T>(
        backlogPath: string,
        startId: number,
        lockDirName: (id: number) => string,
        buildFile: (id: number) => { filePath: string; content: string; result: T }
      ): T;
    };
    const lockName = (id: number) => `.task-${id}.lock`;
    const build = (dir: string) => (id: number) => ({
      filePath: path.join(backlogPath, dir, `task-${id} - ${dir}.md`),
      content: `---\nid: TASK-${id}\ntitle: ${dir}\n---\n`,
      result: id,
    });

    let inner = -1;
    const outer = alloc.allocateAndWrite(backlogPath, 5, lockName, (id) => {
      // The outer writer holds .locks/.task-5.lock right now. This is the overlap.
      inner = alloc.allocateAndWrite(backlogPath, 5, lockName, build('drafts'));
      return build('tasks')(id);
    });

    expect(outer).toBe(5);
    expect(inner).toBe(6); // NOT 5 — the shared namespace saw the held claim
    expect(inner).not.toBe(outer);

    // And the two ids really are on disk as distinct files.
    expect(fs.existsSync(path.join(backlogPath, 'tasks', 'task-5 - tasks.md'))).toBe(true);
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'task-6 - drafts.md'))).toBe(true);
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'task-5 - drafts.md'))).toBe(false);
  });
});

describe('.locks/ hygiene', () => {
  it('is never parsed as board content', async () => {
    await writer.createTask(backlogPath, { title: 'Real' }, parser);
    // Leave a stranded lock dir behind (a crashed writer would).
    fs.mkdirSync(path.join(locksDir(), '.task-99.lock'), { recursive: true });

    const tasks = await parser.getTasks();
    const drafts = await parser.getDrafts();

    expect(tasks.map((t) => t.title)).toEqual(['Real']);
    expect(drafts).toEqual([]);
  });

  it('is never committed by either board-sync pathspec', () => {
    // Both sync engines are allow-lists, not deny-lists: boardRef's BOARD_SUBDIRS is what the
    // ref snapshots, and boardTrackedPaths() is the pathspec autoSync stages/commits. Lock
    // state is transient and must never reach the ref via either one.
    expect(BOARD_SUBDIRS).not.toContain('.locks');
    expect(BOARD_SUBDIRS.some((d) => d.includes('lock'))).toBe(false);

    const staged = boardTrackedPaths();
    expect(staged.some((p) => p.includes('lock'))).toBe(false);
    expect(staged).not.toContain('backlog/.locks');
  });
});
