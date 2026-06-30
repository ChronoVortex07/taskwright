import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPlanProgress } from '../../core/loadPlanProgress';

describe('loadPlanProgress', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-plan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads and parses a root-relative plan file', () => {
    const rel = 'docs/superpowers/plans/p.md';
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '- [x] one\n- [ ] two\n');

    const loaded = loadPlanProgress(root, rel);
    expect(loaded.exists).toBe(true);
    expect(loaded.progress.total).toBe(2);
    expect(loaded.progress.done).toBe(1);
    expect(loaded.path).toBe(path.join(root, rel));
  });

  it('reports not-exists with empty progress when the file is missing', () => {
    const loaded = loadPlanProgress(root, 'docs/missing.md');
    expect(loaded.exists).toBe(false);
    expect(loaded.progress).toEqual({ total: 0, done: 0, percent: 0, steps: [] });
  });

  it('honors an absolute plan path', () => {
    const abs = path.join(root, 'plan.md');
    fs.writeFileSync(abs, '- [ ] only\n');
    const loaded = loadPlanProgress(root, abs);
    expect(loaded.exists).toBe(true);
    expect(loaded.progress.total).toBe(1);
  });
});
