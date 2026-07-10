import { describe, it, expect } from 'vitest';
import {
  DISPATCH_PROFILES,
  DISPATCH_AGENT_IDS,
  resolveDispatchProfile,
  type DispatchAgentId,
} from '../../core/dispatchProfiles';
import {
  DEFAULT_DISPATCH_TEMPLATE,
  dispatchContextFromTask,
  renderDispatchPrompt,
  resolveTerminalLaunch,
} from '../../core/dispatchPrompt';
import { Task } from '../../core/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-7',
    title: 'Add user login',
    status: 'To Do',
    priority: 'high',
    description: 'Let users sign in with email and password.',
    labels: ['feature', 'auth'],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [{ id: 1, text: 'Login form validates email', checked: false }],
    definitionOfDone: [],
    implementationPlan: '1. Build form\n2. Wire backend',
    filePath: '/repo/backlog/tasks/TASK-7 - Add-user-login.md',
    ...overrides,
  };
}

describe('resolveDispatchProfile', () => {
  it('resolves the claude profile by id', () => {
    expect(resolveDispatchProfile('claude')).toBe(DISPATCH_PROFILES.claude);
  });

  it('resolves the codex profile by id', () => {
    expect(resolveDispatchProfile('codex')).toBe(DISPATCH_PROFILES.codex);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveDispatchProfile('  Codex ')).toBe(DISPATCH_PROFILES.codex);
    expect(resolveDispatchProfile('CLAUDE')).toBe(DISPATCH_PROFILES.claude);
  });

  it('falls back to claude for unknown, empty, or undefined values', () => {
    expect(resolveDispatchProfile('copilot')).toBe(DISPATCH_PROFILES.claude);
    expect(resolveDispatchProfile('')).toBe(DISPATCH_PROFILES.claude);
    expect(resolveDispatchProfile(undefined)).toBe(DISPATCH_PROFILES.claude);
  });
});

describe('DISPATCH_PROFILES — shared dispatch contract', () => {
  it('registers exactly the known agents', () => {
    expect(DISPATCH_AGENT_IDS).toEqual(['claude', 'codex']);
    expect(Object.keys(DISPATCH_PROFILES).sort()).toEqual([...DISPATCH_AGENT_IDS].sort());
  });

  // Every profile template must carry the same non-negotiable instructions —
  // profiles vary the agent-facing phrasing, never the workflow contract.
  const contractMarkers = [
    '.worktrees/{{worktree}}', // launch inside the isolated worktree
    '{{id}}',
    '{{title}}',
    '{{description}}',
    '{{acceptanceCriteria}}',
    '{{plan}}',
    'bun install', // fresh worktree has no node_modules
    'node_modules',
    'repository root', // never commit/merge at the shared root
    '/execute-task', // the per-agent skill/prompt entry point
    'get_active_task',
    'request_merge', // close through the merge queue
    'from inside your worktree',
  ];

  for (const agent of ['claude', 'codex'] as DispatchAgentId[]) {
    describe(`${agent} profile`, () => {
      const profile = DISPATCH_PROFILES[agent];

      it('carries the full workflow contract in its template', () => {
        for (const marker of contractMarkers) {
          expect(profile.template, `missing "${marker}"`).toContain(marker);
        }
      });

      it('renders cleanly with no leftover known placeholders', () => {
        const ctx = dispatchContextFromTask(makeTask(), { worktree: 'task-7-add-user-login' });
        const out = renderDispatchPrompt(profile.template, ctx);
        expect(out).toContain('TASK-7');
        expect(out).toContain('Add user login');
        expect(out).not.toMatch(/\{\{\w+\}\}/);
      });

      it('has a label and agent id', () => {
        expect(profile.agent).toBe(agent);
        expect(profile.label.length).toBeGreaterThan(0);
      });

      it('suggests an interactive terminal command that passes the headless guardrail', () => {
        const ctx = dispatchContextFromTask(makeTask(), {
          worktree: 'task-7',
          handoffFile: '/repo/.taskwright/handoff/TASK-7.md',
        });
        const decision = resolveTerminalLaunch(profile.suggestedTerminalCommand, ctx);
        expect(decision.run).toBe(true);
        expect(decision.warning).toBeUndefined();
        // The suggestion seeds the session from the handoff file.
        expect(decision.command).toContain('/repo/.taskwright/handoff/TASK-7.md');
      });
    });
  }

  it('claude template addresses a Claude Code session and bans claude -p', () => {
    const t = DISPATCH_PROFILES.claude.template;
    expect(t).toMatch(/Claude Code session/);
    expect(t).toContain('`claude -p`');
    expect(t).not.toMatch(/\bCodex\b/);
  });

  it('codex template addresses a Codex session and bans codex exec', () => {
    const t = DISPATCH_PROFILES.codex.template;
    expect(t).toMatch(/Codex session/);
    expect(t).toContain('`codex exec`');
    expect(t).not.toMatch(/\bClaude\b/);
  });

  it('keeps DEFAULT_DISPATCH_TEMPLATE as the claude profile template (back-compat)', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toBe(DISPATCH_PROFILES.claude.template);
  });
});
