import { sanitizeMarkdownSource } from './sanitizeMarkdown';
import { sanitizeUrlAttributes } from './sanitizeUrl';

let markedParse: ((markdown: string) => string | Promise<string>) | null = null;

async function getMarkedParse(): Promise<(markdown: string) => string | Promise<string>> {
  if (!markedParse) {
    const { marked } = await import('marked');
    marked.setOptions({ gfm: true, breaks: true });
    markedParse = marked.parse;
  }
  return markedParse;
}

// Webviews don't show a URL status bar on hover, so without a title attribute
// link destinations are invisible to the user. Inject title={href} on anchors
// that don't already declare one so the native browser tooltip reveals the target.
export function addLinkTitles(html: string): string {
  return html.replace(/<a\s+([^>]*?)>/gi, (match, attrs: string) => {
    if (/\btitle\s*=/i.test(attrs)) return match;
    const hrefMatch = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!hrefMatch) return match;
    const href = hrefMatch[1];
    if (!href || href.startsWith('#')) return match;
    return `<a ${attrs} title="${href}">`;
  });
}

export async function parseMarkdown(markdown: string): Promise<string> {
  const parse = await getMarkedParse();
  const safe = sanitizeMarkdownSource(markdown);
  const result = parse(safe);
  const html = typeof result === 'string' ? result : await result;
  // Neutralize dangerous link/image URL schemes (javascript:, data:, vbscript:,
  // ...) BEFORE adding link titles, so a stripped href never gets a title and no
  // title reflects a dangerous destination. Raw HTML is already disabled upstream
  // by sanitizeMarkdownSource (which escapes `<letter`), so the remaining output
  // attack surface is exactly these marked-emitted href/src attributes.
  return addLinkTitles(sanitizeUrlAttributes(html));
}
