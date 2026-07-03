import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode, closeVsCode, type VsCodeInstance } from './lib/vscode-launcher';
import { createTestWorkspace, resetTestWorkspace, cleanupTestWorkspace } from './lib/test-workspace';
import { waitForExtensionReady, waitForWebviewContent } from './lib/wait-helpers';
import {
  clickInWebview,
  elementExistsInWebview,
  clearWebviewSessionCache,
  findWebviewByRole,
  evaluateInWebview,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9343;

/**
 * The seeded fixture has all non-bug tasks on the single "Misc" lane (none carry a
 * `category` field and the board config declares no categories), so there is no pair
 * of seeded ids on different lanes to drag between — exactly the case Step 1 of the
 * brief anticipates ("pick two seeded ids that don't [share a lane]"). To exercise the
 * lane -> `category` reslot (the P3b-specific write, routed through TreeFieldService),
 * this test seeds a distinct category onto one task so a second lane exists, then drags
 * a Misc-lane node into it. Seeding mutates only the per-run tmpdir copy (the committed
 * fixture is never touched); it is re-applied inside each test because `resetTestWorkspace`
 * restores the fixture tasks in `beforeEach`.
 */
const SEEDED_TASK = 'TASK-4';
const SEEDED_CATEGORY = 'Platform';
/** A Misc-lane task dragged into the seeded lane; distinct from SEEDED_TASK. */
const DRAG_TASK = 'TASK-1';

function tasksDir(workspacePath: string): string {
  return path.join(workspacePath, 'backlog', 'tasks');
}

/** Find the on-disk task file for `taskId` (by frontmatter id), or undefined. */
function findTaskFile(workspacePath: string, taskId: string): string | undefined {
  const dir = tasksDir(workspacePath);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(dir, f);
    const content = fs.readFileSync(p, 'utf-8');
    if (new RegExp(`^id:\\s*${taskId}\\b`, 'm').test(content)) return p;
  }
  return undefined;
}

/**
 * Seed a `category:` field into `taskId`'s frontmatter (per-run tmpdir copy only).
 * Inserted right after the opening `---`; YAML is order-insensitive and the parser
 * reads `fm.category`. Line endings are preserved.
 */
function seedCategory(workspacePath: string, taskId: string, category: string): void {
  const file = findTaskFile(workspacePath, taskId);
  if (!file) throw new Error(`Seed target ${taskId} not found on disk`);
  const raw = fs.readFileSync(file, 'utf-8');
  if (/^category:\s*\S+/m.test(raw)) return; // idempotent
  const updated = raw.replace(/^---(\r?\n)/, (_m, eol) => `---${eol}category: ${category}${eol}`);
  fs.writeFileSync(file, updated, 'utf-8');
}

/** Poll a task file (by id) until its content matches `predicate`. */
async function waitForTaskFile(
  workspacePath: string,
  taskId: string,
  predicate: (content: string) => boolean,
  timeoutMs = 15_000
): Promise<string> {
  const dir = tasksDir(workspacePath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (new RegExp(`^id:\\s*${taskId}\\b`, 'm').test(content) && predicate(content)) return content;
    }
    await sleep(250);
  }
  throw new Error(`Task ${taskId} never satisfied the predicate within ${timeoutMs}ms`);
}

/**
 * Drive a real pointer drag of `sourceId`'s node onto `targetId`'s lane (vertical band),
 * dispatched in the inner webview frame so the Svelte gesture handlers fire.
 *
 * Coordinates are read straight from `getBoundingClientRect()` (already accounting for the
 * pan/zoom surface transform): the drag keeps the source's X (so the milestone band is
 * unchanged) and moves to the target node's centre Y (a different lane), which resolves to
 * a lane-only reslot -> `reslotTask {category}`. The move is stepped past DRAG_THRESHOLD.
 * `setPointerCapture`/`releasePointerCapture` are stubbed because a synthetic `pointerId`
 * is not an active pointer and would otherwise throw (skipping `onReslotDrop`).
 */
