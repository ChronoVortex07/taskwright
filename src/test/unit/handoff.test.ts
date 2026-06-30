import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handoffPath, writeHandoff } from '../../core/handoff';

describe('handoffPath', () => {
  it('places handoff files under <root>/.taskwright/handoff/<id>.md', () => {
    const p = handoffPath('/repo', 'TASK-7');
    expect(p.replace(/\\/g, '/')).toBe('/repo/.taskwright/handoff/TASK-7.md');
  });
});

describe('writeHandoff', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-handoff-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the handoff directory and writes the prompt', () => {
    const written = writeHandoff(root, 'TASK-7', 'paste me');
    expect(fs.readFileSync(written, 'utf-8')).toBe('paste me\n');
    expect(written).toBe(handoffPath(root, 'TASK-7'));
  });

  it('overwrites a stale handoff for the same task', () => {
    writeHandoff(root, 'TASK-7', 'old');
    writeHandoff(root, 'TASK-7', 'new');
    expect(fs.readFileSync(handoffPath(root, 'TASK-7'), 'utf-8')).toBe('new\n');
  });
});
