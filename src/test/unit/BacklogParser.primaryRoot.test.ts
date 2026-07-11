import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';

/**
 * git-auto split-root behavior (TASK-91): the parser's backlogPath may live in
 * the hidden board worktree while config.yml + docs/ + decisions/ stay in the
 * repo backlog/. `getPrimaryRoot()` replaces every
 * `path.dirname(getBacklogPath())` repo-root derivation.
 */
describe('BacklogParser primary root + content root', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it('getPrimaryRoot falls back to dirname(backlogPath) (v2 shape)', () => {
    const parser = new BacklogParser(path.join('/repo', 'backlog'));
    expect(parser.getPrimaryRoot()).toBe(path.join('/repo'));
  });

  it('getPrimaryRoot honors the constructor override', () => {
    const parser = new BacklogParser(
      path.join('/repo', '.taskwright', 'board', 'backlog'),
      undefined,
      undefined,
      '/repo'
    );
    expect(parser.getPrimaryRoot()).toBe('/repo');
  });

  it('reads docs/ and decisions/ from the config root when it differs from backlogPath', async () => {
    const primary = tmpDir('taskwright-parser-primary-');
    const configRoot = path.join(primary, 'backlog');
    const stateRoot = path.join(primary, '.taskwright', 'board', 'backlog');
    fs.mkdirSync(path.join(configRoot, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(configRoot, 'decisions'), { recursive: true });
    fs.mkdirSync(path.join(stateRoot, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'config.yml'), "project_name: 'X'\n");
    fs.writeFileSync(
      path.join(configRoot, 'docs', 'doc-1 - Guide.md'),
      '---\nid: DOC-1\ntitle: Guide\n---\n\n# Guide\n'
    );
    fs.writeFileSync(
      path.join(configRoot, 'decisions', 'decision-1 - Choice.md'),
      '---\nid: DECISION-1\ntitle: Choice\ndate: 2026-01-01\nstatus: accepted\n---\n\n## Decision\nYes.\n'
    );

    const parser = new BacklogParser(
      stateRoot,
      path.join(configRoot, 'config.yml'),
      undefined,
      primary
    );

    expect((await parser.getDocuments()).map((d) => d.id)).toEqual(['DOC-1']);
    expect((await parser.getDecisions()).map((d) => d.id)).toEqual(['DECISION-1']);
  });
});
