import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { fixtureRootMiddleware, fixtureServerPort } from './scripts/lib/fixtureServer';

/**
 * Vite configuration for serving webview test pages
 *
 * This serves the webview HTML files in a standalone browser for Playwright testing.
 * The VS Code API is mocked by e2e/fixtures/vscode-mock.ts.
 *
 * Reference: Nx Console uses a similar pattern
 * https://github.com/nrwl/nx-console/tree/master/apps/generate-ui-v2-e2e
 */

/**
 * The port is derived from THIS checkout (`scripts/lib/fixtureServer.ts`): the primary
 * checkout keeps the documented 5173, while each linked `.worktrees/<branch>` gets its own
 * stable port. Playwright's config derives the same number, so a worktree's suite always
 * talks to that worktree's server — it can no longer silently reuse another tree's server
 * and test another tree's `dist/webview/` (TASK-111).
 */
const port = fixtureServerPort(__dirname);

/** Serves the identity endpoint the Playwright globalSetup guard probes. */
const fixtureRootPlugin = (): Plugin => ({
  name: 'taskwright-fixture-root',
  configureServer(server) {
    server.middlewares.use(fixtureRootMiddleware(__dirname));
  },
});

export default defineConfig({
  root: 'e2e/webview-fixtures',
  publicDir: resolve(__dirname, 'e2e/fixtures'),
  plugins: [fixtureRootPlugin()],
  server: {
    port,
    strictPort: true,
    // Allow serving files from dist/webview for compiled Svelte components
    fs: {
      allow: ['.', resolve(__dirname, 'dist')],
    },
  },
  resolve: {
    alias: {
      // Allow /dist/* imports to resolve to the workspace dist folder
      '/dist': resolve(__dirname, 'dist'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/webview-test'),
  },
});
