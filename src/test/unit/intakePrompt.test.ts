import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INTAKE_TEMPLATE,
  intakeContext,
  renderIntakePrompt,
} from '../../core/intakePrompt';

describe('intakeContext', () => {
  it('joins board vocabulary into readable lists', () => {
    const ctx = intakeContext('two bugs here', {
      labels: ['bug', 'feature'],
      statuses: ['To Do', 'Done'],
      priorities: ['high', 'low'],
    });
    expect(ctx.dump).toBe('two bugs here');
    expect(ctx.labels).toBe('bug, feature');
    expect(ctx.statuses).toBe('To Do, Done');
    expect(ctx.priorities).toBe('high, low');
  });

  it('uses placeholders when a vocabulary list is empty', () => {
    const ctx = intakeContext('dump', { labels: [], statuses: ['To Do'], priorities: [] });
    expect(ctx.labels).toBe('(none defined — create labels as needed)');
    expect(ctx.priorities).toBe('high, medium, low');
  });
});

describe('renderIntakePrompt', () => {
  it('embeds the dump and board vocabulary', () => {
    const ctx = intakeContext('Login button broken on mobile', {
      labels: ['bug'],
      statuses: ['To Do'],
      priorities: ['high'],
    });
    const out = renderIntakePrompt(DEFAULT_INTAKE_TEMPLATE, ctx);
    expect(out).toContain('Login button broken on mobile');
    expect(out).toContain('create_task');
    expect(out).not.toContain('Backlog.md MCP');
    expect(out).not.toMatch(/\{\{\w+\}\}/);
  });

  it('refers to the board as a Taskwright board, not Backlog.md', () => {
    expect(DEFAULT_INTAKE_TEMPLATE).toContain('Taskwright task board');
    expect(DEFAULT_INTAKE_TEMPLATE).not.toContain('Backlog.md task board');
  });
});
