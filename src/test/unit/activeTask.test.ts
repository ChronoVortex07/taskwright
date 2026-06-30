import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  readActiveTask,
  writeActiveTask,
  clearActiveTask,
  activeTaskPath,
} from '../../core/activeTask';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const ROOT = '/repo';

describe('activeTask store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('readActiveTask', () => {
    it('returns undefined when the file is missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(readActiveTask(ROOT)).toBeUndefined();
    });

    it('returns undefined on malformed JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{not json');
      expect(readActiveTask(ROOT)).toBeUndefined();
    });

    it('returns undefined when taskId is missing or blank', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ setAt: 'x' }));
      expect(readActiveTask(ROOT)).toBeUndefined();
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ taskId: '   ' }));
      expect(readActiveTask(ROOT)).toBeUndefined();
    });

    it('parses a valid active-task file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ taskId: 'TASK-7', setAt: '2026-06-30T14:00:00.000Z' })
      );
      expect(readActiveTask(ROOT)).toEqual({
        taskId: 'TASK-7',
        setAt: '2026-06-30T14:00:00.000Z',
      });
    });
  });

  describe('writeActiveTask', () => {
    it('creates the .taskwright dir and writes the task id + timestamp', () => {
      const now = new Date('2026-06-30T14:00:00.000Z');
      const result = writeActiveTask(ROOT, 'TASK-7', now);

      expect(result).toEqual({ taskId: 'TASK-7', setAt: '2026-06-30T14:00:00.000Z' });
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.taskwright') as unknown as string,
        { recursive: true }
      );
      const [writtenPath, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(writtenPath).toBe(activeTaskPath(ROOT));
      const parsed = JSON.parse(contents as string);
      expect(parsed.taskId).toBe('TASK-7');
      expect(parsed.setAt).toBe('2026-06-30T14:00:00.000Z');
    });
  });

  describe('clearActiveTask', () => {
    it('removes the active-task file', () => {
      clearActiveTask(ROOT);
      expect(fs.unlinkSync).toHaveBeenCalledWith(activeTaskPath(ROOT));
    });

    it('is a no-op when the file is already absent', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(() => clearActiveTask(ROOT)).not.toThrow();
    });
  });
});
