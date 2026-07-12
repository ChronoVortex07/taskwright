import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogWriter } from '../../core/BacklogWriter';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { posixPath } from '../helpers/paths';

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

  describe('promoteDraft with config defaults', () => {
    it('should use default_status from config when promoting', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockParserWithConfig = {
        getTask: vi.fn().mockResolvedValue({
          id: 'DRAFT-1',
          title: 'My Draft',
          status: 'Draft',
          folder: 'drafts',
          filePath: '/fake/backlog/drafts/draft-1 - My-Draft.md',
          description: '',
          labels: [],
          assignee: [],
          dependencies: [],
          acceptanceCriteria: [],
          definitionOfDone: [],
        }),
        getConfig: vi.fn().mockResolvedValue({ default_status: 'Backlog' }),
        invalidateTaskCache: vi.fn(),
      } as unknown as BacklogParser;

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

      await writer.promoteDraft('DRAFT-1', mockParserWithConfig);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Backlog');
    });
  });
  describe('promoteDraft', () => {
    it('should move file from drafts/ to tasks/ with new task ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1',
        title: 'My Draft',
        status: 'Draft',
        folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - My-Draft.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

      const result = await writer.promoteDraft('DRAFT-1', mockParser);

      expect(fs.renameSync).toHaveBeenCalledWith(
        posixPath('/fake/backlog/drafts/draft-1 - My-Draft.md'),
        posixPath('/fake/backlog/tasks/task-1 - My-Draft.md')
      );
      expect(result).toBe('TASK-1');
    });

    it('should update status from Draft to To Do and assign new task ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1',
        title: 'My Draft',
        status: 'Draft',
        folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - My-Draft.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

      await writer.promoteDraft('DRAFT-1', mockParser);

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('To Do');
      expect(frontmatter.id).toBe('TASK-1');
    });

    it('preserves a real status on promote (P6/D2d â€” Done draft â†’ Done task)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1',
        title: 'Baseline',
        status: 'Done',
        folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - Baseline.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      } as never);
      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});
      vi.mocked(fs.readFileSync).mockReturnValue(
        '---\nid: DRAFT-1\ntitle: Baseline\nstatus: Done\n---\n'
      );
      await writer.promoteDraft('DRAFT-1', mockParser);
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const frontmatter = yaml.load(writtenContent.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<
        string,
        unknown
      >;
      expect(frontmatter.status).toBe('Done');
      expect(frontmatter.id).toBe('TASK-1');
    });

    it('should throw error when task not found', async () => {
      vi.spyOn(mockParser, 'getTask').mockResolvedValue(undefined);

      await expect(writer.promoteDraft('DRAFT-999', mockParser)).rejects.toThrow(
        'Task DRAFT-999 not found'
      );
    });

    it('should create tasks directory if it does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockReaddirSync([]);

      vi.spyOn(mockParser, 'getTask').mockResolvedValue({
        id: 'DRAFT-1',
        title: 'My Draft',
        status: 'Draft',
        folder: 'drafts',
        filePath: '/fake/backlog/drafts/draft-1 - My-Draft.md',
        description: '',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
      });

      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({});

      vi.mocked(fs.readFileSync).mockReturnValue(`---
id: DRAFT-1
title: My Draft
status: Draft
---
`);

      await writer.promoteDraft('DRAFT-1', mockParser);

      expect(fs.mkdirSync).toHaveBeenCalledWith(posixPath('/fake/backlog/tasks'), {
        recursive: true,
      });
    });
  });
  describe('createDraft', () => {
    it('should create a draft file in drafts/ folder with a stable TASK-N id', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createDraft('/fake/backlog');

      // TASK-115: a draft is TASK-N in drafts/, never DRAFT-N. The FOLDER is the draftness
      // marker; the id is stable for life, so promoting it can never change it.
      expect(result.id).toBe('TASK-1');
      expect(result.filePath).toContain('drafts');
      expect(result.filePath).toContain('task-1 - Untitled.md');
      expect(fs.writeFileSync).toHaveBeenCalled();

      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.id).toBe('TASK-1');
      expect(frontmatter.title).toBe('Untitled');
      expect(frontmatter.status).toBe('To Do');
      // Draftness is NEVER written into the file — no `draft: true` field.
      expect(frontmatter.draft).toBeUndefined();
    });

    it('writes the given status when specified (P6/D2b â€” a Done baseline draft)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      await writer.createDraft('/fake/backlog', undefined, { title: 'Baseline', status: 'Done' });
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Done');
    });

    it('defaults unspecified status to config.default_status via the parser', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);
      vi.spyOn(mockParser, 'getConfig').mockResolvedValue({ default_status: 'Backlog' } as never);
      await writer.createDraft('/fake/backlog', mockParser, { title: 'X' });
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const match = writtenContent.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(match![1]) as Record<string, unknown>;
      expect(frontmatter.status).toBe('Backlog');
    });

    it('should mint the next id from the shared TASK counter', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // The mocked readdir answers for every scanned folder; task-3 is the board-wide max.
      mockReaddirSync(['task-1 - Untitled.md', 'task-3 - Some-Task.md']);

      const result = await writer.createDraft('/fake/backlog');

      expect(result.id).toBe('TASK-4');
      expect(result.filePath).toContain('task-4 - Untitled.md');
    });

    it('ignores a legacy draft-N filename when minting (it is not in the task namespace)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync(['draft-99 - Legacy.md', 'task-2 - Live.md']);

      const result = await writer.createDraft('/fake/backlog');

      // draft-99 carries no task prefix, so it contributes nothing to the counter.
      expect(result.id).toBe('TASK-3');
    });

    it('should return uppercase ID', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockReaddirSync([]);

      const result = await writer.createDraft('/fake/backlog');

      expect(result.id).toBe('TASK-1');
      expect(result.id).toMatch(/^TASK-\d+$/);
    });

    it('should create drafts directory if missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockReaddirSync([]);

      await writer.createDraft('/fake/backlog');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('drafts'),
        expect.objectContaining({ recursive: true })
      );
    });
  });
  describe('demoteTask', () => {
    it('should preserve the task status on demote (P6/D2e)', async () => {
      const taskContent =
        '---\nid: TASK-5\ntitle: Some Task\nstatus: In Progress\n---\n\n## Description\nContent\n';
      vi.mocked(fs.readFileSync).mockReturnValue(taskContent);
      mockReaddirSync(['task-5 - Some-Task.md']);

      const newDraftId = await writer.demoteTask('TASK-5', mockParser);

      expect(newDraftId).toBe('DRAFT-1');
      expect(fs.renameSync).toHaveBeenCalled();
      const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(writtenContent).toContain('id: DRAFT-1');
      expect(writtenContent).toContain('status: In Progress');
    });
  });
});
