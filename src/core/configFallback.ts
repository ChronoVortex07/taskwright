/**
 * Settings-migration shim for the `backlog.*` → `taskwright.*` namespace rename.
 *
 * Existing users have their settings under the inherited `backlog.*` keys. Rather
 * than rewrite their `settings.json`, we read the new `taskwright.*` key and fall
 * back to the legacy `backlog.*` key at read time. This pure helper holds the
 * precedence logic so it can be unit-tested without the VS Code API; the thin
 * wrapper in `src/config.ts` feeds it `WorkspaceConfiguration.inspect()` results.
 */

/**
 * Subset of `vscode.WorkspaceConfiguration.inspect()`'s return shape that we
 * consult. `defaultValue` (the package.json-contributed default) is intentionally
 * absent from the precedence chain — only a user/workspace/folder override counts
 * as an "explicit" value.
 */
export interface ConfigInspection<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/** The explicit override within one namespace, most specific scope first. */
function explicitValue<T>(inspection: ConfigInspection<T> | undefined): T | undefined {
  if (!inspection) return undefined;
  return inspection.workspaceFolderValue ?? inspection.workspaceValue ?? inspection.globalValue;
}

/**
 * Resolve a setting from the primary (`taskwright.*`) inspection, falling back to
 * the legacy (`backlog.*`) inspection, then to `defaultValue`. Any explicit value
 * in the new namespace wins over a legacy value, so once a user adopts the new key
 * it fully overrides the old one.
 */
export function resolveConfigWithFallback<T>(
  primary: ConfigInspection<T> | undefined,
  legacy: ConfigInspection<T> | undefined,
  defaultValue: T
): T {
  return explicitValue(primary) ?? explicitValue(legacy) ?? defaultValue;
}
