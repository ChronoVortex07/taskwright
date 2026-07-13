import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TASKWRIGHT_AGENTS_CONVENTION } from '../../core/agentConvention';
import { CLAUDE_DISPATCH_TEMPLATE, CODEX_DISPATCH_TEMPLATE } from '../../core/dispatchProfiles';

/**
 * TASK-120. There is ONE id space: a draft is created with a real `TASK-N` id directly in
 * `backlog/drafts/`, `folder === 'drafts'` is the sole draftness marker, and promote/demote
 * are pure file moves that NEVER change the id.
 *
 * Agents read the MCP tool descriptions, the skills, CLAUDE.md and AGENTS.md as fact. While
 * those surfaces promised `DRAFT-N`, agents kept writing draft-flavored ids into specs,
 * handoffs and dependencies — the exact failure stable ids exist to remove (this repo's own
 * TASK-77 description still cites a DRAFT-3/DRAFT-4 that never existed after promotion).
 *
 * So the ban is a build-time contract, not a one-time sweep: an agent-facing surface may only
 * say `DRAFT-N` on a line that is explicitly about the LEGACY/MIGRATION path. Any other
 * DRAFT-N — a minting promise, a filename pattern, a dangling cross-reference — fails here.
 */
describe('id-space contract (TASK-120)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const read = (...p: string[]): string => fs.readFileSync(path.join(repoRoot, ...p), 'utf-8');
  const skill = (name: string): string => read('.claude', 'skills', name, 'SKILL.md');

  const mcpServer = read('src', 'mcp', 'server.ts');
  const createTaskSkill = skill('create-task');
  const indexCodebaseSkill = skill('index-codebase');
  const claudeMd = read('CLAUDE.md');
  const agentsMd = read('AGENTS.md');

  const surfaces: Array<{ name: string; body: string }> = [
    { name: 'src/mcp/server.ts', body: mcpServer },
    { name: 'create-task SKILL.md', body: createTaskSkill },
    { name: 'index-codebase SKILL.md', body: indexCodebaseSkill },
    { name: 'execute-task SKILL.md', body: skill('execute-task') },
    { name: 'orchestrate-board SKILL.md', body: skill('orchestrate-board') },
    { name: 'CLAUDE.md', body: claudeMd },
    { name: 'AGENTS.md', body: agentsMd },
    { name: 'README.md', body: read('README.md') },
    { name: 'TASKWRIGHT_AGENTS_CONVENTION', body: TASKWRIGHT_AGENTS_CONVENTION },
    { name: 'CLAUDE_DISPATCH_TEMPLATE', body: CLAUDE_DISPATCH_TEMPLATE },
    { name: 'CODEX_DISPATCH_TEMPLATE', body: CODEX_DISPATCH_TEMPLATE },
  ];

  /** A DRAFT-shaped id: DRAFT-3, DRAFT-N, DRAFT-{N}. Uppercase only, so JSON-Schema's
   *  `draft-07` and lowercase legacy FILENAMES in fixtures are not false positives. */
  const DRAFT_ID = /DRAFT-(?:\d+|N\b|\{N\})/;
  /** A line may still name DRAFT-N when it is explicitly describing the legacy/migration path. */
  const LEGACY_CONTEXT = /legacy|migrat/i;

  it.each(surfaces)('$name never promises a DRAFT-N id outside a legacy note', ({ body }) => {
    const offenders = body
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => DRAFT_ID.test(line) && !LEGACY_CONTEXT.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  it('create_task’s `draft` flag says the id is a normal TASK-N that never changes', () => {
    // The description is the agent's only view of the flag's semantics.
    const at = mcpServer.indexOf('draft: z');
    expect(at).toBeGreaterThan(-1);
    const block = mcpServer.slice(at, at + 800);
    expect(block).toMatch(/Create as a draft/);
    expect(block).toMatch(/TASK-N/);
    expect(block).toMatch(/NEVER changes the id/i);
    expect(block).toMatch(/FINAL/i);
  });

  it.each([
    { name: 'create-task SKILL.md', body: createTaskSkill },
    { name: 'index-codebase SKILL.md', body: indexCodebaseSkill },
  ])('$name tells the agent a draft’s returned id is final', ({ body }) => {
    // Markdown wraps, so compare on a whitespace-normalized body.
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toMatch(/ID[^.]*is \*\*final\*\*/i);
  });

  it('CLAUDE.md documents the one id space', () => {
    expect(claudeMd).toContain('Stable task IDs (one ID space)');
    expect(claudeMd).toContain("`folder === 'drafts'`");
  });

  it('AGENTS.md tells the agent a draft’s ID is final', () => {
    expect(agentsMd).toContain("A draft's ID is final");
  });

  it('AGENTS.md describes promote and demote as pure moves that keep the ID', () => {
    const rules = agentsMd.slice(agentsMd.indexOf('#### Key Operations'));
    expect(rules).toMatch(/\*\*Promote\*\*.*ID (?:is )?(?:un|never )?chang/i);
    expect(rules).toMatch(/\*\*Demote\*\*.*ID (?:is )?(?:un|never )?chang/i);
  });
});
