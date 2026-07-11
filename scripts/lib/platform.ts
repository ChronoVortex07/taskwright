/**
 * Cross-platform helpers shared by the repo's automation scripts (the TypeScript
 * ports of the old bash wrappers in `scripts/*.sh`). These are pure functions —
 * platform + environment in, decision out — so the platform branching is
 * unit-testable without spawning anything or depending on the host OS.
 */

export type NodePlatform = NodeJS.Platform;

/**
 * Whether a display-dependent command (VS Code e2e, CDP cross-view tests,
 * screenshot generation) must be wrapped in `xvfb-run`.
 *
 * `xvfb-run` provides a virtual X server and only exists on Linux. macOS and
 * Windows have a native display server and never use it. On Linux we only need
 * it when there is no real display: in CI, in a devcontainer, or when `DISPLAY`
 * is unset. This mirrors the detection the old bash wrappers did with `uname`
 * and the `$CI` / `$DEVCONTAINER` / `$DISPLAY` environment variables — but
 * correctly treats Windows (where `uname` under Git Bash reports `MINGW*`, which
 * the old `[ "$(uname)" != "Darwin" ]` check wrongly funnelled into xvfb).
 */
export function shouldUseXvfb(
  platform: NodePlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (platform !== 'linux') return false;
  return Boolean(env.DEVCONTAINER || env.CI || !env.DISPLAY);
}

export interface Launch {
  command: string;
  args: string[];
}

/**
 * Wrap a launch in `xvfb-run` when `useXvfb` is set; otherwise return it
 * unchanged. `serverArgs` (e.g. `"-screen 0 1920x1080x24"`) is passed to Xvfb as
 * a single `--server-args=<value>` token, so the value's spaces need no shell
 * quoting — the returned `{ command, args }` is meant to be handed to
 * `spawnSync` with `shell: false`.
 */
export function withXvfb(launch: Launch, useXvfb: boolean, serverArgs?: string): Launch {
  if (!useXvfb) return launch;
  const xvfbArgs = ['-a'];
  if (serverArgs) xvfbArgs.push(`--server-args=${serverArgs}`);
  return { command: 'xvfb-run', args: [...xvfbArgs, launch.command, ...launch.args] };
}

/**
 * Human-readable platform name for diagnostics / actionable errors.
 */
export function platformLabel(platform: NodePlatform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}
