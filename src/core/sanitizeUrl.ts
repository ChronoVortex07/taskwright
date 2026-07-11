/**
 * Centralized URL-safety policy for rendered Markdown.
 *
 * Rendered task/document Markdown can contain link/image destinations that a
 * browser would treat as executable (`javascript:`, `vbscript:`) or as an
 * inline document (`data:`). This module is the single source of truth for
 * which URLs are safe to place in an `href`/`src`, defeating the usual
 * obfuscations: mixed case, leading/embedded whitespace & control characters,
 * and HTML-entity encoding that the browser decodes at navigation time.
 *
 * Allowlist policy: a URL is safe when it either
 *   - has NO scheme — a workspace-relative path, `#fragment`, or query (these
 *     are resolved relative to the document and are never executed), or
 *   - uses one of the allowlisted schemes: http, https, mailto.
 * Every other scheme (javascript, data, vbscript, file, tel, ...) is unsafe.
 *
 * Percent-encoded schemes (e.g. `java%73cript:`) are intentionally treated as
 * inert relative URLs: a `%` is invalid in a URL scheme, so browsers do not
 * decode it into an executable scheme — they navigate to it as a relative path.
 *
 * Pure and dependency-free so it runs both in the extension host (the
 * `parseMarkdown` render pipeline) and inside webview bundles (link-click
 * guards) — one policy, no drift.
 */

/** Schemes allowed in a rendered href/src. Everything else is neutralized. */
export const SAFE_URL_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

// Control characters and ASCII whitespace (NUL..space, DEL) that browsers strip
// when parsing a URL scheme. Built dynamically to satisfy eslint no-control-regex.
const STRIP_CHARS_REGEX = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x20) + String.fromCharCode(0x7f) + ']',
  'g'
);

// Named HTML entities a browser resolves inside an attribute value that could be
// used to smuggle a scheme delimiter or whitespace past a naive check.
const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePointOr(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Decode the HTML entities a browser would resolve inside an href/src value. */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex: string) => codePointOr(parseInt(hex, 16), whole))
    .replace(/&#([0-9]+);?/g, (whole, dec: string) => codePointOr(parseInt(dec, 10), whole))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole, name: string) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded === undefined ? whole : decoded;
    });
}

/**
 * Return the lowercased scheme of a URL (without the trailing `:`), or null when
 * it has no scheme (relative path / fragment / query). Entity-decodes and strips
 * whitespace + control characters first so obfuscated schemes are detected.
 */
export function urlScheme(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const decoded = decodeHtmlEntities(String(raw));
  const stripped = decoded.replace(STRIP_CHARS_REGEX, '');
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(stripped);
  return match ? match[1].toLowerCase() : null;
}

/** True when the URL has no scheme (workspace-relative, fragment, or query). */
export function isRelativeUrl(raw: string | null | undefined): boolean {
  return urlScheme(raw) === null;
}

/** True when the URL is safe to render in an href/src (allowlisted scheme or schemeless). */
export function isSafeUrl(raw: string | null | undefined): boolean {
  const scheme = urlScheme(raw);
  return scheme === null || SAFE_URL_SCHEMES.includes(scheme);
}

// Match an href/src attribute carrying a double- or single-quoted value. marked
// only ever emits double-quoted href (anchors) and src (images); raw HTML tags
// are already escaped upstream by sanitizeMarkdownSource, so this targets exactly
// the URL-bearing output that marked produced.
const URL_ATTRIBUTE_REGEX = /(\s(?:href|src)\s*=\s*)("([^"]*)"|'([^']*)')/gi;

/**
 * Neutralize unsafe href/src attributes in rendered HTML by dropping the whole
 * attribute (leaving e.g. an inert `<a>text</a>`). Safe attributes pass through
 * byte-for-byte unchanged.
 */
export function sanitizeUrlAttributes(html: string): string {
  return html.replace(URL_ATTRIBUTE_REGEX, (whole, _prefix, _quoted, dq, sq) => {
    const value = dq !== undefined ? dq : sq !== undefined ? sq : '';
    return isSafeUrl(value) ? whole : '';
  });
}
