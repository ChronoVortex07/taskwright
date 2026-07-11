/**
 * Markdown link sanitization E2E tests (TASK-99)
 *
 * Verifies the webview-side defense-in-depth guard: even if a rendered anchor
 * carrying a dangerous URL scheme reaches the DOM, clicking it must NOT navigate
 * or execute, and must NOT be treated as a workspace-file open. Safe
 * workspace-relative and external links keep their expected activation behavior.
 *
 * (The primary sanitization runs provider-side in parseMarkdown — covered by the
 * unit tests. This spec exercises link *activation* in a real browser.)
 */
import { test, expect, type Page } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getPostedMessages,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { BacklogDocument } from '../src/webview/lib/types';

const doc: BacklogDocument = {
  id: 'doc-1',
  title: 'Sanitization Doc',
  type: 'other',
  tags: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  content: '',
  filePath: '/test/docs/doc-1.md',
};

async function setup(page: Page): Promise<void> {
  await installVsCodeMock(page);
  await page.goto('/content-detail.html');
  await page.waitForTimeout(100);
}

async function injectBody(page: Page, contentHtml: string): Promise<void> {
  await postMessageToWebview(page, { type: 'documentData', document: doc, contentHtml });
  await page.waitForTimeout(100);
}

test.describe('Markdown link sanitization (link activation)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('clicking a javascript: link neither executes nor opens a workspace file', async ({
    page,
  }) => {
    await injectBody(
      page,
      '<p><a href="javascript:window.__xssFired = true" data-testid="evil-link">evil</a></p>'
    );
    await page.evaluate(() => {
      (window as unknown as { __xssFired: boolean }).__xssFired = false;
    });
    await clearPostedMessages(page);

    await page.locator('[data-testid="evil-link"]').click();
    await page.waitForTimeout(50);

    const fired = await page.evaluate(
      () => (window as unknown as { __xssFired: boolean }).__xssFired
    );
    expect(fired).toBe(false);

    const messages = await getPostedMessages(page);
    expect(messages.find((m) => m.type === 'openWorkspaceFile')).toBeUndefined();
  });

  test('clicking an entity-encoded javascript: link does not execute', async ({ page }) => {
    // The browser decodes &#115; to 's' when parsing the attribute, so getAttribute
    // returns a real javascript: href — the guard must still block it.
    await injectBody(
      page,
      '<p><a href="java&#115;cript:window.__xssFired2 = true" data-testid="evil2">evil2</a></p>'
    );
    await page.evaluate(() => {
      (window as unknown as { __xssFired2: boolean }).__xssFired2 = false;
    });
    await clearPostedMessages(page);

    await page.locator('[data-testid="evil2"]').click();
    await page.waitForTimeout(50);

    const fired = await page.evaluate(
      () => (window as unknown as { __xssFired2: boolean }).__xssFired2
    );
    expect(fired).toBe(false);
  });

  test('clicking a workspace-relative link opens it via openWorkspaceFile', async ({ page }) => {
    await injectBody(
      page,
      '<p><a href="../docs/spec.md#L10" data-testid="rel-link">spec</a></p>'
    );
    await clearPostedMessages(page);

    await page.locator('[data-testid="rel-link"]').click();
    await page.waitForTimeout(50);

    const messages = await getPostedMessages(page);
    const msg = messages.find((m) => m.type === 'openWorkspaceFile');
    expect(msg).toBeDefined();
    expect(msg).toMatchObject({
      type: 'openWorkspaceFile',
      relativePath: '../docs/spec.md',
      fragment: 'L10',
    });
  });

  test('clicking a safe external https link does not post an openWorkspaceFile message', async ({
    page,
  }) => {
    await injectBody(
      page,
      '<p><a href="https://example.com/" data-testid="ext-link">ext</a></p>'
    );
    await clearPostedMessages(page);

    await page.locator('[data-testid="ext-link"]').click();
    await page.waitForTimeout(50);

    // Safe external links use the anchor's default navigation, not a workspace-open.
    const messages = await getPostedMessages(page);
    expect(messages.find((m) => m.type === 'openWorkspaceFile')).toBeUndefined();
  });
});
