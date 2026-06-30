import { describe, it, expect } from 'vitest';
import { applyClaim, clearClaim, isClaimStale } from '../../core/claims';
import { BacklogParser } from '../../core/BacklogParser';

const parser = new BacklogParser('/fake/path');

const BASE = `---
id: TASK-1
title: Sample task
status: To Do
assignee: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Body stays intact.
<!-- SECTION:DESCRIPTION:END -->
`;

describe('claims', () => {
  describe('applyClaim', () => {
    it('writes claim fields that the parser reads back', () => {
      const out = applyClaim(BASE, {
        claimedBy: '@alice',
        worktree: 'feature/login',
        claimedAt: '2026-06-30 14:05',
      });
      const task = parser.parseTaskContent(out, '/fake/path/task-1.md');
      expect(task?.claimedBy).toBe('@alice');
      expect(task?.worktree).toBe('feature/login');
      expect(task?.claimedAt).toBe('2026-06-30 14:05');
    });

    it('preserves the task body and existing frontmatter', () => {
      const out = applyClaim(BASE, { claimedBy: '@alice', claimedAt: '2026-06-30 14:05' });
      expect(out).toContain('Body stays intact.');
      const task = parser.parseTaskContent(out, '/fake/path/task-1.md');
      expect(task?.title).toBe('Sample task');
      expect(task?.status).toBe('To Do');
    });

    it('replaces an existing claim instead of duplicating it', () => {
      const once = applyClaim(BASE, { claimedBy: '@alice', claimedAt: '2026-06-30 14:05' });
      const twice = applyClaim(once, { claimedBy: '@bob', claimedAt: '2026-06-30 15:00' });
      const task = parser.parseTaskContent(twice, '/fake/path/task-1.md');
      expect(task?.claimedBy).toBe('@bob');
      expect((twice.match(/claimed_by:/g) ?? []).length).toBe(1);
    });

    it('omits the worktree line when no worktree is given', () => {
      const out = applyClaim(BASE, { claimedBy: '@alice', claimedAt: '2026-06-30 14:05' });
      expect(out).not.toContain('worktree:');
      const task = parser.parseTaskContent(out, '/fake/path/task-1.md');
      expect(task?.worktree).toBeUndefined();
    });
  });

  describe('clearClaim', () => {
    it('removes claim fields so the parser sees no claim', () => {
      const claimed = applyClaim(BASE, {
        claimedBy: '@alice',
        worktree: 'wt',
        claimedAt: '2026-06-30 14:05',
      });
      const cleared = clearClaim(claimed);
      const task = parser.parseTaskContent(cleared, '/fake/path/task-1.md');
      expect(task?.claimedBy).toBeUndefined();
      expect(task?.worktree).toBeUndefined();
      expect(task?.claimedAt).toBeUndefined();
    });

    it('is a no-op on an unclaimed task', () => {
      expect(clearClaim(BASE)).toBe(BASE);
    });
  });

  describe('isClaimStale', () => {
    // Construct instants in LOCAL time so the test is timezone-independent
    // (isClaimStale parses the bare 'YYYY-MM-DD HH:mm' string as local time).
    const ONE_HOUR = 60 * 60 * 1000;
    const claimedAt = '2026-06-30 14:00';

    it('treats an absent claim as not stale', () => {
      const now = new Date(2026, 5, 30, 16, 0).getTime();
      expect(isClaimStale(undefined, ONE_HOUR, now)).toBe(false);
    });

    it('treats a recent claim as not stale', () => {
      const now = new Date(2026, 5, 30, 14, 30).getTime();
      expect(isClaimStale(claimedAt, ONE_HOUR, now)).toBe(false);
    });

    it('treats a claim older than the max age as stale', () => {
      const now = new Date(2026, 5, 30, 16, 0).getTime();
      expect(isClaimStale(claimedAt, ONE_HOUR, now)).toBe(true);
    });
  });
});
