/**
 * Promote and demote are PURE FILE MOVES (TASK-116).
 *
 * With drafts minting stable task ids (TASK-115), promoting a draft cannot change its id:
 * drafts/ → tasks/ is a rename, the id and the status ride along untouched, and there is
 * nothing to remap. Demote is the exact mirror.
 *
 * These run against a REAL temp board (no `fs` mock) — the contract under test is where the
 * file physically ends up and what bytes survive the move (CRLF included), which a mocked
 * `fs` cannot prove. (Sibling suite BacklogWriter.idAllocation.test.ts does the same.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter, idHasPrefix } from '../../core/BacklogWriter';

let root: string;
let backlogPath: string;
let writer: BacklogWriter;
let parser: BacklogParser;

function scaffold(taskPrefix = 'task', zeroPad = 0): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-puremove-'));
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

/** Drop a file straight into a board folder, bypassing the writer (used for legacy seeds). */
function seed(folder: string, fileName: string, body: string): string {
  const p = path.join(backlogPath, ...folder.split('/'), fileName);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

const legacyDraft = (id: string, title: string, status = 'To Do'): string =>
  `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nassignee: []\ndependencies: []\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`;

beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('idHasPrefix', () => {
  it('accepts an id in the board’s task namespace', () => {
    expect(idHasPrefix('TASK-112', 'TASK')).toBe(true);
    expect(idHasPrefix('task-112', 'TASK')).toBe(true);
    expect(idHasPrefix('TASK-007', 'task')).toBe(true);
  });

  it('rejects a legacy DRAFT-N id', () => {
    expect(idHasPrefix('DRAFT-3', 'TASK')).toBe(false);
  });

  it('classifies a custom-prefix board’s own ids as in-namespace (never a literal DRAFT- test)', () => {
    expect(idHasPrefix('STORY-4', 'STORY')).toBe(true);
    expect(idHasPrefix('TASK-4', 'STORY')).toBe(false);
  });

  it('requires a numeric suffix', () => {
    expect(idHasPrefix('TASKS-1', 'TASK')).toBe(false);
    expect(idHasPrefix('TASK-', 'TASK')).toBe(false);
  });
});

describe('promoteDraft', () => {
  it('is a PURE MOVE for a stable-id draft — same id, same status, file relocated', async () => {
    const { id, filePath } = await writer.createDraft(backlogPath, parser, {
      title: 'Stable',
      status: 'In Progress',
    });

    const newId = await writer.promoteDraft(id, parser);

    expect(newId).toBe(id); // THE POINT: the id never changes
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('tasks');
    expect(task!.status).toBe('In Progress'); // preserved (P6/D2d)
    expect(task!.filePath).toContain(path.join('tasks', 'task-'));
    expect(fs.existsSync(filePath)).toBe(false); // the drafts/ file is gone
  });

  it('preserves a Done draft as a Done task', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'D', status: 'Done' });
    await writer.promoteDraft(id, parser);
    expect((await parser.getTask(id))!.status).toBe('Done');
  });

  it('does not consume a fresh id when promoting in place', async () => {
    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Stable' });
    await writer.promoteDraft(id, parser);
    // The next created task takes the id AFTER the promoted one — promotion burned nothing.
    const next = await writer.createTask(backlogPath, { title: 'Next' }, parser);
    expect(next.id).toBe('TASK-2');
    expect(id).toBe('TASK-1');
  });

  it('LEGACY: still re-ids a DRAFT-N draft to a fresh TASK-M', async () => {
    seed('drafts', 'draft-3 - Legacy.md', legacyDraft('DRAFT-3', 'Legacy'));

    const newId = await writer.promoteDraft('DRAFT-3', parser);

    expect(newId).toMatch(/^TASK-\d+$/);
    expect(newId).not.toBe('DRAFT-3');
    const task = await parser.getTask(newId);
    expect(task!.folder).toBe('tasks');
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-3 - Legacy.md'))).toBe(false);
  });

  it('LEGACY: a synthetic `Draft` status still resets to the board default', async () => {
    seed('drafts', 'draft-3 - Legacy.md', legacyDraft('DRAFT-3', 'Legacy', 'Draft'));
    const newId = await writer.promoteDraft('DRAFT-3', parser);
    expect((await parser.getTask(newId))!.status).toBe('To Do');
  });

  it('keeps zero padding and a custom prefix on an in-place promote', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    scaffold('story', 3);

    const { id } = await writer.createDraft(backlogPath, parser, { title: 'Padded' });
    expect(id).toBe('STORY-001');

    const newId = await writer.promoteDraft(id, parser);

    expect(newId).toBe('STORY-001'); // a custom-prefix draft is NOT legacy
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('tasks');
    expect(path.basename(task!.filePath)).toBe('story-001 - Padded.md');
  });

  it('preserves CRLF line endings across the move', async () => {
    const { id, filePath } = await writer.createDraft(backlogPath, parser, { title: 'Windows' });
    // Rewrite the draft with CRLF, as a Windows checkout would have it on disk.
    fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf-8').replace(/\n/g, '\r\n'), 'utf-8');
    parser.invalidateTaskCache(filePath);

    await writer.promoteDraft(id, parser);

    const moved = fs.readFileSync((await parser.getTask(id))!.filePath, 'utf-8');
    expect(moved).toContain('\r\n');
    expect(moved.replace(/\r\n/g, '')).not.toContain('\n'); // no mixed endings
  });
});

