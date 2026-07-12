/**
 * Archive and restore route by FOLDER, not by id prefix (TASK-117).
 *
 * `restoreArchivedTask` used to branch on `taskId.startsWith('DRAFT-')` — the last runtime branch
 * on an id prefix in the codebase. Since TASK-115 a draft is minted as `TASK-N` in `drafts/`
 * (`folder === 'drafts'` is the SOLE draftness marker), so that branch would restore an archived
 * draft into `tasks/`. Archive now sends a draft to `archive/drafts/` and restore returns it to the
 * folder it came from, reading the path — never the id.
 *
 * These run against a REAL temp board (no `fs` mock): the contract under test is where the file
 * physically ends up and whether the parser can still SEE it afterwards — an archived draft the
 * parser cannot enumerate is data loss, not cosmetics. (Sibling suites BacklogWriter.pureMove /
 * BacklogWriter.idAllocation do the same.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';

let root: string;
let backlogPath: string;
let writer: BacklogWriter;
let parser: BacklogParser;

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-archive-'));
  backlogPath = path.join(root, 'backlog');
  for (const sub of ['tasks', 'drafts', 'completed', 'archive/tasks', 'archive/drafts']) {
    fs.mkdirSync(path.join(backlogPath, ...sub.split('/')), { recursive: true });
  }
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    `project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n`,
    'utf-8'
  );
  writer = new BacklogWriter();
  parser = new BacklogParser(backlogPath);
}

/** Drop a file straight into a board folder, bypassing the writer (used for legacy seeds). */
function seed(folder: string, fileName: string, body: string): string {
  const p = path.join(backlogPath, ...folder.split('/'), fileName);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

const legacyDraft = (id: string, title: string): string =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: To Do\nassignee: []\ndependencies: []\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`;

beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('archive/restore round-trip', () => {
  it('archives a draft to archive/drafts/ and restores it to drafts/', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Arch' });

    const archived = await writer.archiveTask(id, parser);
    expect(archived).toContain(path.join('archive', 'drafts'));
    expect((await parser.getTask(id))!.folder).toBe('archive');

    await writer.restoreArchivedTask(id, parser);
    const restored = await parser.getTask(id);
    expect(restored!.folder).toBe('drafts'); // NOT tasks/ — it was a draft
    expect(restored!.id).toBe(id); // id never changed
    expect(restored!.filePath.split(path.sep).join('/')).toContain('/backlog/drafts/');
  });

  it('archives a task to archive/tasks/ and restores it to tasks/', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'T' }, parser);

    const archived = await writer.archiveTask(id, parser);
    expect(archived).toContain(path.join('archive', 'tasks'));

    await writer.restoreArchivedTask(id, parser);
    expect((await parser.getTask(id))!.folder).toBe('tasks');
  });

  it('routes by FOLDER, not by id prefix — a TASK-N draft restores to drafts/', async () => {
    // The regression the old `taskId.startsWith('DRAFT-')` branch could not survive.
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Folder routed' });
    expect(id).toMatch(/^TASK-\d+$/);

    await writer.archiveTask(id, parser);
    await writer.restoreArchivedTask(id, parser);

    expect((await parser.getTask(id))!.folder).toBe('drafts');
  });

  it('preserves a draft status across the archive round-trip', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, {
      title: 'Done baseline',
      status: 'Done',
    });

    await writer.archiveTask(id, parser);
    await writer.restoreArchivedTask(id, parser);

    const restored = await parser.getTask(id);
    expect(restored!.folder).toBe('drafts');
    expect(restored!.status).toBe('Done');
  });

  it('LEGACY: a DRAFT-N draft also routes by folder — archive/drafts/ → drafts/', async () => {
    seed('drafts', 'draft-3 - Legacy.md', legacyDraft('DRAFT-3', 'Legacy'));

    const archived = await writer.archiveTask('DRAFT-3', parser);
    expect(archived).toContain(path.join('archive', 'drafts'));

    await writer.restoreArchivedTask('DRAFT-3', parser);
    expect((await parser.getTask('DRAFT-3'))!.folder).toBe('drafts');
  });

  it('a task archived to archive/tasks/ restores to tasks/ even when its id looks like a draft id', async () => {
    // Folder wins over the id in BOTH directions: a DRAFT-prefixed file living in tasks/ is a
    // task, and must come back as one.
    seed('tasks', 'draft-9 - Misnamed.md', legacyDraft('DRAFT-9', 'Misnamed'));

    const archived = await writer.archiveTask('DRAFT-9', parser);
    expect(archived).toContain(path.join('archive', 'tasks'));

    await writer.restoreArchivedTask('DRAFT-9', parser);
    expect((await parser.getTask('DRAFT-9'))!.folder).toBe('tasks');
  });

  it('throws when the task does not exist', async () => {
    await expect(writer.archiveTask('TASK-999', parser)).rejects.toThrow('TASK-999');
    await expect(writer.restoreArchivedTask('TASK-999', parser)).rejects.toThrow('TASK-999');
  });
});

describe('BacklogParser enumerates archive/drafts/', () => {
  it('sees an archived draft via getTask (an invisible archived draft would be data loss)', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Hidden' });
    const archivedPath = await writer.archiveTask(id, parser);
    expect(fs.existsSync(archivedPath)).toBe(true);

    const found = await parser.getTask(id);
    expect(found).toBeDefined();
    expect(found!.folder).toBe('archive');
    expect(found!.filePath).toBe(archivedPath);
  });

  it('lists an archived draft alongside archived tasks in getArchivedTasks()', async () => {
    const { id: draftId } = await writer.createDraft(backlogPath, parser, { title: 'AD' });
    const { id: taskId } = await writer.createTask(backlogPath, { title: 'AT' }, parser);
    await writer.archiveTask(draftId, parser);
    await writer.archiveTask(taskId, parser);

    const archived = await parser.getArchivedTasks();

    expect(archived.map((t) => t.id).sort()).toEqual([draftId, taskId].sort());
    expect(archived.every((t) => t.folder === 'archive')).toBe(true);
  });

  it('does not report an archived draft as a live draft', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Gone' });
    await writer.archiveTask(id, parser);

    expect((await parser.getDrafts()).map((t) => t.id)).not.toContain(id);
  });
});

describe('no runtime branch on an id prefix remains', () => {
  const SRC = path.resolve(__dirname, '..', '..');

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'node_modules') {
          continue;
        }
        sourceFiles(full, acc);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) {
        acc.push(full);
      }
    }
    return acc;
  }

  /** Strip block and line comments so prose ABOUT the deleted branch is not mistaken for it. */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('no source file branches on a literal DRAFT- id prefix', () => {
    const offenders = sourceFiles(SRC).filter((f) =>
      /startsWith\(\s*['"`]DRAFT-/.test(code(fs.readFileSync(f, 'utf-8')))
    );
    expect(offenders).toEqual([]);
  });
});
