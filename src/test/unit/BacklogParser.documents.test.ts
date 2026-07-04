import { describe, it, expect, vi, afterEach } from 'vitest';
import { BacklogParser } from '../../core/BacklogParser';

import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
  };
});

describe('BacklogParser', () => {
  describe('parseDocumentContent', () => {
    it('should parse a document with YAML frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: DOC-1
title: API Reference
type: guide
tags: [api, reference]
created_date: 2024-01-15
updated_date: 2024-02-01
---

# API Reference

Some documentation content here.
`;
      const doc = parser.parseDocumentContent(content, '/fake/path/docs/doc-1 - API-Reference.md');
      expect(doc).toBeDefined();
      expect(doc?.id).toBe('DOC-1');
      expect(doc?.title).toBe('API Reference');
      expect(doc?.type).toBe('guide');
      expect(doc?.tags).toEqual(['api', 'reference']);
      expect(doc?.createdAt).toBe('2024-01-15');
      expect(doc?.updatedAt).toBe('2024-02-01');
      expect(doc?.content).toContain('# API Reference');
      expect(doc?.content).toContain('Some documentation content here.');
    });

    it('should extract ID from filename if not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Setup Guide
---

# Setup Guide
`;
      const doc = parser.parseDocumentContent(content, '/fake/docs/doc-5 - Setup-Guide.md');
      expect(doc?.id).toBe('DOC-5');
    });

    it('should extract title from first heading if not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `# My Document Title

Some content here.
`;
      const doc = parser.parseDocumentContent(content, '/fake/docs/doc-1 - Title.md');
      expect(doc?.title).toBe('My Document Title');
    });

    it('should fall back to filename-based title', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `Some content without any heading or frontmatter title.
`;
      const doc = parser.parseDocumentContent(content, '/fake/docs/doc-1 - My-Doc-Title.md');
      expect(doc?.title).toBe('My Doc Title');
    });

    it('should handle empty tags', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: No Tags Doc
tags: []
---
`;
      const doc = parser.parseDocumentContent(content, '/fake/docs/doc-1.md');
      expect(doc?.tags).toEqual([]);
    });

    it('should handle document with no frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `# Quick Start

Get started in 5 minutes.
`;
      const doc = parser.parseDocumentContent(content, '/fake/docs/doc-2 - Quick-Start.md');
      expect(doc?.title).toBe('Quick Start');
      expect(doc?.content).toContain('# Quick Start');
    });

    it('should handle empty content gracefully', () => {
      const parser = new BacklogParser('/fake/path');
      const doc = parser.parseDocumentContent('', '/fake/docs/doc-1 - Title.md');
      // Falls back to filename-based title which is truthy
      expect(doc).toBeDefined();
      expect(doc?.title).toBe('Title');
      expect(doc?.content).toBe('');
    });
  });

  describe('parseDecisionContent', () => {
    it('should parse a decision with YAML frontmatter and sections', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
id: DECISION-1
title: Use React for Frontend
date: 2024-01-15
status: accepted
---

## Context

We need a frontend framework.

## Decision

We will use React.

## Consequences

Team needs React training.

## Alternatives

Vue.js was also considered.
`;
      const decision = parser.parseDecisionContent(
        content,
        '/fake/decisions/decision-1 - Use-React.md'
      );
      expect(decision).toBeDefined();
      expect(decision?.id).toBe('DECISION-1');
      expect(decision?.title).toBe('Use React for Frontend');
      expect(decision?.date).toBe('2024-01-15');
      expect(decision?.status).toBe('accepted');
      expect(decision?.context).toBe('We need a frontend framework.');
      expect(decision?.decision).toBe('We will use React.');
      expect(decision?.consequences).toBe('Team needs React training.');
      expect(decision?.alternatives).toBe('Vue.js was also considered.');
    });

    it('should extract ID from filename if not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Use PostgreSQL
status: proposed
---
`;
      const decision = parser.parseDecisionContent(
        content,
        '/fake/decisions/decision-3 - Use-PostgreSQL.md'
      );
      expect(decision?.id).toBe('DECISION-3');
    });

    it('should parse all decision statuses', () => {
      const parser = new BacklogParser('/fake/path');
      const statuses = ['proposed', 'accepted', 'rejected', 'superseded'];

      for (const status of statuses) {
        const content = `---
title: Test Decision
status: ${status}
---
`;
        const decision = parser.parseDecisionContent(content, '/fake/decisions/decision-1.md');
        expect(decision?.status).toBe(status);
      }
    });

    it('should handle decision with no sections', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `---
title: Minimal Decision
status: proposed
---
`;
      const decision = parser.parseDecisionContent(content, '/fake/decisions/decision-1.md');
      expect(decision?.title).toBe('Minimal Decision');
      expect(decision?.context).toBeUndefined();
      expect(decision?.decision).toBeUndefined();
      expect(decision?.consequences).toBeUndefined();
      expect(decision?.alternatives).toBeUndefined();
    });

    it('should extract title from heading if not in frontmatter', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `# Use TypeScript

## Context

We need type safety.
`;
      const decision = parser.parseDecisionContent(
        content,
        '/fake/decisions/decision-2 - Use-TypeScript.md'
      );
      expect(decision?.title).toBe('Use TypeScript');
      expect(decision?.context).toBe('We need type safety.');
    });

    it('should fall back to filename-based title', () => {
      const parser = new BacklogParser('/fake/path');
      const content = `## Context

Some context.
`;
      const decision = parser.parseDecisionContent(
        content,
        '/fake/decisions/decision-1 - Use-Docker.md'
      );
      expect(decision?.title).toBe('Use Docker');
    });

    it('should sort decisions by ID number', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'decision-3 - Third.md',
        'decision-1 - First.md',
        'decision-2 - Second.md',
      ]);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('decision-1')) return `---\ntitle: First\nstatus: accepted\n---\n`;
        if (p.includes('decision-2')) return `---\ntitle: Second\nstatus: proposed\n---\n`;
        return `---\ntitle: Third\nstatus: rejected\n---\n`;
      });

      const parser = new BacklogParser('/fake/backlog');
      const decisions = await parser.getDecisions();

      expect(decisions).toHaveLength(3);
      expect(decisions[0].title).toBe('First');
      expect(decisions[1].title).toBe('Second');
      expect(decisions[2].title).toBe('Third');
    });

    it('should return empty array when decisions folder does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const decisions = await parser.getDecisions();
      expect(decisions).toEqual([]);
    });
  });

  describe('getDocuments', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should return empty array when docs folder does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const parser = new BacklogParser('/fake/backlog');
      const docs = await parser.getDocuments();
      expect(docs).toEqual([]);
    });

    it('should sort documents by title', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((dirPath: string) => {
        if (String(dirPath).endsWith('docs')) {
          return [
            { name: 'doc-2 - Zebra.md', isDirectory: () => false },
            { name: 'doc-1 - Alpha.md', isDirectory: () => false },
          ];
        }
        return [];
      });
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('doc-1')) return `---\ntitle: Alpha Guide\n---\nContent A`;
        return `---\ntitle: Zebra Guide\n---\nContent Z`;
      });

      const parser = new BacklogParser('/fake/backlog');
      const docs = await parser.getDocuments();

      expect(docs).toHaveLength(2);
      expect(docs[0].title).toBe('Alpha Guide');
      expect(docs[1].title).toBe('Zebra Guide');
    });

    it('should skip malformed document files', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation((dirPath: string) => {
        if (String(dirPath).endsWith('docs')) {
          return [
            { name: 'doc-1 - Good.md', isDirectory: () => false },
            { name: 'not-a-doc.txt', isDirectory: () => false },
          ];
        }
        return [];
      });
      vi.mocked(fs.readFileSync).mockReturnValue(`---\ntitle: Good Document\n---\nContent`);

      const parser = new BacklogParser('/fake/backlog');
      const docs = await parser.getDocuments();

      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe('Good Document');
    });
  });

  describe('getDocument', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should find a document by ID', async () => {
      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'getDocuments').mockResolvedValue([
        {
          id: 'DOC-1',
          title: 'Test Doc',
          tags: [],
          content: 'content',
          filePath: '/fake/backlog/docs/doc-1.md',
        },
      ]);

      const doc = await parser.getDocument('DOC-1');
      expect(doc?.id).toBe('DOC-1');
    });

    it('should return undefined for non-existent document', async () => {
      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'getDocuments').mockResolvedValue([]);

      const doc = await parser.getDocument('DOC-999');
      expect(doc).toBeUndefined();
    });
  });

  describe('getDecision', () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should find a decision by ID', async () => {
      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'getDecisions').mockResolvedValue([
        {
          id: 'DECISION-1',
          title: 'Test Decision',
          status: 'accepted',
          filePath: '/fake/backlog/decisions/decision-1.md',
        },
      ]);

      const decision = await parser.getDecision('DECISION-1');
      expect(decision?.id).toBe('DECISION-1');
    });

    it('should return undefined for non-existent decision', async () => {
      const parser = new BacklogParser('/fake/backlog');
      vi.spyOn(parser, 'getDecisions').mockResolvedValue([]);

      const decision = await parser.getDecision('DECISION-999');
      expect(decision).toBeUndefined();
    });
  });
});
