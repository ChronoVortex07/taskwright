import { describe, it, expect } from 'vitest';
import { resolveConfigWithFallback, type ConfigInspection } from '../../core/configFallback';

describe('resolveConfigWithFallback', () => {
  it('returns the default when neither namespace has an explicit value', () => {
    expect(resolveConfigWithFallback(undefined, undefined, 'full')).toBe('full');
  });

  it('ignores the package.json default value of the primary namespace', () => {
    // `inspect()` reports the contributed default via `defaultValue`; an explicit
    // user value lives under one of the *Value fields. Only the latter counts.
    const primary: ConfigInspection<string> = { defaultValue: 'full' };
    expect(resolveConfigWithFallback(primary, undefined, 'full')).toBe('full');
  });

  it('uses an explicit primary (taskwright.*) value over the default', () => {
    const primary: ConfigInspection<string> = { defaultValue: 'full', globalValue: 'number' };
    expect(resolveConfigWithFallback(primary, undefined, 'full')).toBe('number');
  });

  it('falls back to a legacy (backlog.*) value when the primary is unset', () => {
    const legacy: ConfigInspection<string> = { globalValue: 'hidden' };
    expect(resolveConfigWithFallback(undefined, legacy, 'full')).toBe('hidden');
  });

  it('prefers an explicit primary value over a legacy value', () => {
    const primary: ConfigInspection<string> = { globalValue: 'number' };
    const legacy: ConfigInspection<string> = { globalValue: 'hidden' };
    expect(resolveConfigWithFallback(primary, legacy, 'full')).toBe('number');
  });

  it('resolves scope precedence folder > workspace > global within a namespace', () => {
    const primary: ConfigInspection<string> = {
      globalValue: 'g',
      workspaceValue: 'w',
      workspaceFolderValue: 'f',
    };
    expect(resolveConfigWithFallback(primary, undefined, 'd')).toBe('f');

    const noFolder: ConfigInspection<string> = { globalValue: 'g', workspaceValue: 'w' };
    expect(resolveConfigWithFallback(noFolder, undefined, 'd')).toBe('w');
  });

  it('treats a false boolean override as an explicit value (not absent)', () => {
    const primary: ConfigInspection<boolean> = { defaultValue: true, globalValue: false };
    expect(resolveConfigWithFallback(primary, undefined, true)).toBe(false);
  });

  it('falls back to legacy when the primary inspection has only a default', () => {
    const primary: ConfigInspection<boolean> = { defaultValue: false };
    const legacy: ConfigInspection<boolean> = { globalValue: true };
    expect(resolveConfigWithFallback(primary, legacy, false)).toBe(true);
  });
});
