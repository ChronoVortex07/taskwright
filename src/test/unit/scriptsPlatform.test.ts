import { describe, it, expect } from 'vitest';
import { shouldUseXvfb, withXvfb, platformLabel } from '../../../scripts/lib/platform';

describe('scripts/lib/platform — shouldUseXvfb', () => {
  it('never uses xvfb on Windows, regardless of env', () => {
    expect(shouldUseXvfb('win32', {})).toBe(false);
    expect(shouldUseXvfb('win32', { CI: 'true' })).toBe(false);
    expect(shouldUseXvfb('win32', { DEVCONTAINER: '1' })).toBe(false);
    // Git Bash reports uname MINGW*; the OLD bash check wrongly enabled xvfb here.
    expect(shouldUseXvfb('win32', { CI: '1', DISPLAY: '' })).toBe(false);
  });

  it('never uses xvfb on macOS', () => {
    expect(shouldUseXvfb('darwin', {})).toBe(false);
    expect(shouldUseXvfb('darwin', { CI: 'true' })).toBe(false);
    expect(shouldUseXvfb('darwin', { DISPLAY: '' })).toBe(false);
  });

  it('uses xvfb on headless Linux (CI / devcontainer / no DISPLAY)', () => {
    expect(shouldUseXvfb('linux', { CI: 'true' })).toBe(true);
    expect(shouldUseXvfb('linux', { DEVCONTAINER: '1' })).toBe(true);
    expect(shouldUseXvfb('linux', {})).toBe(true); // DISPLAY unset
    expect(shouldUseXvfb('linux', { DISPLAY: '' })).toBe(true); // DISPLAY empty
  });

  it('does NOT use xvfb on Linux with a real display and no CI markers', () => {
    expect(shouldUseXvfb('linux', { DISPLAY: ':0' })).toBe(false);
  });

  it('a real DISPLAY does not override CI/devcontainer markers', () => {
    // Matches the old wrapper: any of DEVCONTAINER/CI/(no DISPLAY) forces xvfb.
    expect(shouldUseXvfb('linux', { DISPLAY: ':0', CI: 'true' })).toBe(true);
    expect(shouldUseXvfb('linux', { DISPLAY: ':0', DEVCONTAINER: '1' })).toBe(true);
  });
});

describe('scripts/lib/platform — withXvfb', () => {
  it('returns the launch unchanged when xvfb is not needed', () => {
    const launch = { command: 'bun', args: ['x', 'vitest', 'run'] };
    expect(withXvfb(launch, false)).toEqual(launch);
    expect(withXvfb(launch, false, '-screen 0 1920x1080x24')).toEqual(launch);
  });

  it('wraps the launch in xvfb-run when needed (no server args)', () => {
    const launch = { command: 'bun', args: ['x', 'extest', 'run-tests'] };
    expect(withXvfb(launch, true)).toEqual({
      command: 'xvfb-run',
      args: ['-a', 'bun', 'x', 'extest', 'run-tests'],
    });
  });

  it('passes server args as a single --server-args token (no shell quoting)', () => {
    const launch = { command: 'bun', args: ['scripts/screenshots/generate.ts'] };
    const wrapped = withXvfb(launch, true, '-screen 0 3200x2100x24');
    expect(wrapped.command).toBe('xvfb-run');
    expect(wrapped.args).toEqual([
      '-a',
      '--server-args=-screen 0 3200x2100x24',
      'bun',
      'scripts/screenshots/generate.ts',
    ]);
    // The server-args value stays a single argv element — its spaces survive.
    expect(wrapped.args[1]).toBe('--server-args=-screen 0 3200x2100x24');
  });
});

describe('scripts/lib/platform — platformLabel', () => {
  it('maps node platform ids to friendly names', () => {
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('freebsd')).toBe('freebsd');
  });
});
