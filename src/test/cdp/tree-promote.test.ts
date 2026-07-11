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
  elementExistsInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9344;

function draftsDir(w: string): string {
  return path.join(w, 'backlog', 'drafts');
}
function tasksDir(w: string): string {
  return path.join(w, 'backlog', 'tasks');
}

/** Seed two linked drafts (DRAFT-2 depends on DRAFT-1) into the per-run tmpdir copy. */
function seedLinkedDrafts(w: string): void {
  fs.mkdirSync(draftsDir(w), { recursive: true });
  fs.writeFileSync(
    path.join(draftsDir(w), 'draft-1 - Base-proposal.md'),
    `---\nid: DRAFT-1\ntitle: Base proposal\nstatus: Draft\nassignee: []\ndependencies: []\ncategory: Features\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(draftsDir(w), 'draft-2 - Uses-base.md'),
    `---\nid: DRAFT-2\ntitle: Uses base\nstatus: Draft\nassignee: []\ndependencies:\n  - DRAFT-1\ncategory: Features\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}

function readById(dir: string, id: string): string | undefined {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.md')) continue;
    const c = fs.readFileSync(path.join(dir, f), 'utf-8');
    if (new RegExp(`^id:\\s*${id}\\b`, 'm').test(c)) return c;
  }
  return undefined;
}

async function waitFor(fn: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}

describe('Tree promote-all cross-view (CDP)', () => {
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
    fs.rmSync(draftsDir(workspacePath), { recursive: true, force: true }); // clean drafts each run
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await executeCommand(instance.cdp, 'taskwright.showKanbanView'); // readiness signal
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('promote-all lands linked drafts in tasks/ with rewired dependencies', async () => {
    seedLinkedDrafts(workspacePath);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await sleep(500);

    // Switch to the tree; the seeded drafts render as proposed nodes.
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await sleep(500);

    // Drafts are unioned into the tree payload only when the extension's viewMode is 'tree'
    // (TasksController). The beforeEach forces kanban for the readiness signal; the tab click
    // above flips viewMode to 'tree' but does not itself reload the board. Re-derive now so the
    // seeded drafts surface on the canvas — this mirrors the default-tree production flow, where
    // the initial tree-mode load unions drafts. (getDrafts() re-reads the folder each call.)
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await sleep(750);
    expect(
      await elementExistsInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-DRAFT-1"]')
    ).toBe(true);
    expect(
      await elementExistsInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-DRAFT-2"]')
    ).toBe(true);

    // Promote all proposed → ONE promoteDrafts message → the bulk core runs cross-view.
    const clicked = await clickInWebview(instance.cdp, 'tasks', '[data-testid="tree-promote-all"]');
    expect(clicked).toBe(true);

    // Both drafts left drafts/ and landed in tasks/, with the intra-set edge rewired.
    const landed = await waitFor(() => {
      const d1 = readById(draftsDir(workspacePath), 'DRAFT-1');
      const d2 = readById(draftsDir(workspacePath), 'DRAFT-2');
      const usesBase = readById(tasksDir(workspacePath), 'TASK-'); // any promoted task
      return !d1 && !d2 && !!usesBase;
    }, 20_000);
    expect(landed).toBe(true);

    // The dependent's dependency was remapped to the promoted TASK id (no DRAFT left).
    const usesBaseFile = fs
      .readdirSync(tasksDir(workspacePath))
      .map((f) => fs.readFileSync(path.join(tasksDir(workspacePath), f), 'utf-8'))
      .find((c) => /title:\s*Uses base/.test(c));
    expect(usesBaseFile).toBeDefined();
    expect(usesBaseFile!).toMatch(/- TASK-\d+/);
    expect(usesBaseFile!).not.toMatch(/DRAFT-/);
  }, 60_000);
});
