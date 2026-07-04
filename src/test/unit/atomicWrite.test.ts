import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../../core/atomicWrite';

describe('atomicWriteFileSync', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-atomic-write-'));
    dirs.push(dir);
    return dir;
  }

  it('creates a new file with the given content', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'task-1.md');

    atomicWriteFileSync(filePath, 'hello world');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('overwrites an existing file with the new content only', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'task-1.md');
    fs.writeFileSync(filePath, 'old content', 'utf-8');

    atomicWriteFileSync(filePath, 'new content');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('leaves no temp file behind after a successful write', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'task-1.md');

    atomicWriteFileSync(filePath, 'content');

    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['task-1.md']);
  });

  it('uses a unique temp name so concurrent writers to the same destination do not collide', () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'task-1.md');

    atomicWriteFileSync(filePath, 'first');
    atomicWriteFileSync(filePath, 'second');

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('second');
    expect(fs.readdirSync(dir)).toEqual(['task-1.md']);
  });
});
