#!/usr/bin/env bun
/**
 * Screenshot generation wrapper. Cross-platform port of screenshots/run.sh (no
 * bash): builds the extension + webviews, then runs the generator. On headless
 * Linux (CI / devcontainer / no DISPLAY) it wraps the generator in xvfb-run with
 * a screen large enough for the 1553x1043 window plus DPI scaling; macOS and
 * Windows use their native display.
 */
import * as path from 'path';
import { bunExe, run, runLaunch } from '../lib/run';
import { shouldUseXvfb, withXvfb } from '../lib/platform';

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const forwardedArgs = process.argv.slice(2);

// Build the extension and webviews first.
console.log('Building extension...');
run(bunExe, ['run', 'build'], { cwd: PROJECT_ROOT });

const base = {
  command: bunExe,
  args: [path.join(SCRIPT_DIR, 'generate.ts'), ...forwardedArgs],
};

const useXvfb = shouldUseXvfb();
if (useXvfb) {
  console.log('Running screenshot generation with virtual display (xvfb)...');
} else {
  console.log('Running screenshot generation...');
}

// Screen must be large enough for the 1553x1043 window + DPI scaling.
runLaunch(withXvfb(base, useXvfb, '-screen 0 3200x2100x24'), { cwd: PROJECT_ROOT });
