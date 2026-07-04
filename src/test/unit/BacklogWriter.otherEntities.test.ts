import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BacklogWriter,
  computeContentHash,
  FileConflictError,
  detectCRLF,
  normalizeToLF,
  restoreLineEndings,
} from '../../core/BacklogWriter';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { toPosix, posixPath } from '../helpers/paths';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Helper to mock readdirSync with string array (simulating withFileTypes: false)
function mockReaddirSync(files: string[]) {
  vi.mocked(fs.readdirSync).mockReturnValue(files as unknown as ReturnType<typeof fs.readdirSync>);
}

describe('BacklogWriter', () => {
  let writer: BacklogWriter;
  let mockParser: BacklogParser;

  beforeEach(() => {
    writer = new BacklogWriter();
    mockParser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Conflict Detection', () => {
    describe('computeContentHash', () => {
      it('should return consistent hash for same content', () => {
        const content = 'test content';
        const hash1 = computeContentHash(content);
        const hash2 = computeContentHash(content);
        expect(hash1).toBe(hash2);
      });

      it('should return different hash for different content', () => {
        const hash1 = computeContentHash('content A');
        const hash2 = computeContentHash('content B');
        expect(hash1).not.toBe(hash2);
      });

      it('should return valid MD5 hash format', () => {
        const hash = computeContentHash('test');
        expect(hash).toMatch(/^[a-f0-9]{32}$/);
      });

      it('should handle empty content', () => {
        const hash = computeContentHash('');
        expect(hash).toMatch(/^[a-f0-9]{32}$/);
      });

      it('should handle unicode content', () => {
        const hash = computeContentHash('Hello World');
        expect(hash).toMatch(/^[a-f0-9]{32}$/);
      });
    });

    describe('updateTask with expectedHash', () => {
      it('should succeed when hash matches', async () => {
        const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
        vi.mocked(fs.readFileSync).mockReturnValue(content);
        mockReaddirSync(['task-1.md']);

        const expectedHash = computeContentHash(content);
        await writer.updateTask('TASK-1', { status: 'Done' }, mockParser, expectedHash);

        expect(fs.writeFileSync).toHaveBeenCalled();
      });

      it('should throw FileConflictError when hash does not match', async () => {
        const originalContent = `---
id: TASK-1
title: Test
status: To Do
---
`;
        const modifiedContent = `---
id: TASK-1
title: Test Modified Externally
status: To Do
---
`;
        vi.mocked(fs.readFileSync).mockReturnValue(modifiedContent);
        mockReaddirSync(['task-1.md']);

        const originalHash = computeContentHash(originalContent);

        await expect(
          writer.updateTask('TASK-1', { status: 'Done' }, mockParser, originalHash)
        ).rejects.toThrow(FileConflictError);
      });

      it('should include current content in FileConflictError', async () => {
        const originalContent = `---
id: TASK-1
title: Original
status: To Do
---
`;
        const modifiedContent = `---
id: TASK-1
title: Modified
status: To Do
---
`;
        vi.mocked(fs.readFileSync).mockReturnValue(modifiedContent);
        mockReaddirSync(['task-1.md']);

        const originalHash = computeContentHash(originalContent);

        try {
          await writer.updateTask('TASK-1', { status: 'Done' }, mockParser, originalHash);
          expect.fail('Should have thrown FileConflictError');
        } catch (error) {
          expect(error).toBeInstanceOf(FileConflictError);
          expect((error as FileConflictError).currentContent).toBe(modifiedContent);
          expect((error as FileConflictError).code).toBe('CONFLICT');
        }
      });

      it('should skip conflict check when expectedHash is not provided', async () => {
        const content = `---
id: TASK-1
title: Test
status: To Do
---
`;
        vi.mocked(fs.readFileSync).mockReturnValue(content);
        mockReaddirSync(['task-1.md']);

        // No expectedHash provided - should succeed regardless
        await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

        expect(fs.writeFileSync).toHaveBeenCalled();
      });

      it('should detect conflict for whitespace-only changes', async () => {
        const originalContent = `---
id: TASK-1
title: Test
status: To Do
---
`;
        // Added extra newline at the end - this is a real difference
        const modifiedContent = `---
id: TASK-1
title: Test
status: To Do
---

`;
        vi.mocked(fs.readFileSync).mockReturnValue(modifiedContent);
        mockReaddirSync(['task-1.md']);

        const originalHash = computeContentHash(originalContent);

        await expect(
          writer.updateTask('TASK-1', { status: 'Done' }, mockParser, originalHash)
        ).rejects.toThrow(FileConflictError);
      });
    });
  });
  describe('createSubtask', () => {
    it('should create subtask with dot-notation ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createSubtask('TASK-2', '/fake/backlog', mockParser);

      expect(result.id).toBe('TASK-2.1');
      expect(result.filePath).toContain('task-2.1 - Untitled.md');
      expect(fs.writeFileSync).toHaveBeenCalled();

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.id).toBe('TASK-2.1');
      expect(frontmatter.title).toBe('Untitled');
      expect(frontmatter.status).toBe('To Do');
      expect(frontmatter.parent_task_id).toBe('TASK-2');
    });

    it('should find next sub-number with existing subtasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['task-2 - Parent.md', 'task-2.1 - First-Sub.md', 'task-2.3 - Third-Sub.md']);

      const result = await writer.createSubtask('TASK-2', '/fake/backlog', mockParser);

      // Should be 2.4 (next after max existing = 3), not 2.2 (filling gap)
      expect(result.id).toBe('TASK-2.4');
      expect(result.filePath).toContain('task-2.4 - Untitled.md');
    });

    it('should handle parent IDs with large numbers', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createSubtask('TASK-100', '/fake/backlog', mockParser);

      expect(result.id).toBe('TASK-100.1');
      expect(result.filePath).toContain('task-100.1 - Untitled.md');
    });

    it('should create tasks directory if missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockReaddirSync([]);

      await writer.createSubtask('TASK-1', '/fake/backlog', mockParser);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('tasks'),
        expect.objectContaining({ recursive: true })
      );
    });

    it('should throw error if parent ID has no numeric part', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      await expect(writer.createSubtask('INVALID', '/fake/backlog', mockParser)).rejects.toThrow(
        'Cannot extract numeric ID'
      );
    });

    it('should use correct prefix from parent ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createSubtask('ISSUE-5', '/fake/backlog', mockParser);

      expect(result.id).toBe('ISSUE-5.1');
    });
  });
  describe('createMilestone', () => {
    it('creates first milestone with m-0 id when none exist', async () => {
      const result = await writer.createMilestone('/fake/backlog', 'Launch');

      expect(result).toEqual({
        id: 'm-0',
        name: 'Launch',
        description: 'Milestone: Launch',
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('id: m-0'),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.any(String),
        posixPath('/fake/backlog/milestones/m-0 - launch.md')
      );
    });

    it('scans active and archived milestones and uses max id + 1', async () => {
      vi.mocked(fs.readdirSync).mockImplementation((dirPath) => {
        const dir = toPosix(String(dirPath));
        if (dir.endsWith('/fake/backlog/milestones')) {
          return ['m-2 - one.md'] as unknown as ReturnType<typeof fs.readdirSync>;
        }
        if (dir.endsWith('/fake/backlog/archive/milestones')) {
          return ['m-7 - two.md'] as unknown as ReturnType<typeof fs.readdirSync>;
        }
        return [] as unknown as ReturnType<typeof fs.readdirSync>;
      });

      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const file = toPosix(String(filePath));
        if (file.endsWith('/fake/backlog/milestones/m-2 - one.md')) {
          return '---\nid: m-2\ntitle: "One"\n---\n';
        }
        if (file.endsWith('/fake/backlog/archive/milestones/m-7 - two.md')) {
          return '---\nid: m-10\ntitle: "Two"\n---\n';
        }
        return '';
      });

      const result = await writer.createMilestone('/fake/backlog', 'Release');

      expect(result.id).toBe('m-11');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('id: m-11'),
        'utf-8'
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.any(String),
        posixPath('/fake/backlog/milestones/m-11 - release.md')
      );
    });

    it('rejects milestone aliases that would duplicate existing IDs', async () => {
      const parserWithMilestones = {
        getMilestones: vi.fn().mockResolvedValue([{ id: 'm-1', name: 'Launch' }]),
      } as unknown as BacklogParser;

      await expect(
        writer.createMilestone('/fake/backlog', '1', undefined, parserWithMilestones)
      ).rejects.toThrow('A milestone with this title or ID already exists');
    });
  });
  describe('line ending preservation', () => {
    it('detectCRLF should detect CRLF line endings', () => {
      expect(detectCRLF('line1\r\nline2')).toBe(true);
      expect(detectCRLF('line1\nline2')).toBe(false);
      expect(detectCRLF('')).toBe(false);
    });

    it('normalizeToLF should convert CRLF to LF', () => {
      expect(normalizeToLF('line1\r\nline2\r\n')).toBe('line1\nline2\n');
      expect(normalizeToLF('line1\nline2\n')).toBe('line1\nline2\n');
    });

    it('restoreLineEndings should restore CRLF when useCRLF is true', () => {
      expect(restoreLineEndings('line1\nline2\n', true)).toBe('line1\r\nline2\r\n');
      expect(restoreLineEndings('line1\nline2\n', false)).toBe('line1\nline2\n');
    });

    it('should preserve CRLF line endings when updating tasks', async () => {
      const content =
        '---\r\nid: TASK-1\r\ntitle: Test\r\nstatus: To Do\r\n---\r\n\r\n## Description\r\nHello\r\n';
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('\r\n');
      expect(writtenContent).toContain('status: Done');
    });

    it('should preserve LF line endings when updating tasks', async () => {
      const content = '---\nid: TASK-1\ntitle: Test\nstatus: To Do\n---\n\n## Description\nHello\n';
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      mockReaddirSync(['task-1.md']);

      await writer.updateTask('TASK-1', { status: 'Done' }, mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('\r\n');
      expect(writtenContent).toContain('status: Done');
    });
  });
  describe('document CRUD', () => {
    it('should create a new document', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      const result = await writer.createDocument('/fake/backlog', 'API Reference', {
        type: 'guide',
        tags: ['api'],
      });

      expect(result.id).toBe('DOC-001');
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('title: API Reference');
      expect(writtenContent).toContain('type: guide');
    });

    it('should delete a document', async () => {
      vi.spyOn(mockParser, 'getDocument').mockResolvedValue({
        id: 'DOC-001',
        title: 'Test',
        tags: [],
        content: 'Content',
        filePath: '/fake/backlog/docs/doc-001 - Test.md',
      });

      await writer.deleteDocument('DOC-001', mockParser);

      expect(fs.unlinkSync).toHaveBeenCalledWith('/fake/backlog/docs/doc-001 - Test.md');
    });
  });
  describe('decision CRUD', () => {
    it('should create a new decision', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      const result = await writer.createDecision('/fake/backlog', 'Use React', {
        status: 'proposed',
        context: 'We need a UI framework',
      });

      expect(result.id).toBe('DECISION-001');
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('title: Use React');
      expect(writtenContent).toContain('status: proposed');
      expect(writtenContent).toContain('## Context');
      expect(writtenContent).toContain('We need a UI framework');
      expect(writtenContent).toContain('## Decision');
      expect(writtenContent).toContain('## Consequences');
      expect(writtenContent).toContain('## Alternatives');
    });

    it('should delete a decision', async () => {
      vi.spyOn(mockParser, 'getDecision').mockResolvedValue({
        id: 'DECISION-001',
        title: 'Test',
        filePath: '/fake/backlog/decisions/decision-001 - Test.md',
      });

      await writer.deleteDecision('DECISION-001', mockParser);

      expect(fs.unlinkSync).toHaveBeenCalledWith('/fake/backlog/decisions/decision-001 - Test.md');
    });
  });
  describe('milestone lifecycle', () => {
    it('should archive a milestone', async () => {
      // Mock getMilestones to return a milestone
      vi.spyOn(mockParser, 'getMilestones').mockResolvedValue([{ id: 'm-1', name: 'v1.0' }]);
      vi.spyOn(mockParser, 'getBacklogPath').mockReturnValue('/fake/backlog');
      vi.mocked(fs.readdirSync).mockReturnValue(['m-1 - v1.0.md'] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await writer.archiveMilestone('m-1', mockParser);

      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('should delete a milestone', async () => {
      vi.spyOn(mockParser, 'getMilestones').mockResolvedValue([{ id: 'm-1', name: 'v1.0' }]);
      vi.spyOn(mockParser, 'getBacklogPath').mockReturnValue('/fake/backlog');
      vi.mocked(fs.readdirSync).mockReturnValue(['m-1 - v1.0.md'] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await writer.deleteMilestone('m-1', mockParser);

      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });
  describe('cross-branch ID collision prevention', () => {
    it('should skip IDs already used on other branches', async () => {
      mockReaddirSync(['task-1 - First.md', 'task-2 - Second.md']);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const result = await writer.createTask(
        '/fake/backlog',
        { title: 'New Task' },
        undefined,
        ['TASK-3', 'TASK-5'] // cross-branch IDs
      );

      // Should skip TASK-1, TASK-2 (local), TASK-3, TASK-5 (cross-branch) â†’ TASK-6
      expect(result.id).toBe('TASK-6');
    });
  });
});
