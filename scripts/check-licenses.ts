#!/usr/bin/env bun
/**
 * Verify ThirdPartyNotices.txt is up to date with the lockfile. Cross-platform
 * port of check-licenses.sh (no bash). Regenerates the file (via
 * generate-licenses.ts, a clean install in a temp dir) and fails if the
 * committed version differs.
 */
import * as path from 'path';
import { spawnSync } from 'child_process';
import { bunExe, run } from './lib/run';

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOTICES = 'ThirdPartyNotices.txt';

// Regenerate into the working tree.
run(bunExe, [path.join(SCRIPT_DIR, 'generate-licenses.ts')], { cwd: PROJECT_ROOT });

// `git diff --exit-code` returns 1 when the file changed. .gitattributes stores
// the file `eol=lf`, so line endings do not cause a spurious diff on Windows.
const diff = spawnSync('git', ['-C', PROJECT_ROOT, 'diff', '--exit-code', NOTICES], {
  stdio: 'inherit',
});

if (diff.status !== 0) {
  console.error(
    `\n${NOTICES} was stale — a corrected version has been written to\n` +
      `the working tree. Stage and commit it:\n\n` +
      `  git add ${NOTICES}\n`
  );
  process.exit(1);
}

console.log(`${NOTICES} is up to date.`);
