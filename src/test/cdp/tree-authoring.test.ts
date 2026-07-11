import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode, closeVsCode, type VsCodeInstance } from './lib/vscode-launcher';
import {
  createTestWorkspace,
  resetTestWorkspace,
  cleanupTestWorkspace,
} from './lib/test-workspace';
import { waitForExtensionReady, waitForWebviewContent } from './lib/wait-helpers';
import {
  clickInWebview,
  typeInWebviewInput,
  elementExistsInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9342;

function tasksDir(workspacePath: string): string {
  return path.join(workspacePath, 'backlog', 'tasks');
}

/** Poll the tasks dir for a file whose content contains `needle`; returns its parsed TASK-id. */
async function waitForTaskContaining(
  workspacePath: string,
  needle: string,
  timeoutMs = 15_000
): Promise<string> {
  const dir = tasksDir(workspacePath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (content.includes(needle)) {
        const idMatch = content.match(/^id:\s*(TASK-[0-9.]+)/m);
        if (idMatch) return idMatch[1];
      }
    }
    await sleep(250);
  }
  throw new Error(`No task file containing "${needle}" within ${timeoutMs}ms`);
}

async function waitForTreeNode(
  instance: VsCodeInstance,
  taskId: string,
  timeoutMs = 10_000
): Promise<void> {
  const selector = `[data-testid="tree-node-${taskId}"]`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await elementExistsInWebview(instance.cdp, 'tasks', selector)) return;
    await sleep(200);
  }
  throw new Error(`Tree node "${selector}" not found within ${timeoutMs}ms`);
}

describe('Tree authoring cross-view (CDP)', () => {
  let instance: VsCodeInstance;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = createTestWorkspace();
    instance = await launchVsCode({ workspacePath, cdpPort: CDP_PORT });
    await waitForExtensionReady(instance.cdp);
    await dismissNotifications(instance.cdp);
  }, 90_000);

  afterAll(async () => {
    if (instance) closeVsCode(instance);
    if (workspacePath) cleanupTestWorkspace(workspacePath);
  }, 15_000);

  beforeEach(async () => {
    clearWebviewSessionCache();
    resetTestWorkspace(workspacePath);
    fs.rmSync(path.join(workspacePath, '.taskwright'), { recursive: true, force: true });
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    // A prior test (or the tree being the default tab) can leave the board on the
    // zoomed-out tree, which renders status glyphs — not task-id text — so the
    // 'TASK-' readiness signal below would never appear. Force kanban first, the
    // same hardening tree-popover.test.ts uses. The create button lives on the
    // always-visible TabBar, so this does not affect what the test exercises.
    await executeCommand(instance.cdp, 'taskwright.showKanbanView');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('creating a task in the form writes the file and adds a tree node', async () => {
    // Open the form via the TabBar + (always visible, any tab).
    const opened = await clickInWebview(instance.cdp, 'tasks', '[data-testid="action-create"]');
    expect(opened).toBe(true);
    // The form is {#if}-mounted at root; give the reactive mount a beat to settle.
    await sleep(150);
    const formShown = await elementExistsInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="create-form"]'
    );
    expect(formShown).toBe(true);

    const typed = await typeInWebviewInput(
      instance.cdp,
      'tasks',
      '[data-testid="cf-title"]',
      'CDP authoring task',
      { clearFirst: true }
    );
    expect(typed).toBe(true);
    const created = await clickInWebview(instance.cdp, 'tasks', '[data-testid="cf-submit"]');
    expect(created).toBe(true);

    // File written to disk (the parity core ran through BacklogWriter.createTask).
    const newId = await waitForTaskContaining(workspacePath, 'CDP authoring task');
    expect(newId).toMatch(/^TASK-\d+$/);

    // Node appears on the tree (board refreshed cross-view).
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await waitForTreeNode(instance, newId);
  }, 60_000);
});
