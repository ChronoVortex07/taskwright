import * as path from 'path';

import {
  assertFixtureServerServesTree,
  fixtureServerPort,
  missingBundlesMessage,
  missingRequiredBundles,
} from '../scripts/lib/fixtureServer';

/**
 * Playwright globalSetup: refuse to run the webview suite against the WRONG BUILD.
 *
 * Two ways that used to happen silently — both cost real debugging time, both are now loud:
 *
 *  1. **A half-built `dist/`.** `package.json`'s `build` script is
 *     `compile:webview && build:css && compile` — only `build:css` emits
 *     `dist/webview/styles.css`. A partial build silently omits it, and that stylesheet is the
 *     ENTIRE height chain for the fixture pages this suite drives (`e2e/webview-fixtures/*.html`):
 *     without it `.tree-canvas` collapses to its CSS `min-height: 400px` fallback and several
 *     `tree-canvas.spec.ts` assertions fail indistinguishably from a real code regression
 *     (Chromium reports a missing `<link>` stylesheet as a silent 404, with nothing surfaced to
 *     Playwright). Guarded by an existence check on every required bundle.
 *
 *  2. **Another worktree's fixture server** (TASK-111). `reuseExistingServer: !CI` on a fixed
 *     port meant a Vite server already running in a *different* worktree got silently reused —
 *     serving *that* tree's `dist/webview/`. The port is now derived per checkout
 *     (`fixtureServerPort`), so trees cannot collide; this guard is the backstop for anything
 *     that still ends up on our port (a hash collision, a stale server, an unrelated process):
 *     the server must identify itself as THIS tree or the run aborts, naming both trees.
 *
 * Playwright starts `webServer` BEFORE `globalSetup` (plugin setup tasks precede global setup),
 * so by the time we probe, the server we are about to test against — freshly started or reused —
 * is the one answering. A port with nothing listening is not an error here.
 */
export default async function globalSetup(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');

  const missing = missingRequiredBundles(repoRoot);
  if (missing.length > 0) {
    throw new Error(missingBundlesMessage(missing));
  }

  await assertFixtureServerServesTree({
    rootDir: repoRoot,
    port: fixtureServerPort(repoRoot),
  });
}
