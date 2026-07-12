import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * TASK-109. VS Code resolves a `workspaceContains:` pattern one of two ways:
 *
 *  - no glob metacharacters  → a direct file `stat` (cheap, one syscall);
 *  - any glob metacharacter  → a workspace SEARCH through the search service,
 *                              which walks the tree before it can even decide
 *                              whether to activate us.
 *
 * Taskwright used seven recursive-wildcard `backlog/...` globs, so every window
 * open paid for a workspace search — and Taskwright was the LAST eager extension
 * to activate,
 * gating the "Eager extensions activated" milestone (and therefore every
 * `onStartupFinished` extension queued behind it).
 *
 * Anything not covered by the cheap stat paths still activates lazily when the
 * board view opens (`onView:taskwright.kanban`, which VS Code derives from the
 * contributed webview views).
 */
describe('activation events', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')
  ) as { activationEvents: string[]; contributes: { views: Record<string, { id: string }[]> } };

  const GLOB_CHARS = /[*?[\]{}]/;

  it('declares no glob activation event (a glob forces a workspace search at startup)', () => {
    const globs = pkg.activationEvents.filter((e) => GLOB_CHARS.test(e));
    expect(globs).toEqual([]);
  });

  it('still activates cheaply on the standard board layouts via a plain file stat', () => {
    expect(pkg.activationEvents).toContain('workspaceContains:backlog/config.yml');
    expect(pkg.activationEvents).toContain('workspaceContains:.backlog/config.yml');
  });

  it('keeps the lazy view fallback for layouts the stat paths do not cover', () => {
    // A nested/unusual backlog root no longer eager-activates; opening the board
    // view does. VS Code synthesizes onView activation from the contributed view.
    const ids = pkg.contributes.views.taskwright.map((v) => v.id);
    expect(ids).toContain('taskwright.kanban');
  });
});
