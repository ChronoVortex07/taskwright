import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TASKWRIGHT_AGENTS_CONVENTION } from '../../core/agentConvention';
import { CLAUDE_DISPATCH_TEMPLATE, CODEX_DISPATCH_TEMPLATE } from '../../core/dispatchProfiles';

/**
 * TASK-122. A Taskwright worktree is a plain `git worktree add` directory under
 * `.worktrees/`, created by `start_task`. Agent harnesses ship their OWN
 * worktree-switch tool (Claude Code's `EnterWorktree`, which manages
 * `.claude/worktrees/`), and its trigger is literally "CLAUDE.md or memory
 * instructions direct you to work in a worktree" — which is exactly what every
 * Taskwright instruction surface says. So agents reached for it, it prompted for
 * approval, and it failed: a cwd-pinned subagent (how `/orchestrate-board` fans
 * out) may only switch into `.claude/worktrees/` of the same repo, never
 * `.worktrees/`. Saying WHERE to work is not enough — every surface must also
 * name the mechanism NOT to use, and the one that works (`cd` / `git -C`).
 *
 * The second half of the contract: a session that bootstrapped its own worktree
 * with `start_task` is still MCP-rooted in the PRIMARY tree (the server roots at
 * launch and cannot re-root), no matter where Bash `cd`'d. Such a session must
 * close with `request_merge { taskId, worktree }` — a bare `request_merge`
 * aborts with `wrong_root`.
 */
describe('worktree-entry contract (TASK-122)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const skill = (name: string): string =>
    fs.readFileSync(path.join(repoRoot, '.claude', 'skills', name, 'SKILL.md'), 'utf-8');

  const surfaces: Array<{ name: string; body: string }> = [
    { name: 'execute-task SKILL.md', body: skill('execute-task') },
    { name: 'orchestrate-board SKILL.md', body: skill('orchestrate-board') },
    { name: 'TASKWRIGHT_AGENTS_CONVENTION', body: TASKWRIGHT_AGENTS_CONVENTION },
    { name: 'CLAUDE_DISPATCH_TEMPLATE', body: CLAUDE_DISPATCH_TEMPLATE },
    { name: 'CODEX_DISPATCH_TEMPLATE', body: CODEX_DISPATCH_TEMPLATE },
  ];

  it.each(surfaces)('$name forbids the harness worktree-switch tool by name', ({ body }) => {
    expect(body).toContain('EnterWorktree');
  });

  it.each(surfaces)('$name names the mechanism that works instead', ({ body }) => {
    // `cd` (Bash) or `git -C` — never a worktree-switch tool.
    expect(body).toMatch(/`cd`|cd into|git -C/);
  });

  const bootstrapSurfaces = surfaces.filter(
    (s) => s.name === 'execute-task SKILL.md' || s.name === 'orchestrate-board SKILL.md'
  );

  it.each(bootstrapSurfaces)(
    '$name closes a start_task-bootstrapped session with request_merge { taskId, worktree }',
    ({ body }) => {
      expect(body).toContain('request_merge { taskId, worktree }');
    }
  );

  it('orchestrate-board tells its cwd-pinned subagent to pass the worktree target', () => {
    const body = skill('orchestrate-board');
    // The subagent calls start_task itself, so its MCP is primary-rooted: the
    // subagent prompt must not tell it to close with a bare request_merge.
    expect(body).not.toContain('closes by calling `request_merge` from inside the worktree');
    expect(body).toContain('request_merge { taskId, worktree }');
  });

  it('execute-task does not decide rootedness from the Bash working directory', () => {
    const body = skill('execute-task');
    // The old probe (`git rev-parse --git-dir` != `--git-common-dir`) lies after a
    // `cd`: Bash moves, the MCP server does not. Rootedness is decided by whether
    // THIS session called start_task, not by where the shell happens to be.
    expect(body).not.toContain('git rev-parse --git-dir');
  });

  it('execute-task does not treat the primary-tree abort as a cancellation', () => {
    const body = skill('execute-task');
    expect(body).not.toContain('the primary-tree abort');
    expect(body).toContain('wrong_root');
  });
});
