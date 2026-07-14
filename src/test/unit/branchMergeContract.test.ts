import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  TASKWRIGHT_AGENTS_CONVENTION,
  TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS,
} from '../../core/agentConvention';

/**
 * TASK-127. The task-less merge path only removes friction if agents KNOW it
 * exists at the moment they reach for the thing it replaces. The mined failure
 * (friction report 2026-07-14, §3) was not that `git merge --ff-only` in the repo
 * root is allowed — it is blocked — but that an agent with a dev worktree and no
 * board task had no sanctioned alternative to reach for, so it burned ~4 turns
 * per merge on block → explain → ask → override.
 *
 * So every agent-facing surface that tells an agent NOT to merge from the repo
 * root must, in the same breath, name `request_branch_merge` as what to do
 * instead. A surface that forbids without offering the alternative fails here.
 */
describe('task-less merge contract (TASK-127)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const read = (...rel: string[]): string => fs.readFileSync(path.join(repoRoot, ...rel), 'utf-8');
  const skill = (name: string): string => read('.claude', 'skills', name, 'SKILL.md');

  const surfaces: Array<{ name: string; body: string }> = [
    { name: 'AGENTS.md', body: read('AGENTS.md') },
    { name: 'CLAUDE.md', body: read('CLAUDE.md') },
    { name: 'execute-task SKILL.md', body: skill('execute-task') },
    { name: 'orchestrate-board SKILL.md', body: skill('orchestrate-board') },
    { name: 'TASKWRIGHT_AGENTS_CONVENTION', body: TASKWRIGHT_AGENTS_CONVENTION },
  ];

  it.each(surfaces)('$name names request_branch_merge as the task-less close', ({ body }) => {
    expect(body).toContain('request_branch_merge');
  });

  it.each(surfaces)('$name still forbids merging from the repo root', ({ body }) => {
    // The alternative replaces the manual merge; it must not be read as a licence
    // for one.
    expect(body).toMatch(/repo root|repository root|primary checkout/i);
  });

  it('AGENTS.md explains WHEN the task-less path applies (a worktree with no board task)', () => {
    const body = read('AGENTS.md');
    expect(body).toMatch(/no board task|task-less|without a task/i);
  });

  it('the injected AGENTS convention stays within its context budget', () => {
    // The new sentence must not push AGENTS.md past what Codex will load.
    expect(TASKWRIGHT_AGENTS_CONVENTION.length).toBeLessThan(
      TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS
    );
  });
});
