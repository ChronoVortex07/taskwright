import * as fs from 'fs';
import * as path from 'path';

/**
 * The three Taskwright skills installed into the project's `.claude/skills/`
 * as part of Claude Code integration setup. These skills are tightly coupled to
 * the Taskwright MCP tools which are also registered per-project via `.mcp.json`,
 * so per-project installation is the right default.
 */
export const TASKWRIGHT_SKILL_NAMES = ['create-task', 'execute-task', 'index-codebase'] as const;

/** What happened for a single skill during installation. */
export interface SkillInstallResult {
  /** The skill name (e.g. "create-task"). */
  name: string;
  /** Whether the skill was created, skipped (already exists), or overwritten. */
  action: 'created' | 'skipped' | 'overwritten';
}

/**
 * Copy a single skill directory from source to destination.
 *
 * Idempotent by default: if the destination directory already exists and
 * `overwrite` is false, the existing directory is left untouched and the result
 * reports `skipped`. When `overwrite` is true, an existing destination is
 * removed and replaced.
 *
 * @param srcDir - Path to the source skill directory (must contain SKILL.md).
 * @param destDir - Path where the skill directory should be installed.
 * @param overwrite - Whether to replace an existing destination directory.
 * @returns A result describing what happened.
 */
export function installSkill(
  srcDir: string,
  destDir: string,
  overwrite: boolean
): SkillInstallResult {
  const name = path.basename(destDir);
  const existed = fs.existsSync(destDir);

  if (existed && !overwrite) {
    return { name, action: 'skipped' };
  }

  if (existed) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  fs.cpSync(srcDir, destDir, { recursive: true });

  return { name, action: existed ? 'overwritten' : 'created' };
}

/**
 * Invoked when a source skill directory named in {@link TASKWRIGHT_SKILL_NAMES}
 * is absent. Default: warn to the console so a BROKEN PACKAGE (a skill that failed
 * to bundle into `dist/skills/`) is visible rather than silently missing.
 */
export type MissingSkillSourceHandler = (name: string, srcDir: string) => void;

function defaultMissingSkillSource(name: string, srcDir: string): void {
  console.warn(
    `[taskwright] Skill source missing, skipping "${name}" (expected at ${srcDir}). ` +
      `A packaged install ships these under dist/skills/ — rebuild (bun run build) or reinstall the extension.`
  );
}

/**
 * Install all Taskwright skills from the extension's `.claude/skills/` into
 * the project's `.claude/skills/`.
 *
 * @param extSkillsDir - Path to the extension's `.claude/skills/` directory.
 * @param projectSkillsDir - Path to the project's `.claude/skills/` directory.
 * @param overwrite - Whether to replace existing skill directories.
 * @param onMissingSource - Optional handler invoked when a source skill is missing.
 * @returns An array of results, one per skill name in {@link TASKWRIGHT_SKILL_NAMES}.
 */
export function installTaskwrightSkills(
  extSkillsDir: string,
  projectSkillsDir: string,
  overwrite: boolean,
  onMissingSource: MissingSkillSourceHandler = defaultMissingSkillSource
): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];

  for (const name of TASKWRIGHT_SKILL_NAMES) {
    const srcDir = path.join(extSkillsDir, name);
    const destDir = path.join(projectSkillsDir, name);

    if (!fs.existsSync(srcDir)) {
      // Source skill missing — skip this one rather than failing the whole setup,
      // but SURFACE it: a packaged install always ships these under dist/skills/,
      // so a miss means a broken package, not a normal dev checkout.
      onMissingSource(name, srcDir);
      continue;
    }

    results.push(installSkill(srcDir, destDir, overwrite));
  }

  return results;
}
