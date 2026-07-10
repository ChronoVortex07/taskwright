import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  writeCancellationMarker,
  cancellationMarkerPath,
  isCancelled,
} from '../../core/cancellationMarker';
import { activeTaskPath } from '../../core/activeTask';
import type { BacklogParser } from '../../core/BacklogParser';
import type { Task } from '../../core/types';

// Mutable dispatch settings so a single harness can drive both the no-worktree
// opt-out (default) and the with-worktree path. Defaults to worktree-OFF so the
// GAP-3 tests below seed into the repo root (the temp dir) with no git.
const settings = vi.hoisted(() => ({ createWorktree: false, agent: '', template: '' }));
vi.mock('../../config', () => ({
  getTaskwrightConfig: (key: string, dflt: unknown) => {
    if (key === 'dispatchCreateWorktree') return settings.createWorktree;
    if (key === 'dispatchAgent') return settings.agent || dflt;
    if (key === 'dispatchTemplate') return settings.template || dflt;
    return dflt;
  },
}));

// Deterministic worktree creation for the with-worktree branch (no real git needed).
vi.mock('../../core/GitBranchService', () => ({
  GitBranchService: class {
    async isGitRepository() {
      return true;
    }
  },
}));
vi.mock('../../core/WorktreeService', () => ({
  createWorktree: vi.fn(async (repoRoot: string, branch: string) => ({
    path: path.join(repoRoot, '.worktrees', branch),
    branch,
  })),
}));

// Imported AFTER the mock so dispatchActions picks up the mocked config.
import { dispatchTask } from '../../providers/dispatchActions';
import * as vscodeMock from 'vscode';

let root: string, backlogPath: string;
beforeEach(() => {
  settings.createWorktree = false; // reset per-test
  settings.agent = '';
  settings.template = '';
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-dispatch-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(backlogPath, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal parser: getTask returns the task; getBacklogPath sets the session root.
 *  loadTreeStateFromParser calls other getters and THROWS on this stub — dispatchTask's
 *  gate is wrapped in a fail-open try/catch, so dispatch proceeds regardless. */
function stubParser(task: Task): BacklogParser {
  return {
    getTask: async () => task,
    getBacklogPath: () => backlogPath,
  } as unknown as BacklogParser;
}
const makeTask = (): Task =>
  ({
    id: 'TASK-7',
    title: 'Thing',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: path.join(backlogPath, 'tasks', 'task-7 - Thing.md'),
  }) as Task;

describe('dispatchTask — clears a stale cancellation marker on seed (GAP-3)', () => {
  it('removes a pre-existing .taskwright/cancelled and seeds the active task', async () => {
    // A leftover marker from a prior (leaked) cancel at the session root.
    writeCancellationMarker(root, 'TASK-7');
    expect(isCancelled(root)).toBe(true);

    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(result!.sessionRoot).toBe(root); // no worktree → repo root

    expect(fs.existsSync(cancellationMarkerPath(root))).toBe(false); // stale marker cleared
    expect(fs.existsSync(activeTaskPath(root))).toBe(true); // active task seeded
  });

  it('positive control: a dispatch with no prior marker leaves none', async () => {
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(isCancelled(root)).toBe(false);
  });
});

describe('dispatchTask — no-worktree dispatch prepends a coherence NOTE (FIX 2)', () => {
  const NOTE_MARK = 'No isolated worktree was created';

  it('prepends the NOTE (and warns) when no worktree is created', async () => {
    settings.createWorktree = false; // opt-out → sessionRoot = repo root, worktreePath undefined
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(result!.worktreePath).toBeUndefined();

    // The clipboard, the returned prompt, and the handoff all carry the NOTE.
    expect(result!.prompt).toContain(NOTE_MARK);
    expect(result!.prompt).toContain('Do NOT run the `/execute-task` skill');
    const clipped = vi.mocked(vscodeMock.env.clipboard.writeText).mock.calls[0][0] as string;
    expect(clipped).toContain(NOTE_MARK);
    expect(fs.readFileSync(result!.handoffFile, 'utf-8')).toContain(NOTE_MARK);

    // The human is warned to the same effect.
    const warned = vi
      .mocked(vscodeMock.window.showWarningMessage)
      .mock.calls.some((c) => String(c[0]).includes('without an isolated worktree'));
    expect(warned).toBe(true);
  });

  it('does NOT prepend the NOTE when a worktree is created', async () => {
    settings.createWorktree = true; // GitBranchService + createWorktree mocks → worktreePath set
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(result!.worktreePath).toBe(path.join(root, '.worktrees', 'task-7-thing'));

    expect(result!.prompt).not.toContain(NOTE_MARK);
    expect(fs.readFileSync(result!.handoffFile, 'utf-8')).not.toContain(NOTE_MARK);
    const warned = vi
      .mocked(vscodeMock.window.showWarningMessage)
      .mock.calls.some((c) => String(c[0]).includes('without an isolated worktree'));
    expect(warned).toBe(false);
  });
});

describe('dispatchTask — per-agent dispatch profiles (TASK-93)', () => {
  it('defaults to the Claude Code profile', async () => {
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result!.prompt).toContain('Claude Code session');
    expect(result!.prompt).not.toMatch(/\bCodex\b/);
  });

  it('renders the Codex profile when taskwright.dispatchAgent is codex', async () => {
    settings.agent = 'codex';
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result!.prompt).toContain('Codex session');
    expect(result!.prompt).not.toMatch(/\bClaude\b/);
    // The workflow contract is agent-independent.
    expect(result!.prompt).toContain('/execute-task');
    expect(result!.prompt).toContain('request_merge');
  });

  it('a custom taskwright.dispatchTemplate wins untouched, regardless of agent', async () => {
    settings.createWorktree = true; // with a worktree, no NOTE is prepended
    settings.agent = 'codex';
    settings.template = 'Custom template for {{id}}';
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result!.prompt).toBe('Custom template for TASK-7');
  });

  it('falls back to the Claude profile on an unknown agent id', async () => {
    settings.agent = 'copilot';
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result!.prompt).toContain('Claude Code session');
  });
});
