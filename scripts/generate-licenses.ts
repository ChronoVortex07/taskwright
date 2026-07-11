#!/usr/bin/env bun
/**
 * Regenerate ThirdPartyNotices.txt. Cross-platform port of the old
 * generate-licenses.sh (no bash / mktemp / trap — runs the same on Windows,
 * macOS, and Linux under `bun`).
 *
 * Installs dependencies in a fresh temp dir rather than using the working-copy
 * node_modules. `bun install` doesn't prune orphaned directories when the
 * dependency graph shrinks (https://github.com/oven-sh/bun/issues/3605), and
 * `generate-license-file` follows Node's nearest-ancestor resolution — so an
 * orphaned nested copy on disk can shadow the real top-level version and get
 * recorded in the notices instead. A clean install sidesteps this. With bun's
 * shared cache this adds ~2s.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bunExe, run, bunx } from './lib/run';

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOTICES = 'ThirdPartyNotices.txt';

// Files a clean `bun install` in the temp dir needs.
const SEED_FILES = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  '.generate-license-file.config.json',
];

function main(): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-licenses-'));
  try {
    for (const file of SEED_FILES) {
      fs.copyFileSync(path.join(PROJECT_ROOT, file), path.join(workDir, file));
    }

    run(bunExe, ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: workDir });

    bunx(
      'generate-license-file',
      [
        '--input',
        'package.json',
        '--output',
        NOTICES,
        '--config',
        '.generate-license-file.config.json',
        '--overwrite',
        '--ci',
      ],
      { cwd: workDir }
    );

    // Append the Lucide notice (icons are copied inline, not an npm dependency,
    // so generate-license-file can't discover them). Normalize to LF so the
    // committed file is byte-identical across platforms — .gitattributes stores
    // it `eol=lf`, and `licenses:check` diffs it.
    const notice = fs.readFileSync(path.join(SCRIPT_DIR, 'licenses', 'lucide-notice.txt'), 'utf8');
    const generated = fs.readFileSync(path.join(workDir, NOTICES), 'utf8');
    const combined = (generated + notice).replace(/\r\n/g, '\n');
    fs.writeFileSync(path.join(PROJECT_ROOT, NOTICES), combined);

    console.log(`Generated ${NOTICES}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
