/**
 * Small, dependency-free process runner shared by the TypeScript automation
 * scripts (the ports of the old `scripts/*.sh` wrappers). Uses `spawnSync` with
 * `shell: false` so nothing needs shell quoting and there is no shell to differ
 * between platforms.
 */
import { spawnSync } from 'child_process';
import type { Launch } from './platform';

/**
 * The interpreter running this script — the `bun` executable, cross-platform.
 * Spawning `process.execPath` avoids depending on a `bun`/`bunx` shim being on
 * PATH or on a `.cmd`/`.exe` bin-extension lookup that differs by OS.
 */
export const bunExe = process.execPath;

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command synchronously, inheriting stdio. On a spawn failure (e.g. the
 * command is not installed) it prints an actionable message and exits non-zero;
 * on a non-zero child exit it propagates that exit code. Returns only on
 * success, so callers can chain steps without checking a status each time.
 */
export function run(command: string, args: string[], opts: RunOptions = {}): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.error(
        `\nCommand not found: ${command}\n` +
          `This automation step needs \`${command}\` on PATH. Install it (or run this ` +
          `step on a platform that provides it) and try again.\n`
      );
    } else {
      console.error(`\nFailed to start ${command}: ${err.message}\n`);
    }
    process.exit(1);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    console.error(`\n${command} terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
}

/** Convenience: run a resolved {@link Launch}. */
export function runLaunch(launch: Launch, opts: RunOptions = {}): void {
  run(launch.command, launch.args, opts);
}

/** Run a `bun x <bin> …` invocation via the current bun interpreter. */
export function bunx(bin: string, args: string[], opts: RunOptions = {}): void {
  run(bunExe, ['x', bin, ...args], opts);
}
