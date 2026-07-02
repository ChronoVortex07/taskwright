import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveMilestoneFile,
  readReleaseChecklist,
  toggleReleaseChecklist,
} from '../../core/milestoneReleaseChecklist';

const MILESTONE_BODY = `# m-1 - Launch

## Description

Ship it.

## Release Checklist

<!-- RC:BEGIN -->
- [x] #1 Update changelog
- [ ] #2 Smoke test the build
- [ ] #3 Tag the release
<!-- RC:END -->
`;

describe('milestoneReleaseChecklist — fs adapter', () => {
  let backlog: string;
  let dir: string;

  beforeEach(() => {
    backlog = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ms-'));
    dir = path.join(backlog, 'milestones');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'm-1 - Launch.md'), MILESTONE_BODY);
  });

  afterEach(() => {
    fs.rmSync(backlog, { recursive: true, force: true });
  });

  describe('resolveMilestoneFile', () => {
    it('resolves by milestone id ("m-1")', () => {
      expect(resolveMilestoneFile(backlog, 'm-1')).toBe(path.join(dir, 'm-1 - Launch.md'));
    });

    it('resolves by display name (case/space-insensitive slug)', () => {
      expect(resolveMilestoneFile(backlog, 'Launch')).toBe(path.join(dir, 'm-1 - Launch.md'));
    });

    it('returns undefined when the milestone has no file', () => {
      expect(resolveMilestoneFile(backlog, 'm-99')).toBeUndefined();
    });

    it('returns undefined when there is no milestones directory', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ms-empty-'));
      try {
        expect(resolveMilestoneFile(empty, 'm-1')).toBeUndefined();
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('readReleaseChecklist', () => {
    it('reads the RC items from the milestone file', () => {
      expect(readReleaseChecklist(backlog, 'm-1')).toEqual([
        { id: 1, text: 'Update changelog', checked: true },
        { id: 2, text: 'Smoke test the build', checked: false },
        { id: 3, text: 'Tag the release', checked: false },
      ]);
    });

    it('returns [] when the milestone file is missing', () => {
      expect(readReleaseChecklist(backlog, 'm-99')).toEqual([]);
    });
  });

  describe('toggleReleaseChecklist', () => {
    it('flips the targeted item and returns the updated items', () => {
      const items = toggleReleaseChecklist(backlog, 'm-1', 2);
      expect(items[1]).toEqual({ id: 2, text: 'Smoke test the build', checked: true });
      expect(items[0].checked).toBe(true); // #1 untouched
      expect(items[2].checked).toBe(false); // #3 untouched
    });

    it('persists the toggle to the milestone file', () => {
      toggleReleaseChecklist(backlog, 'm-1', 2);
      expect(readReleaseChecklist(backlog, 'm-1')[1].checked).toBe(true);
    });

    it('returns [] when the milestone file is missing', () => {
      expect(toggleReleaseChecklist(backlog, 'm-99', 1)).toEqual([]);
    });

    it('preserves CRLF line endings when the file uses them', () => {
      const crlfPath = path.join(dir, 'm-1 - Launch.md');
      fs.writeFileSync(crlfPath, MILESTONE_BODY.replace(/\n/g, '\r\n'));

      const items = toggleReleaseChecklist(backlog, 'm-1', 2);
      expect(items[1].checked).toBe(true);

      const raw = fs.readFileSync(crlfPath, 'utf-8');
      expect(raw.includes('\r\n')).toBe(true);
      // No bare LF that isn't part of a CRLF pair (CRLF fully preserved).
      expect(/[^\r]\n/.test(raw)).toBe(false);
      expect(raw).toContain('- [x] #2 Smoke test the build');
    });

    it('preserves LF line endings when the file uses them', () => {
      const lfPath = path.join(dir, 'm-1 - Launch.md');
      toggleReleaseChecklist(backlog, 'm-1', 2);
      const raw = fs.readFileSync(lfPath, 'utf-8');
      expect(raw.includes('\r\n')).toBe(false);
      expect(raw).toContain('- [x] #2 Smoke test the build');
    });
  });
});
