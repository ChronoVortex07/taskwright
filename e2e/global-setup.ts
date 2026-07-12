import * as fs from 'fs';
import * as path from 'path';

/**
 * Playwright globalSetup: fail fast and loudly if any required `dist/webview/*` file is
 * MISSING, instead of letting the suite run against a half-built extension. (Existence only
 * — it does not detect a stale-but-present build.)
 *
 * `package.json`'s `build` script is `compile:webview && build:css && compile` — only
 * `build:css` emits `dist/webview/styles.css`. A partial build (e.g. someone running just
 * `compile:webview`, or a build that got interrupted) silently omits it. That stylesheet
 * is the ENTIRE height chain for the fixture pages this suite drives
 * (`e2e/webview-fixtures/*.html`): without it `.tree-canvas` collapses to its CSS
 * `min-height: 400px` fallback and several `tree-canvas.spec.ts` assertions fail in a way
 * that is indistinguishable from a real code regression — Chromium reports a missing
 * `<link>` stylesheet as a silent 404 in the page, with nothing surfaced to Playwright.
 * This cost real debugging time once already; this guard exists so it can't happen again
 * without an immediate, actionable error naming exactly what's missing.
 */

const REQUIRED_FILES = [
  'dist/webview/styles.css',
  'dist/webview/tasks.js',
  'dist/webview/tasks.css',
];

export default function globalSetup(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const missing = REQUIRED_FILES.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));

  if (missing.length > 0) {
    throw new Error(
      '\n\n' +
        '=============================================================\n' +
        'Playwright webview e2e suite aborted: dist/webview/ is missing\n' +
        'required built file(s):\n\n' +
        missing.map((f) => `  - ${f}`).join('\n') +
        '\n\n' +
        'These are emitted by `bun run build` (compile:webview && build:css\n' +
        '&& compile) — a partial build (e.g. only `bun run compile:webview`)\n' +
        'silently omits some of them, and the fixture pages this suite loads\n' +
        'depend on ALL of them for correct layout/behavior. Run:\n\n' +
        '  bun run build\n\n' +
        'then re-run the tests.\n' +
        '=============================================================\n'
    );
  }
}
