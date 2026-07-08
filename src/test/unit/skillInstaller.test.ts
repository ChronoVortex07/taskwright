import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TASKWRIGHT_SKILL_NAMES,
  installSkill,
  installTaskwrightSkills,
} from '../../core/skillInstaller';
import type { SkillInstallResult } from '../../core/skillInstaller';

describe('skillInstaller', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-skill-'));
    dirs.push(dir);
    return dir;
  }

  function makeSkillDir(parent: string, name: string, content?: string): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content ?? `# ${name} skill content`, 'utf-8');
    return dir;
  }

  describe('TASKWRIGHT_SKILL_NAMES', () => {
    it('lists the three Taskwright skills', () => {
      expect(TASKWRIGHT_SKILL_NAMES).toEqual(['create-task', 'execute-task', 'index-codebase']);
    });
  });

  describe('installSkill', () => {
    it('creates the skill directory when the destination does not exist', () => {
      const src = makeSkillDir(tmpDir(), 'create-task', 'skill content');
      const destParent = tmpDir();
      const dest = path.join(destParent, 'create-task');

      const result = installSkill(src, dest, false);

      expect(result).toEqual({
        name: 'create-task',
        action: 'created',
      } satisfies SkillInstallResult);
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('skill content');
    });

    it('skips when the destination directory already exists and overwrite is false', () => {
      const src = makeSkillDir(tmpDir(), 'execute-task', 'source content');
      const destParent = tmpDir();
      const dest = makeSkillDir(destParent, 'execute-task', 'existing content');

      const result = installSkill(src, dest, false);

      expect(result).toEqual({
        name: 'execute-task',
        action: 'skipped',
      } satisfies SkillInstallResult);
      // Existing content must be preserved.
      expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('existing content');
    });

    it('overwrites when the destination directory already exists and overwrite is true', () => {
      const src = makeSkillDir(tmpDir(), 'index-codebase', 'new source content');
      const destParent = tmpDir();
      const dest = makeSkillDir(destParent, 'index-codebase', 'old existing content');

      const result = installSkill(src, dest, true);

      expect(result).toEqual({
        name: 'index-codebase',
        action: 'overwritten',
      } satisfies SkillInstallResult);
      expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('new source content');
    });

    it('copies multiple files inside the skill directory', () => {
      const srcParent = tmpDir();
      const src = path.join(srcParent, 'create-task');
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill', 'utf-8');
      fs.writeFileSync(path.join(src, 'helper.md'), 'helper content', 'utf-8');

      const destParent = tmpDir();
      const dest = path.join(destParent, 'create-task');

      installSkill(src, dest, false);

      expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'helper.md'))).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'helper.md'), 'utf-8')).toBe('helper content');
    });
  });

  describe('installTaskwrightSkills', () => {
    it('installs all three skills into the project skills directory', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(results).toHaveLength(3);
      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'created',
        'created',
        'created',
      ]);

      for (const name of TASKWRIGHT_SKILL_NAMES) {
        const dest = path.join(projectSkills, name, 'SKILL.md');
        expect(fs.existsSync(dest)).toBe(true);
      }
    });

    it('skips already-installed skills and creates missing ones', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();
      // Pre-install one skill.
      makeSkillDir(projectSkills, 'create-task', 'existing content');

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      const byName: Record<string, SkillInstallResult> = {};
      for (const r of results) byName[r.name] = r;

      expect(byName['create-task'].action).toBe('skipped');
      expect(byName['execute-task'].action).toBe('created');
      expect(byName['index-codebase'].action).toBe('created');
    });

    it('overwrites all skills when overwrite is true', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'new create');
      makeSkillDir(extSkills, 'execute-task', 'new execute');
      makeSkillDir(extSkills, 'index-codebase', 'new index');

      const projectSkills = tmpDir();
      makeSkillDir(projectSkills, 'create-task', 'old create');
      makeSkillDir(projectSkills, 'execute-task', 'old execute');

      const results = installTaskwrightSkills(extSkills, projectSkills, true);

      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'overwritten',
        'overwritten',
        'created',
      ]);
    });

    it('is idempotent: re-running with overwrite=false creates nothing new', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();

      // First run installs everything.
      installTaskwrightSkills(extSkills, projectSkills, false);
      // Second run should skip everything.
      const secondResults = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(secondResults.every((r: SkillInstallResult) => r.action === 'skipped')).toBe(true);
    });
  });

  describe('installTaskwrightSkills — missing source is logged, not silent', () => {
    it('logs a missing source skill and skips it; present skills still install (no-op holds)', () => {
      const extSkills = tmpDir();
      // Only two of the three sources exist — index-codebase is missing.
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');

      const projectSkills = tmpDir();
      const onMissing = vi.fn();

      const results = installTaskwrightSkills(extSkills, projectSkills, false, onMissing);

      // No-op still holds for the missing skill: no result entry, no dir written.
      expect(results.map((r: SkillInstallResult) => r.name)).toEqual([
        'create-task',
        'execute-task',
      ]);
      expect(fs.existsSync(path.join(projectSkills, 'index-codebase'))).toBe(false);

      // ...but the miss is now SURFACED (logged) instead of silently swallowed.
      expect(onMissing).toHaveBeenCalledTimes(1);
      expect(onMissing).toHaveBeenCalledWith(
        'index-codebase',
        path.join(extSkills, 'index-codebase')
      );
    });

    it('does not invoke the missing-source handler when every source is present', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'c');
      makeSkillDir(extSkills, 'execute-task', 'e');
      makeSkillDir(extSkills, 'index-codebase', 'i');
      const onMissing = vi.fn();

      installTaskwrightSkills(extSkills, tmpDir(), false, onMissing);

      expect(onMissing).not.toHaveBeenCalled();
    });
  });

  describe('packaged skill bundle — resolves the real source, excludes dev skills', () => {
    // src/test/unit -> repo root is three levels up.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const realSkillsDir = path.join(repoRoot, '.claude', 'skills');

    it('the committed .claude/skills/ source contains all three shipped skills', () => {
      for (const name of TASKWRIGHT_SKILL_NAMES) {
        expect(fs.existsSync(path.join(realSkillsDir, name, 'SKILL.md'))).toBe(true);
      }
    });

    it('bundling the real source copies EXACTLY the three skills and NOT visual-proof/agent-browser', () => {
      const dest = tmpDir();

      const results = installTaskwrightSkills(realSkillsDir, dest, true);

      // Exactly the three Taskwright skills, each with its SKILL.md.
      expect(results.map((r: SkillInstallResult) => r.name).sort()).toEqual(
        [...TASKWRIGHT_SKILL_NAMES].sort()
      );
      for (const name of TASKWRIGHT_SKILL_NAMES) {
        expect(fs.existsSync(path.join(dest, name, 'SKILL.md'))).toBe(true);
      }

      // The dev-only skills are never bundled (they are not in TASKWRIGHT_SKILL_NAMES).
      expect(fs.existsSync(path.join(dest, 'visual-proof'))).toBe(false);
      expect(fs.existsSync(path.join(dest, 'agent-browser'))).toBe(false);
    });
  });
});
