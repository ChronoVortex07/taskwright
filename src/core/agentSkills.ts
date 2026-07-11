import * as fs from 'fs';
import * as path from 'path';
import {
  TASKWRIGHT_SKILL_NAMES,
  installSkill,
  type SkillInstallResult,
  type MissingSkillSourceHandler,
} from './skillInstaller';

/**
 * The vendor-neutral **Agent Skills** discovery surface. Codex (and other
 * AGENTS.md-aware agents) scan `.agents/skills/<name>/SKILL.md` at the repo
 * root, cwd, and `$HOME`. Installing the full skill DIRECTORY here — SKILL.md
 * plus any `scripts/`/`references/`/`assets/` — makes each Taskwright skill a
 * NATIVE, progressively-disclosed skill: the agent reads only the name +
 * description initially and loads the full body when it selects the skill. This
 * replaces the earlier Codex "custom-prompt approximation" (a single flattened
 * `.md` per skill with the frontmatter stripped), so Codex now gets the same
 * un-reduced skill package Claude Code does — from one source of truth
 * (`dist/skills/`, bundled from `.claude/skills/`).
 */
export const AGENTS_SKILLS_SEGMENTS = ['.agents', 'skills'] as const;

/** Resolve the `<root>/.agents/skills` native skill discovery surface. */
export function agentSkillsRoot(targetRoot: string): string {
  return path.join(targetRoot, ...AGENTS_SKILLS_SEGMENTS);
}

function defaultMissingSkillSource(name: string, srcDir: string): void {
  console.warn(
    `[taskwright] Skill source missing, skipping native skill "${name}" (expected at ${srcDir}). ` +
      `A packaged install ships these under dist/skills/ — rebuild (bun run build) or reinstall the extension.`
  );
}

/**
 * Install the four user-facing Taskwright skills as native SKILL.md packages
 * under `<targetRoot>/.agents/skills/<name>`.
 *
 * Same source of truth (`dist/skills/`) and the same idempotency/upgrade
 * semantics as the Claude `.claude/skills` installer ({@link
 * installTaskwrightSkills}) — the only difference is the canonical destination
 * surface. A missing source is surfaced through the handler rather than failing
 * the whole setup.
 *
 * @param extSkillsDir - The extension's bundled skills directory (`dist/skills`).
 * @param targetRoot - The repo/project root; skills land under `<root>/.agents/skills`.
 * @param overwrite - Whether to replace existing skill directories (upgrade).
 * @param onMissingSource - Optional handler invoked when a source skill is missing.
 * @returns One result per present skill in {@link TASKWRIGHT_SKILL_NAMES}.
 */
export function installAgentSkills(
  extSkillsDir: string,
  targetRoot: string,
  overwrite: boolean,
  onMissingSource: MissingSkillSourceHandler = defaultMissingSkillSource
): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const skillsRoot = agentSkillsRoot(targetRoot);
  fs.mkdirSync(skillsRoot, { recursive: true });

  for (const name of TASKWRIGHT_SKILL_NAMES) {
    const srcDir = path.join(extSkillsDir, name);
    if (!fs.existsSync(srcDir)) {
      onMissingSource(name, srcDir);
      continue;
    }
    const destDir = path.join(skillsRoot, name);
    results.push(installSkill(srcDir, destDir, overwrite));
  }

  return results;
}

/**
 * Discover the skills currently installed under `<targetRoot>/.agents/skills` —
 * the same way Codex indexes the surface: a directory counts only when it holds
 * a `SKILL.md`. Returns ALL discovered skill names (Taskwright and any others),
 * sorted. Empty when the surface is absent.
 */
export function discoverAgentSkills(targetRoot: string): string[] {
  const skillsRoot = agentSkillsRoot(targetRoot);
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, 'SKILL.md'))
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Cleanly uninstall the Taskwright skills from `<targetRoot>/.agents/skills`,
 * leaving any other skills in the surface (e.g. an unrelated `agent-browser`)
 * untouched. Idempotent: a second call returns an empty array.
 *
 * @returns The names actually removed, in {@link TASKWRIGHT_SKILL_NAMES} order.
 */
export function uninstallAgentSkills(targetRoot: string): string[] {
  const skillsRoot = agentSkillsRoot(targetRoot);
  const removed: string[] = [];
  for (const name of TASKWRIGHT_SKILL_NAMES) {
    const dir = path.join(skillsRoot, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