describe('demoteTask', () => {
  it('is a PURE MOVE — same id, same status, file relocated to drafts/', async () => {
    const { id, filePath } = await writer.createTask(
      backlogPath,
      { title: 'T', status: 'In Progress' },
      parser
    );

    const newId = await writer.demoteTask(id, parser);

    expect(newId).toBe(id);
    const task = await parser.getTask(id);
    expect(task!.folder).toBe('drafts');
    expect(task!.status).toBe('In Progress');
    expect(path.basename(task!.filePath)).toBe(path.basename(filePath));
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('writes no DRAFT-N id into the demoted file', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'T' }, parser);
    await writer.demoteTask(id, parser);
    const content = fs.readFileSync((await parser.getTask(id))!.filePath, 'utf-8');
    expect(content).toContain(`id: ${id}`);
    expect(content).not.toContain('DRAFT-');
  });

  it('leaves an inbound dependency valid — the id it points at never moved', async () => {
    const { id: base } = await writer.createTask(backlogPath, { title: 'Base' }, parser);
    const { id: uses } = await writer.createTask(backlogPath, { title: 'Uses' }, parser);
    await writer.updateTask(uses, { dependencies: [base] }, parser);

    await writer.demoteTask(base, parser);

    const dependent = await parser.getTask(uses);
    expect(dependent!.dependencies).toEqual([base]); // still resolves; nothing dangled
    expect((await parser.getTask(base))!.folder).toBe('drafts');
  });

  it('preserves CRLF line endings across the move', async () => {
    const { id, filePath } = await writer.createTask(backlogPath, { title: 'Windows' }, parser);
    fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf-8').replace(/\n/g, '\r\n'), 'utf-8');
    parser.invalidateTaskCache(filePath);

    await writer.demoteTask(id, parser);

    const moved = fs.readFileSync((await parser.getTask(id))!.filePath, 'utf-8');
    expect(moved).toContain('\r\n');
    expect(moved.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('round-trips: create → demote → promote keeps one id throughout', async () => {
    const { id } = await writer.createTask(backlogPath, { title: 'RT' }, parser);
    expect(await writer.demoteTask(id, parser)).toBe(id);
    expect((await parser.getTask(id))!.folder).toBe('drafts');
    expect(await writer.promoteDraft(id, parser)).toBe(id);
    expect((await parser.getTask(id))!.folder).toBe('tasks');
  });
});
