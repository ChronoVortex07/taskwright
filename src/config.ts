import * as vscode from 'vscode';
import { resolveConfigWithFallback } from './core/configFallback';

/**
 * Reading Taskwright settings with a legacy fallback.
 *
 * The extension's contributed settings moved from the inherited `backlog.*`
 * section to `taskwright.*`. To keep existing user configs working without
 * rewriting their `settings.json`, every read goes through {@link getTaskwrightConfig},
 * which prefers the new key but transparently falls back to the legacy one.
 */

/** Current configuration section for Taskwright settings. */
export const CONFIG_SECTION = 'taskwright';

/** Legacy (vscode-backlog-md) configuration section, still honored for back-compat. */
export const LEGACY_CONFIG_SECTION = 'backlog';

/**
 * Read a Taskwright setting, falling back to the legacy `backlog.*` key when the
 * new `taskwright.*` key has no explicit user/workspace/folder value. `defaultValue`
 * should match the package.json-contributed default. All Taskwright settings are
 * window-scoped, so no resource scope is threaded through.
 */
export function getTaskwrightConfig<T>(key: string, defaultValue: T): T {
  const primary = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<T>(key);
  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).inspect<T>(key);
  return resolveConfigWithFallback(primary, legacy, defaultValue);
}

/**
 * Whether a configuration change touched the given Taskwright setting under either
 * the new or the legacy namespace.
 */
export function affectsTaskwrightConfig(
  event: vscode.ConfigurationChangeEvent,
  key: string
): boolean {
  return (
    event.affectsConfiguration(`${CONFIG_SECTION}.${key}`) ||
    event.affectsConfiguration(`${LEGACY_CONFIG_SECTION}.${key}`)
  );
}
