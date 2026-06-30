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
    expect(out).toContain('task_create');
    expect(out).not.toMatch(/\{\{\w+\}\}/);
  });
});
