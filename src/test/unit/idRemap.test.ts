import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
import { remapIds, type IdRemapDeps } from '../../core/idRemap';

let root: string, backlogPath: string;

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-idremap-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
}

function deps(): IdRemapDeps {
  return {
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    treeFieldService: new TreeFieldService(),
  };
}

/** Build a task/draft file body. `extra` appends raw frontmatter lines (bug fields, subtasks, ...). */
function fileContent(id: string, title: string, status: string, deps_: string[], extra: string) {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  return `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nassignee: []\n${depBlock}${extra}---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`;
}

function writeTask(id: string, title: string, deps_: string[] = [], extra = ''): void {
  fs.writeFileSync(
    path.join(backlogPath, 'tasks', `${id.toLowerCase()} - ${title}.md`),
    fileContent(id, title, 'To Do', deps_, extra),
    'utf-8'
  );
}

function writeDraft(id: string, title: string, deps_: string[] = [], extra = ''): void {
  fs.writeFileSync(
    path.join(backlogPath, 'drafts', `${id.toLowerCase()} - ${title}.md`),
    fileContent(id, title, 'To Do', deps_, extra),
    'utf-8'
  );
}

function read(id: string): string {
  for (const dir of ['tasks', 'drafts']) {
    const p = path.join(backlogPath, dir);
    for (const f of fs.existsSync(p) ? fs.readdirSync(p) : []) {
      const c = fs.readFileSync(path.join(p, f), 'utf-8');
      if (new RegExp(`^id:\\s*${id}\\b`, 'm').test(c)) return c;
    }
  }
  throw new Error(`no file for ${id}`);
}

const listBlock = (field: string, ids: string[]) =>
  `${field}:\n${ids.map((i) => `  - ${i}`).join('\n')}\n`;

beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('remapIds', () => {
  it('rewrites dependencies', async () => {
    writeTask('TASK-9', 'Dependent', ['DRAFT-3']);
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-12']);
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites a bug caused_by', async () => {
    writeTask('TASK-9', 'Regression', [], 'type: bug\ncaused_by: DRAFT-3\n');
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.causedBy).toBe('TASK-12');
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites parent_task_id (the gap promoteDrafts never closed)', async () => {
    writeTask('TASK-9', 'Child', [], 'parent_task_id: DRAFT-3\n');
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.parentTaskId).toBe('TASK-12');
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites subtasks (the gap promoteDrafts never closed)', async () => {
    writeTask('TASK-9', 'Parent', [], listBlock('subtasks', ['DRAFT-3']));
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.subtasks).toEqual(['TASK-12']);
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites references[] (the gap promoteDrafts never closed)', async () => {
    writeTask('TASK-9', 'Refs', [], listBlock('references', ['DRAFT-3']));
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.references).toEqual(['TASK-12']);
    expect(remapped).toContain('TASK-9');
  });

  it('rewrites references entries that are not ids without touching them', async () => {
    // references[] legitimately holds non-id values (paths, URLs) — they must survive verbatim.
    writeTask('TASK-9', 'Mixed', [], listBlock('references', ['DRAFT-3', 'docs/spec.md']));
    const d = deps();
    await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.references).toEqual(['TASK-12', 'docs/spec.md']);
  });

  it('rewrites inbound references held by a draft, not just a task', async () => {
    writeDraft('DRAFT-8', 'Draft-dependent', ['DRAFT-3']);
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    expect(remapped).toContain('DRAFT-8');
    expect(read('DRAFT-8')).toMatch(/- TASK-12\b/);
  });

  it('matches the map key case-insensitively (keys are uppercased)', async () => {
    writeTask('TASK-9', 'Lower', ['draft-3']);
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-12']);
    expect(remapped).toContain('TASK-9');
  });

  it('leaves unrelated ids untouched', async () => {
    writeTask('TASK-9', 'Dependent', ['TASK-5']);
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-5']);
    expect(remapped).not.toContain('TASK-9');
  });

  it('does not partially rewrite an id that shares a prefix', async () => {
    writeTask('TASK-9', 'Prefix', ['DRAFT-1', 'DRAFT-11']);
    const d = deps();
    await remapIds(d, new Map([['DRAFT-1', 'TASK-20']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-20', 'DRAFT-11']);
  });

  it('rewrites every reference kind on one task in a single pass', async () => {
    writeTask(
      'TASK-9',
      'All-kinds',
      ['DRAFT-3'],
      `type: bug\ncaused_by: DRAFT-3\nparent_task_id: DRAFT-3\n${listBlock('subtasks', ['DRAFT-3'])}${listBlock('references', ['DRAFT-3'])}`
    );
    const d = deps();
    const remapped = await remapIds(d, new Map([['DRAFT-3', 'TASK-12']]));
    const t9 = await d.parser.getTask('TASK-9');
    expect(t9!.dependencies).toEqual(['TASK-12']);
    expect(t9!.causedBy).toBe('TASK-12');
    expect(t9!.parentTaskId).toBe('TASK-12');
    expect(t9!.subtasks).toEqual(['TASK-12']);
    expect(t9!.references).toEqual(['TASK-12']);
    // reported once, not once per field
    expect(remapped.filter((id) => id === 'TASK-9')).toHaveLength(1);
    expect(read('TASK-9')).not.toMatch(/DRAFT-3/);
  });

  it('performs no writes when nothing matches', async () => {
    writeTask('TASK-9', 'Untouched', ['TASK-5'], 'type: bug\ncaused_by: TASK-5\n');
    const d = deps();
    const update = vi.spyOn(d.writer, 'updateTask');
    const setCausedBy = vi.spyOn(d.treeFieldService, 'setCausedBy');
    const before = read('TASK-9');

    const remapped = await remapIds(d, new Map([['DRAFT-99', 'TASK-99']]));

    expect(remapped).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(setCausedBy).not.toHaveBeenCalled();
    expect(read('TASK-9')).toBe(before);
  });

  it('performs no writes for an empty map', async () => {
    writeTask('TASK-9', 'Untouched', ['DRAFT-3']);
    const d = deps();
    const update = vi.spyOn(d.writer, 'updateTask');
    const remapped = await remapIds(d, new Map());
    expect(remapped).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves CRLF line endings on a rewritten file', async () => {
    const p = path.join(backlogPath, 'tasks', 'task-9 - Crlf.md');
    fs.writeFileSync(
      p,
      fileContent('TASK-9', 'Crlf', 'To Do', ['DRAFT-3'], '').replace(/\n/g, '\r\n'),
      'utf-8'
    );
    await remapIds(deps(), new Map([['DRAFT-3', 'TASK-12']]));
    const after = fs.readFileSync(p, 'utf-8');
    expect(after).toMatch(/- TASK-12\b/);
    expect(after).toContain('\r\n');
    // no lone LF survived the round-trip
    expect(/[^\r]\n/.test(after)).toBe(false);
  });

  it('preserves the claim/tree surgical frontmatter fields through a rewrite', async () => {
    // category / claimed_by are Taskwright surgical fields, absent from FRONTMATTER_FIELD_ORDER.
    // orderFrontmatter appends unknown keys, so an updateTask rewrite must not drop them.
    // (Quoting is js-yaml's call — it emits the minimal valid form — so assert on the value.)
    writeTask('TASK-9', 'Claimed', ['DRAFT-3'], "category: 'Core Board'\nclaimed_by: '@agent/x'\n");
    await remapIds(deps(), new Map([['DRAFT-3', 'TASK-12']]));
    const c = read('TASK-9');
    expect(c).toMatch(/^category: '?Core Board'?$/m);
    expect(c).toMatch(/^claimed_by: '@agent\/x'$/m);
    expect(c).toMatch(/- TASK-12\b/);
  });
});
