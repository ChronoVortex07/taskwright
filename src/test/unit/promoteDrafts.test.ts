import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
import { promoteDrafts, PromoteDraftsError } from '../../core/promoteDrafts';

let root: string, backlogPath: string;
function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-promote-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
}
function deps() {
  return {
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    treeFieldService: new TreeFieldService(),
  };
}
function writeDraft(id: string, title: string, deps_: string[] = []): void {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  fs.writeFileSync(
    path.join(backlogPath, 'drafts', `${id.toLowerCase()} - ${title}.md`),
    `---\nid: ${id}\ntitle: ${title}\nstatus: Draft\nassignee: []\n${depBlock}---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}
function writeTask(id: string, title: string, deps_: string[] = [], extra = ''): void {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  fs.writeFileSync(
    path.join(backlogPath, 'tasks', `${id.toLowerCase()} - ${title}.md`),
    `---\nid: ${id}\ntitle: ${title}\nstatus: To Do\nassignee: []\n${depBlock}${extra}---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
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
beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('promoteDrafts', () => {
  it('promotes a single draft and returns its {from,to} mapping', async () => {
    writeDraft('DRAFT-1', 'Solo');
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    expect(res.promoted).toEqual([{ from: 'DRAFT-1', to: 'TASK-1' }]);
    expect(read('TASK-1')).toMatch(/^status:\s*To Do/m);
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-1 - Solo.md'))).toBe(false);
  });

  it('rewrites an inbound task dependency that pointed at the promoted draft', async () => {
    writeDraft('DRAFT-1', 'Dep');
    writeTask('TASK-9', 'Dependent', ['DRAFT-1']);
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    const to = res.promoted[0].to; // TASK-10 (getNextTaskId is fs-based; tasks/ already holds task-9)
    expect(read('TASK-9')).toMatch(new RegExp(`- ${to}\\b`));
    expect(read('TASK-9')).not.toMatch(/DRAFT-1/);
    expect(res.remapped).toContain('TASK-9');
  });

  it('bulk promote of a linked pair rewires the intra-set edge (topo: dep first)', async () => {
    writeDraft('DRAFT-1', 'Base');
    writeDraft('DRAFT-2', 'Uses-base', ['DRAFT-1']); // DRAFT-2 depends on DRAFT-1
    const res = await promoteDrafts(deps(), ['DRAFT-2', 'DRAFT-1']); // request out of order
    const map = new Map(res.promoted.map((p) => [p.from, p.to]));
    // DRAFT-1 promoted first (dep-first topo) → lower id:
    expect(map.get('DRAFT-1')).toBe('TASK-1');
    expect(map.get('DRAFT-2')).toBe('TASK-2');
    // the promoted TASK-2 file now depends on TASK-1, not DRAFT-1:
    expect(read('TASK-2')).toMatch(/- TASK-1\b/);
    expect(read('TASK-2')).not.toMatch(/DRAFT-1/);
  });

  it('re-points a bug caused_by that referenced a promoted draft', async () => {
    writeDraft('DRAFT-1', 'Cause');
    writeTask('TASK-9', 'Regression', [], 'type: bug\ncaused_by: DRAFT-1\n');
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    const to = res.promoted[0].to;
    expect(read('TASK-9')).toMatch(new RegExp(`^caused_by:\\s*${to}\\b`, 'm'));
    expect(res.remapped).toContain('TASK-9');
  });

  it('rejects a non-draft id before writing anything', async () => {
    writeTask('TASK-9', 'Real');
    await expect(promoteDrafts(deps(), ['TASK-9'])).rejects.toThrow(/not a draft/);
  });

  it('on mid-set failure throws PromoteDraftsError carrying the partial mapping', async () => {
    writeDraft('DRAFT-1', 'Ok');
    // Simulate a mid-set failure by stubbing writer.promoteDraft to throw on the 2nd call
    // (the 1st call runs the real implementation).
    writeDraft('DRAFT-2', 'Boom');
    const d = deps();
    const spy = vi.spyOn(d.writer, 'promoteDraft');
    spy
      .mockImplementationOnce(async (id, parser) =>
        BacklogWriter.prototype.promoteDraft.call(d.writer, id, parser)
      )
      .mockImplementationOnce(async () => {
        throw new Error('disk full');
      });
    // ONE call only: capture the error and assert it carries the partial mapping.
    // (Do NOT call promoteDrafts a second time — DRAFT-1 is already promoted, so a
    // second call fails up-front validation with a plain Error, proving nothing.)
    const e = await promoteDrafts(d, ['DRAFT-1', 'DRAFT-2']).catch((x) => x);
    expect(e).toBeInstanceOf(PromoteDraftsError);
    expect(e.promoted).toEqual([{ from: 'DRAFT-1', to: 'TASK-1' }]);
  });
});
