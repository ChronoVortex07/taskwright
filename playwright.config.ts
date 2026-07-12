import { defineConfig, devices } from '@playwright/test';
import { fixtureServerPort } from './scripts/lib/fixtureServer';

/**
 * Playwright configuration for webview E2E tests
 *
 * These tests verify webview UI functionality in isolation using a mocked
 * VS Code API, similar to how Cypress tests worked but with Playwright's
 * native drag-drop support and better ecosystem alignment with Svelte.
 *
 * Reference: https://playwright.dev/docs/test-configuration
 */

/**
 * Derived from THIS checkout, exactly as `vite.config.ts` derives it: the primary checkout
 * keeps 5173, each linked `.worktrees/<branch>` gets its own stable port. With a fixed port,
 * `reuseExistingServer` silently consumed a fixture server started in ANOTHER worktree — and
 * that server serves that tree's `dist/webview/`, so the suite tested a build that was never
 * under test (TASK-111). A per-tree port removes the collision; `e2e/global-setup.ts` still
 * verifies the server's identity in case something else grabs the port.
 */
const fixturePort = fixtureServerPort(__dirname);
const fixtureBaseURL = `http://localhost:${fixturePort}`;

export default defineConfig({
  testDir: './e2e',
  // Fails fast with a clear message if a required dist/webview/* file is missing, OR if the
  // fixture server we are about to talk to belongs to a different worktree (see
  // e2e/global-setup.ts).
  globalSetup: require.resolve('./e2e/global-setup.ts'),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? '50%' : undefined,

  reporter: process.env.CI ? 'github' : 'list',

  use: {
    // Base URL for webview test pages served by Vite (tree-derived port)
    baseURL: fixtureBaseURL,

    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Match VS Code sidebar/panel dimensions
    viewport: { width: 400, height: 600 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Web server configuration - serves the webview test pages
  webServer: {
    // Use vite.config.ts which serves e2e/webview-fixtures with compiled Svelte bundles.
    // It derives the SAME tree-unique port from its own __dirname, so this never has to
    // pass one through.
    command: 'bun run vite',
    url: fixtureBaseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },

  // Global timeout settings
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
});
