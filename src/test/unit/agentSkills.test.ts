import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENTS_SKILLS_SEGMENTS,
  agentSkillsRoot,
  installAgentSkills,
  discoverAgentSkills,
  uninstallAgentSkills,
} from '../../core/agentSkills';
import { TASKWRIGHT_SKILL_NAMES } from '../../core/skillInstaller';
import type { SkillInstallResult } from '../../core/skillInstaller';

describe('agentSkills — native .agents/skills packages', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-agentskills-'));
    dirs.push(dir);
    return dir;
  }

  function makeSkillDir(parent: string, name: string, content?: string): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content ?? `# ${name} skill content`, 'utf-8');
    return dir;
  }

  function fullSource(): string {
    const extSkills = tmpDir();
    for (const name of TASKWRIGHT_SKILL_NAMES) {
      makeSkillDir(extSkills, name, `${name} content`);
    }
    return extSkills;
  }

  describe('surface path', () => {
    it('resolves the canonical .agents/skills discovery surface', () => {
      const root = path.join('some', 'repo');
      expect(agentSkillsRoot(root)).toBe(path.join(root, ...AGENTS_SKILLS_SEGMENTS));
      expect(AGENTS_SKILLS_SEGMENTS).toEqual(['.agents', 'skills']);
    });
  });

  describe('installAgentSkills — installation', () => {
    it('installs all four skills as native SKILL.md packages under .agents/skills', () => {
      const extSkills = fullSource();
      const root = tmpDir();

      const results = installAgentSkills(extSkills, root, false);

      expect(results).toHaveLength(4);
      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'created',
        'created',
        'created',
        'created',
      ]);
      for (const name of TASKWRIGHT_SKILL_NAMES) {
        expect(fs.existsSync(path.join(root, '.agents', 'skills', name, 'SKILL.md'))).toBe(true);
      }
    });

    it('creates the .agents/skills surface even when the parent tree is absent', () => {
      const extSkills = fullSource();
      // A root whose .agents/skills does not yet exist.
      const root = path.join(tmpDir(), 'nested', 'workspace');
      fs.mkdirSync(root, { recursive: true });

      installAgentSkills(extSkills, root, false);

      expect(fs.existsSync(agentSkillsRoot(root))).toBe(true);
      expect(fs.existsSync(path.join(agentSkillsRoot(root), 'create-task', 'SKILL.md'))).toBe(true);
    });

    it('carries the full skill package (multi-file, progressive disclosure), not a flattened prompt', () => {
      const extSkills = tmpDir();
      for (const name of TASKWRIGHT_SKILL_NAMES) makeSkillDir(extSkills, name);
      // create-task ships an extra reference file — it must survive the native install.
      fs.mkdirSync(path.join(extSkills, 'create-task', 'references'), { recursive: true });
      fs.writeFileSync(
        path.join(extSkills, 'create-task', 'references', 'guide.md'),
        'deep guidance',
        'utf-8'
      );
      const root = tmpDir();

      installAgentSkills(extSkills, root, false);

      const dest = path.join(agentSkillsRoot(root), 'create-task');
      expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
      expect(fs.readFileSync(path.join(dest, 'references', 'guide.md'), 'utf-8')).toBe(
        'deep guidance'
      );
    });
  });

  describe('installAgentSkills — idempotent upgrades', () => {
    it('is idempotent: a second overwrite=false run skips everything', () => {
      const extSkills = fullSource();
      const root = tmpDir();

      installAgentSkills(extSkills, root, false);
      const second = installAgentSkills(extSkills, root, false);

      expect(second).toHaveLength(4);
      expect(second.every((r: SkillInstallResult) => r.action === 'skipped')).toBe(true);
    });

    it('upgrades in place when overwrite=true and refreshes stale content', () => {
      const extSkills = tmpDir();
      for (const name of TASKWRIGHT_SKILL_NAMES) makeSkillDir(extSkills, name, `v2 ${name}`);
      const root = tmpDir();
      // Pre-existing stale install of one skill.
      makeSkillDir(agentSkillsRoot(root), 'create-task', 'v1 stale');

      const results = installAgentSkills(extSkills, root, true);

      const byName: Record<string, SkillInstallResult> = {};
      for (const r of results) byName[r.name] = r;
      expect(byName['create-task'].action).toBe('overwritten');
      expect(byName['execute-task'].action).toBe('created');
      expect(
        fs.readFileSync(path.join(agentSkillsRoot(root), 'create-task', 'SKILL.md'), 'utf-8')
      ).toBe('v2 create-task');
    });

    it('surfaces a missing source through the handler instead of failing setup', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'c');
      makeSkillDir(extSkills, 'execute-task', 'e');
      const root = tmpDir();
      const onMissing = vi.fn();

      const results = installAgentSkills(extSkills, root, false, onMissing);

      expect(results.map((r) => r.name)).toEqual(['create-task', 'execute-task']);
      expect(onMissing).toHaveBeenCalledTimes(2);
      expect(onMissing).toHaveBeenCalledWith(
        'index-codebase',
        path.join(extSkills, 'index-codebase')
      );
      expect(fs.existsSync(path.join(agentSkillsRoot(root), 'index-codebase'))).toBe(false);
    });
  });

  describe('discoverAgentSkills — discovery', () => {
    it('returns the installed skills (those with a SKILL.md), sorted', () => {
      const extSkills = fullSource();
      const root = tmpDir();
      installAgentSkills(extSkills, root, false);

      expect(discoverAgentSkills(root)).toEqual([...TASKWRIGHT_SKILL_NAMES].sort());
    });

    it('is empty when the surface does not exist', () => {
      expect(discoverAgentSkills(tmpDir())).toEqual([]);
    });

    it('ignores directories without a SKILL.md and includes unrelated skills present', () => {
      const root = tmpDir();
      const surface = agentSkillsRoot(root);
      makeSkillDir(surface, 'execute-task', 'e');
      makeSkillDir(surface, 'agent-browser', 'ab'); // an unrelated (non-Taskwright) skill
      fs.mkdirSync(path.join(surface, 'not-a-skill'), { recursive: true }); // no SKILL.md

      const discovered = discoverAgentSkills(root);

      expect(discovered).toEqual(['agent-browser', 'execute-task']);
      expect(discovered).not.toContain('not-a-skill');
    });
  });

  describe('uninstallAgentSkills — clean uninstall', () => {
    it('removes exactly the Taskwright skills and reports them', () => {
      const extSkills = fullSource();
      const root = tmpDir();
      installAgentSkills(extSkills, root, false);

      const removed = uninstallAgentSkills(root);

      expect(removed.sort()).toEqual([...TASKWRIGHT_SKILL_NAMES].sort());
      for (const name of TASKWRIGHT_SKILL_NAMES) {
        expect(fs.existsSync(path.join(agentSkillsRoot(root), name))).toBe(false);
      }
      expect(discoverAgentSkills(root)).toEqual([]);
    });

    it('leaves unrelated skills in the surface untouched (scoped uninstall)', () => {
      const extSkills = fullSource();
      const root = tmpDir();
      installAgentSkills(extSkills, root, false);
      makeSkillDir(agentSkillsRoot(root), 'agent-browser', 'keep me');

      uninstallAgentSkills(root);

      expect(fs.existsSync(path.join(agentSkillsRoot(root), 'agent-browser', 'SKILL.md'))).toBe(
        true
      );
      expect(discoverAgentSkills(root)).toEqual(['agent-browser']);
    });

    it('is idempotent: a second uninstall removes nothing', () => {
      const extSkills = fullSource();
      const root = tmpDir();
      installAgentSkills(extSkills, root, false);

      expect(uninstallAgentSkills(root)).toHaveLength(4);
      expect(uninstallAgentSkills(root)).toEqual([]);
    });
  });

  describe('packaged skill bundle — resolves the real source, excludes dev skills', () => {
    // src/test/unit -> repo root is three levels up.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const realSkillsDir = path.join(repoRoot, '.claude', 'skills');

    it('installs EXACTLY the four shipped skills natively, and NOT visual-proof/agent-browser', () => {
      const root = tmpDir();

      const results = installAgentSkills(realSkillsDir, root, true);

      expect(results.map((r: SkillInstallResult) => r.name).sort()).toEqual(
        [...TASKWRIGHT_SKILL_NAMES].sort()
      );
      for (const name of TASKWRIGHT_SKILL_NAMES) {
        expect(fs.existsSync(path.join(agentSkillsRoot(root), name, 'SKILL.md'))).toBe(true);
      }
      expect(fs.existsSync(path.join(agentSkillsRoot(root), 'visual-proof'))).toBe(false);
      expect(fs.existsSync(path.join(agentSkillsRoot(root), 'agent-browser'))).toBe(false);
      expect(discoverAgentSkills(root)).toEqual([...TASKWRIGHT_SKILL_NAMES].sort());
    });
  });
});