async function dragNodeToLane(
  instance: VsCodeInstance,
  sourceId: string,
  targetId: string
): Promise<string> {
  const sessionId = await findWebviewByRole(instance.cdp, 'tasks');
  if (!sessionId) return 'no-session';
  const result = await evaluateInWebview(
    instance.cdp,
    sessionId,
    `
    const src = doc.querySelector('[data-node-id=' + ${JSON.stringify(JSON.stringify(sourceId))} + ']');
    const tgt = doc.querySelector('[data-node-id=' + ${JSON.stringify(JSON.stringify(targetId))} + ']');
    const vpEl = doc.querySelector('.tree-viewport');
    if (!src || !tgt || !vpEl) return 'missing:' + (!!src) + ',' + (!!tgt) + ',' + (!!vpEl);
    // Neutralize pointer capture: a synthetic pointerId isn't an active pointer, so the
    // real capture calls would throw and abort the handlers before the drop resolves.
    vpEl.setPointerCapture = function () {};
    vpEl.releasePointerCapture = function () {};
    const s = src.getBoundingClientRect();
    const t = tgt.getBoundingClientRect();
    const startX = s.left + s.width / 2;
    const startY = s.top + s.height / 2;
    const endX = startX;               // keep the milestone band (lane-only reslot)
    const endY = t.top + t.height / 2; // target lane's row
    const fire = (type, el, x, y) => {
      el.dispatchEvent(new win.PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: win,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: x, clientY: y,
      }));
    };
    fire('pointerdown', src, startX, startY);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      fire('pointermove', vpEl, startX + (endX - startX) * (i / steps), startY + (endY - startY) * (i / steps));
    }
    fire('pointerup', vpEl, endX, endY);
    return 'dropped';
    `
  );
  return typeof result === 'string' ? result : 'unknown';
}

describe('Tree reslot cross-view (CDP)', () => {
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
    // The tree is the default tab and renders status glyphs (not 'TASK-' text) when
    // zoomed out, so force kanban for the readiness signal — same hardening the sibling
    // tree-authoring/tree-popover CDP suites use. The test switches to the tree itself.
    await executeCommand(instance.cdp, 'taskwright.showKanbanView');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('dragging a node to another lane writes the new category to disk', async () => {
    // Seed a second lane so DRAG_TASK (Misc) has somewhere distinct to land, then refresh
    // so the board recomputes and pushes the new lane order to the tree.
    seedCategory(workspacePath, SEEDED_TASK, SEEDED_CATEGORY);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await sleep(500);

    // Switch to the tree tab and confirm the dragged node is on the canvas.
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await sleep(500);
    const nodeShown = await elementExistsInWebview(
      instance.cdp,
      'tasks',
      `[data-testid="tree-node-${DRAG_TASK}"]`
    );
    expect(nodeShown).toBe(true);

    // Drive the reslot. Re-attempt with fresh geometry each pass: the seeded lane may not
    // have propagated to the layout on the first try, and re-dragging is idempotent (a drag
    // once the category is already set is a same-cell no-op). Poll the file between passes.
    let content: string | undefined;
    for (let attempt = 0; attempt < 8 && !content; attempt++) {
      await dragNodeToLane(instance, DRAG_TASK, SEEDED_TASK);
      try {
        content = await waitForTaskFile(
          workspacePath,
          DRAG_TASK,
          (c) => new RegExp(`^category:\\s*${SEEDED_CATEGORY}\\b`, 'm').test(c),
          2000
        );
      } catch {
        // not yet — retry the drag with the latest geometry
      }
    }

    // The category frontmatter landed on disk (reslot -> TreeFieldService.setCategory ran
    // cross-view, from the webview drag through the extension host to the task file).
    expect(content).toBeDefined();
    expect(content!).toMatch(new RegExp(`^category:\\s*${SEEDED_CATEGORY}\\b`, 'm'));
    expect(content!).toMatch(new RegExp(`^id:\\s*${DRAG_TASK}\\b`, 'm'));
  }, 60_000);
});
