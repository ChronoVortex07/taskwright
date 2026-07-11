#!/usr/bin/env bun
/**
 * Run the VS Code extension e2e smoke tests. Cross-platform port of run-e2e.sh
 * (no bash): packaging, VS Code / chromedriver provisioning, and vsix install
 * run directly on every platform; only the test run launches VS Code and needs
 * a display, so it is wrapped in xvfb-run on headless Linux (CI / devcontainer /
 * no DISPLAY). macOS and Windows run it against their native display.
 */
import * as fs from 'fs';
import * as path from 'path';
import { bunExe, bunx, runLaunch } from './lib/run';
import { shouldUseXvfb, withXvfb } from './lib/platform';

const SCRIPT_DIR = __dirname;

// Project-local resources dir avoids macOS temp-folder quarantine issues.
const STORAGE_PATH = '.vscode-test';
// Isolated extensions dir so other installed extensions (e.g. GitLens) don't steal focus.
const EXTENSIONS_DIR = path.join(STORAGE_PATH, 'test-extensions');
const VSIX_FILE = path.join(STORAGE_PATH, 'test-extension.vsix');

// vsce is pinned so bunx cache drift doesn't leave contributors on stale,
// differently-warning builds. We package ourselves with --no-dependencies
// because vsce's default `npm list --production` fails against bun-managed
// node_modules.
const VSCE_VERSION = '3.9.1';

// User settings injected into the VS Code test instance — notably
// workbench.welcomePage.experimentalOnboarding=false, which suppresses the
// 1.116+ sign-in onboarding overlay that otherwise intercepts activity-bar
// clicks and fails the tests.
const CODE_SETTINGS = path.join(SCRIPT_DIR, 'e2e-vscode-settings.json');

fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

bunx(`@vscode/vsce@${VSCE_VERSION}`, ['package', '--no-dependencies', '-o', VSIX_FILE]);

// Setup (no display needed) — provision VS Code + chromedriver, install the vsix.
bunx('extest', ['get-vscode', '--storage', STORAGE_PATH]);
bunx('extest', ['get-chromedriver', '--storage', STORAGE_PATH]);
bunx('extest', [
  'install-vsix',
  '--vsix_file',
  VSIX_FILE,
  '--storage',
  STORAGE_PATH,
  '--extensions_dir',
  EXTENSIONS_DIR,
]);

// The test run launches VS Code → needs a display.
const runBase = {
  command: bunExe,
  args: [
    'x',
    'extest',
    'run-tests',
    'out/test/e2e/*.test.js',
    '--mocha_config',
    '.mocharc.json',
    '--storage',
    STORAGE_PATH,
    '--extensions_dir',
    EXTENSIONS_DIR,
    '--code_settings',
    CODE_SETTINGS,
  ],
};

const useXvfb = shouldUseXvfb();
console.log(useXvfb ? 'Running e2e tests with virtual display (xvfb)...' : 'Running e2e tests...');
runLaunch(withXvfb(runBase, useXvfb));
