import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TASKWRIGHT_MCP_INSTRUCTIONS } from '../../mcp/instructions';

/**
 * TASK-133. `complete_task` moves a task file into `backlog/completed/`, which takes it out of
 * the board's records entirely. Nothing needs that: `request_merge` already marks a merged task
 * **Done** and leaves it in `tasks/`, where it stays visible. So the only thing the surface did
 * was make finished work vanish — one tool call (or one click) away from any agent or human. The
 * agent instructions even had to carry a "do not call complete_task" warning to defend against a
 * tool we ourselves exposed, which is the tell that the surface shouldn't exist.
 *
 * Dewire the SURFACES, keep the MACHINERY. `BacklogWriter.completeTask()` and
 * `completeTaskHandler` stay exactly where they are (with their tests), so when TASK-131 decides
 * the real Done-vs-Completed archival semantics, re-wiring is a re-registration — not a rewrite.
 */
describe('complete_task is dewired (TASK-133)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const src = (...p: string[]): string => fs.readFileSync(path.join(repoRoot, ...p), 'utf-8');

  describe('no reachable entry point', () => {
    it('the MCP server does not register a complete_task tool', () => {
      const server = src('src', 'mcp', 'server.ts');

      expect(server).not.toContain("'complete_task'");
      expect(server).not.toContain('completeTaskHandler');
    });

    it('TasksController handles no completeTask webview message', () => {
      const controller = src('src', 'providers', 'TasksController.ts');

      expect(controller).not.toContain("case 'completeTask'");
      expect(controller).not.toContain('writer.completeTask');
    });

    it('the webview message union has no completeTask variant to send', () => {
      const types = src('src', 'core', 'types.ts');

      expect(types).not.toContain("type: 'completeTask'");
    });

    it('no webview component dispatches completeTask', () => {
      const webviewDir = path.join(repoRoot, 'src', 'webview');
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(svelte|ts)$/.test(entry.name)) {
            if (fs.readFileSync(full, 'utf-8').includes('completeTask')) {
              offenders.push(path.relative(repoRoot, full));
            }
          }
        }
      };
      walk(webviewDir);

      expect(offenders).toEqual([]);
    });
  });

  describe('agent-facing text does not warn about a tool that does not exist', () => {
    it('the MCP instructions drop the "Do not call complete_task" warning', () => {
      expect(TASKWRIGHT_MCP_INSTRUCTIONS).not.toContain('complete_task');
    });

    it('still keeps the close path and the manual-merge warning it actually needs', () => {
      expect(TASKWRIGHT_MCP_INSTRUCTIONS).toContain('request_merge');
      expect(TASKWRIGHT_MCP_INSTRUCTIONS).toContain('do not merge from the primary checkout');
    });

    it.each([
      ['AGENTS.md', ['AGENTS.md']],
      ['CLAUDE.md', ['CLAUDE.md']],
      ['execute-task SKILL.md', ['.claude', 'skills', 'execute-task', 'SKILL.md']],
    ])('%s does not instruct agents around complete_task', (_name, parts) => {
      expect(src(...parts)).not.toContain('complete_task');
    });
  });

  describe('the machinery is preserved for a future re-wire', () => {
    it('BacklogWriter.completeTask() is left intact', () => {
      expect(src('src', 'core', 'BacklogWriter.ts')).toContain('async completeTask(');
    });

    it('completeTaskHandler is left intact and exported', () => {
      expect(src('src', 'mcp', 'handlers.ts')).toContain(
        'export async function completeTaskHandler'
      );
    });
  });
});
