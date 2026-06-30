import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards that the two agent-setup commands have clearly distinct, descriptive
 * titles so users can tell which to run (TASK-3). One sets up the optional
 * Backlog.md CLI (runs `backlog init`); the other registers the Taskwright MCP
 * server with Claude Code and injects the CLAUDE.md convention. Their titles
 * used to be "Set Up Agent Integration" vs "Set Up Claude Code Integration",
 * which read as near-duplicates.
 */
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
const commands = pkg.contributes.commands as Array<{ command: string; title: string }>;
const titleOf = (id: string): string | undefined => commands.find((c) => c.command === id)?.title;

describe('agent-setup command titles', () => {
  const agentTitle = titleOf('taskwright.setupAgentIntegration');
  const claudeTitle = titleOf('taskwright.setupClaudeIntegration');

  it('contributes both setup commands', () => {
    expect(agentTitle).toBeTypeOf('string');
    expect(claudeTitle).toBeTypeOf('string');
  });

  it('titles the Backlog.md CLI command after the Backlog.md CLI', () => {
    expect(agentTitle).toMatch(/Backlog\.md/);
    // It must not read as the generic "Agent Integration" that collided with
    // the Claude Code command.
    expect(agentTitle).not.toMatch(/Agent Integration/);
  });

  it('titles the Claude Code command after Claude Code', () => {
    expect(claudeTitle).toMatch(/Claude Code/);
  });

  it('keeps the two titles unambiguously distinct', () => {
    expect(agentTitle).not.toBe(claudeTitle);
    // Neither title should bleed into the other's domain.
    expect(agentTitle).not.toMatch(/Claude/);
    expect(claudeTitle).not.toMatch(/Backlog/);
  });
});
