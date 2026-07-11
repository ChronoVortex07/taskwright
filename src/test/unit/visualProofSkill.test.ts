import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * AC#5: the visual-proof capability must be a real, readable skill whose
 * cross-references resolve. It historically pointed at
 * `.claude/skills/agent-browser/SKILL.md`, but `.claude/skills/agent-browser`
 * is a text pseudo-symlink that does not materialize as a directory on Windows
 * (or any checkout without symlink support), so that path was unusable. The
 * canonical, always-real location is `.agents/skills/agent-browser/SKILL.md`.
 */
describe('visual-proof skill reference (AC#5)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const visualProofSkill = path.join(repoRoot, '.claude', 'skills', 'visual-proof', 'SKILL.md');

  it('is a real, readable skill package', () => {
    expect(fs.existsSync(visualProofSkill)).toBe(true);
    const body = fs.readFileSync(visualProofSkill, 'utf-8');
    expect(body).toContain('name: visual-proof');
  });

  it('does not reference the unusable .claude/skills/agent-browser pseudo-symlink path', () => {
    const body = fs.readFileSync(visualProofSkill, 'utf-8');
    expect(body).not.toContain('.claude/skills/agent-browser');
  });

  it('references the agent-browser skill at its real, readable canonical location', () => {
    const body = fs.readFileSync(visualProofSkill, 'utf-8');
    expect(body).toContain('.agents/skills/agent-browser/SKILL.md');
    // ...and that location actually resolves to a readable SKILL.md.
    const canonical = path.join(repoRoot, '.agents', 'skills', 'agent-browser', 'SKILL.md');
    expect(fs.existsSync(canonical)).toBe(true);
    expect(fs.statSync(canonical).isFile()).toBe(true);
  });
});
