import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TASKWRIGHT_MCP_INSTRUCTIONS } from '../../mcp/instructions';

/**
 * TASK-129. In the Jul 13 /orchestrate-board run, 9 of 11 self-bootstrapping subagents
 * called `get_active_task` right after their own `start_task` / `claim_task` and got
 * `{"active": false}` — the marker `start_task` seeds lives in the NEW worktree, while
 * the calling session's MCP server stays rooted in the primary tree. Each agent then
 * went hunting for its task file on disk, which in git-auto mode is not even under the
 * repo root (`ls backlog/tasks/` fails; the board lives at `.taskwright/board/`).
 *
 * The contract: the task's context is HANDED to a session by `start_task` / `claim_task`.
 * No agent-facing surface may send an agent looking for the board on the filesystem.
 */
describe('task-context contract (TASK-129)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const skill = (name: string): string =>
    fs.readFileSync(path.join(repoRoot, '.claude', 'skills', name, 'SKILL.md'), 'utf-8');

  /**
   * Markdown wraps prose across lines, so every assertion here runs against a
   * whitespace-collapsed body — otherwise "work from\n  it" would read as a violation.
   */
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  const surfaces: Array<{ name: string; body: string }> = [
    { name: 'execute-task SKILL.md', body: flat(skill('execute-task')) },
    { name: 'orchestrate-board SKILL.md', body: flat(skill('orchestrate-board')) },
    { name: 'TASKWRIGHT_MCP_INSTRUCTIONS', body: flat(TASKWRIGHT_MCP_INSTRUCTIONS) },
  ];

  it.each(surfaces)('$name says start_task/claim_task return the task context', ({ body }) => {
    // It must be stated that the context arrives WITH the bootstrap/claim, not after it.
    expect(body).toMatch(/start_task/);
    expect(body).toMatch(/claim_task/);
    expect(body.toLowerCase()).toContain('context');
  });

  it.each(surfaces)('$name forbids hunting the filesystem for the board', ({ body }) => {
    // Some phrasing of "never go looking for the board on disk" must be present.
    expect(body.toLowerCase()).toMatch(/(never|don't|do not)[^.]*\b(hunt|search|look|ls)\b/);
    // ...and it must say WHY the path cannot be assumed: git-auto relocates the board.
    expect(body.toLowerCase()).toContain('git-auto');
  });

  const skills = surfaces.filter((s) => s.name.endsWith('SKILL.md'));

  it.each(skills)('$name does not instruct a directory hunt for the board', ({ body }) => {
    // No step may tell an agent to list/glob the board directory to find its task. The
    // board is not at a fixed path: `git-auto` moves it to .taskwright/board/backlog/.
    const hunts = [/`?ls`? backlog\/tasks/gi, /glob[^.]{0,40} backlog\/tasks/gi];
    for (const hunt of hunts) {
      for (const match of body.matchAll(hunt)) {
        // Such a phrase may appear ONLY inside an explicit prohibition ("never ...",
        // "no `ls backlog/tasks/`"). Look back over the sentence that contains it.
        const sentence = body.slice(Math.max(0, match.index - 200), match.index).toLowerCase();
        expect(sentence).toMatch(/never|no\b|not\b|don't|do not/);
      }
    }
  });

  it.each(skills)('$name tells the agent to work from the returned context', ({ body }) => {
    expect(body).toMatch(/work from (it|that|what they handed back)/i);
  });

  it('execute-task no longer opens by calling get_active_task unconditionally', () => {
    const body = skill('execute-task');
    // The old step 1 ("Call `get_active_task` a single time") made every self-bootstrapping
    // session burn a call that structurally could not answer. A named task now goes straight
    // to start_task, which hands back the context.
    expect(body).not.toContain('Call `get_active_task` a single time');
  });

  it('the skills explain the ambiguity guard rather than promising a guess', () => {
    // With several tasks in flight in one session (parallel subagents share one MCP server
    // and one root), get_active_task must return candidates, not a guess.
    expect(skill('execute-task')).toContain('candidates');
    expect(skill('orchestrate-board')).toContain('candidates');
  });
});
