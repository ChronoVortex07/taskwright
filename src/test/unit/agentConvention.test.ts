import { describe, it, expect } from 'vitest';
import {
  injectConvention,
  injectAgentsConvention,
  TASKWRIGHT_CONVENTION,
  TASKWRIGHT_AGENTS_CONVENTION,
  TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS,
} from '../../core/agentConvention';
import { TASKWRIGHT_MARKERS } from '../../core/markerBlock';

describe('injectConvention', () => {
  it('wraps the convention in Taskwright markers for a new file', () => {
    const out = injectConvention('');
    expect(out).toContain(TASKWRIGHT_MARKERS.begin);
    expect(out).toContain(TASKWRIGHT_MARKERS.end);
    expect(out).toContain('get_active_task');
    expect(out).toContain(TASKWRIGHT_CONVENTION);
  });

  it('preserves existing CLAUDE.md content and appends the block once', () => {
    const existing = '# House rules\n\nUse tabs.\n';
    const out = injectConvention(existing);
    expect(out.startsWith(existing)).toBe(true);
    expect((out.match(/TASKWRIGHT:BEGIN/g) ?? []).length).toBe(1);
  });

  it('is idempotent', () => {
    const once = injectConvention('# Doc\n');
    expect(injectConvention(once)).toBe(once);
  });
});

describe('injectAgentsConvention', () => {
  it('wraps the AGENTS convention in Taskwright markers for a new file', () => {
    const out = injectAgentsConvention('');
    expect(out).toContain(TASKWRIGHT_MARKERS.begin);
    expect(out).toContain(TASKWRIGHT_MARKERS.end);
    expect(out).toContain('get_active_task');
    expect(out).toContain('request_merge');
    expect(out).toContain(TASKWRIGHT_AGENTS_CONVENTION);
  });

  it('preserves existing AGENTS.md content and appends the block once', () => {
    const existing = '# Contributor guide\n\nRun the tests.\n';
    const out = injectAgentsConvention(existing);
    expect(out.startsWith(existing)).toBe(true);
    expect((out.match(/TASKWRIGHT:BEGIN/g) ?? []).length).toBe(1);
  });

  it('is idempotent', () => {
    const once = injectAgentsConvention('# Doc\n');
    expect(injectAgentsConvention(once)).toBe(once);
  });

  it('is agent-neutral: names each agent-specific MCP registration surface', () => {
    // AGENTS.md is the shared contract for Claude Code AND Codex — the block
    // must not assume Claude-only registration (.mcp.json) or Claude-specific
    // tool syntax.
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('.mcp.json');
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('~/.codex/config.toml');
    expect(TASKWRIGHT_AGENTS_CONVENTION).not.toContain('mcp__');
  });

  it('is a distinct body from the CLAUDE.md convention', () => {
    // The AGENTS.md block leads with the MCP-server framing and the merge close;
    // the CLAUDE.md block does not mention request_merge.
    expect(TASKWRIGHT_AGENTS_CONVENTION).not.toBe(TASKWRIGHT_CONVENTION);
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('request_merge');
    expect(TASKWRIGHT_CONVENTION).not.toContain('request_merge');
  });

  it('stays within the Codex instruction budget by deferring detail to skills', () => {
    // AC#4: AGENTS.md must not inline the detailed workflows — it points at the
    // progressively-disclosed native skills instead, and stays under budget.
    expect(TASKWRIGHT_AGENTS_CONVENTION.length).toBeLessThanOrEqual(
      TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS
    );
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('.agents/skills/');
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('progressively disclosed');
    for (const skill of ['create-task', 'execute-task', 'index-codebase', 'orchestrate-board']) {
      expect(TASKWRIGHT_AGENTS_CONVENTION).toContain(skill);
    }
  });
});
