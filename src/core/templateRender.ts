/**
 * Minimal `{{placeholder}}` substitution shared by the dispatch and intake
 * prompt renderers. Every occurrence of a known key is replaced; unknown
 * placeholders are left intact so template typos stay visible rather than
 * silently vanishing.
 */
export function substitutePlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key] : match
  );
}
