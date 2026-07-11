#!/usr/bin/env bun
/**
 * Run CDP cross-view tests, using xvfb-run on headless Linux. Cross-platform
 * port of run-cdp-tests.sh (no bash): on macOS and Windows it runs the tests
 * directly (both have a native display); only headless Linux (CI / devcontainer
 * / no DISPLAY) is wrapped in xvfb-run.
 *
 * The VS Code binary is provisioned by the test launcher itself
 * (src/test/cdp/lib/vscode-launcher.ts): on macOS/Windows it downloads the
 * latest stable build into .vscode-test/ on first run; CI downloads its own
 * linux-x64 binary before invoking vitest.
 */
import { bunExe, runLaunch } from './lib/run';
import { shouldUseXvfb, withXvfb } from './lib/platform';

const base = { command: bunExe, args: ['x', 'vitest', 'run', '--config', 'vitest.cdp.config.ts'] };
const useXvfb = shouldUseXvfb();

if (useXvfb) {
  console.log('Running CDP cross-view tests with virtual display (xvfb)...');
} else {
  console.log('Running CDP cross-view tests...');
}

runLaunch(withXvfb(base, useXvfb, '-screen 0 1920x1080x24'));
