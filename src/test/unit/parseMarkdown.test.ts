import { describe, it, expect } from 'vitest';
import { addLinkTitles, parseMarkdown } from '../../core/parseMarkdown';

describe('addLinkTitles', () => {
  it('adds title attribute equal to href for anchors without title', () => {
    const input = '<a href="https://example.com">example</a>';
    expect(addLinkTitles(input)).toBe(
      '<a href="https://example.com" title="https://example.com">example</a>'
    );
  });

  it('preserves existing title attribute', () => {
    const input = '<a href="https://example.com" title="Example Site">example</a>';
    expect(addLinkTitles(input)).toBe(input);
  });

  it('skips pure fragment links', () => {
    const input = '<a href="#heading">jump</a>';
    expect(addLinkTitles(input)).toBe(input);
  });

  it('skips anchors with no href', () => {
    const input = '<a>placeholder</a>';
    expect(addLinkTitles(input)).toBe(input);
  });

  it('adds title to workspace-relative links with fragment', () => {
    const input = '<a href="../docs/spec.md#L42-L51">spec</a>';
    expect(addLinkTitles(input)).toContain('title="../docs/spec.md#L42-L51"');
  });

  it('handles multiple anchors in one string', () => {
    const input = '<a href="a.md">a</a> and <a href="https://b.com">b</a>';
    const out = addLinkTitles(input);
    expect(out).toContain('<a href="a.md" title="a.md">a</a>');
    expect(out).toContain('<a href="https://b.com" title="https://b.com">b</a>');
  });
});

describe('parseMarkdown', () => {
  it('renders markdown link with title attribute set to href', async () => {
    const html = await parseMarkdown('See [the doc](../docs/spec.md) here.');
    expect(html).toContain('href="../docs/spec.md"');
    expect(html).toContain('title="../docs/spec.md"');
  });

  it('renders external link with title attribute set to full URL', async () => {
    const html = await parseMarkdown('[example](https://example.com/path?q=1)');
    expect(html).toContain('title="https://example.com/path?q=1"');
  });

  it('honors explicit markdown link title over href fallback', async () => {
    const html = await parseMarkdown('[example](https://example.com "Custom Title")');
    expect(html).toContain('title="Custom Title"');
    expect(html).not.toContain('title="https://example.com"');
  });
});

describe('parseMarkdown — link/HTML sanitization', () => {
  it('neutralizes a javascript: markdown link', async () => {
    const html = await parseMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    // The visible link text is preserved; the anchor is just inert.
    expect(html).toContain('click me');
  });

  it('neutralizes data: and vbscript: markdown links', async () => {
    const data = await parseMarkdown('[x](data:text/html,<script>alert(1)</script>)');
    expect(data).not.toContain('data:text/html');
    const vb = await parseMarkdown('[x](vbscript:msgbox(1))');
    expect(vb).not.toContain('vbscript:');
  });

  it('neutralizes a mixed-case JavaScript: link', async () => {
    const html = await parseMarkdown('[x](JaVaScRiPt:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('neutralizes an entity-encoded javascript: link', async () => {
    const html = await parseMarkdown('[x](java&#115;cript:alert(1))');
    expect(html).not.toContain('java&#115;cript:');
    expect(html).not.toContain('javascript:');
  });

  it('neutralizes a reference-style javascript: link', async () => {
    const html = await parseMarkdown('[x]\n\n[x]: javascript:alert(1)');
    expect(html).not.toContain('javascript:');
  });

  it('neutralizes a javascript: autolink (href stripped; URL may remain as inert text)', async () => {
    const html = await parseMarkdown('<javascript:alert(1)>');
    // The autolink renders the URL as visible text, but the href must be gone.
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript/i);
  });

  it('does not leave a title reflecting a stripped dangerous href', async () => {
    const html = await parseMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('title="javascript:alert(1)"');
  });

  it('preserves safe http/https links and their behavior', async () => {
    const html = await parseMarkdown('[ok](https://example.com/path?q=1)');
    expect(html).toContain('href="https://example.com/path?q=1"');
    expect(html).toContain('title="https://example.com/path?q=1"');
  });

  it('preserves mailto links', async () => {
    const html = await parseMarkdown('[mail](mailto:alice@example.com)');
    expect(html).toContain('href="mailto:alice@example.com"');
  });

  it('preserves workspace-relative and task-reference links', async () => {
    const rel = await parseMarkdown('See [the doc](../docs/spec.md#L10).');
    expect(rel).toContain('href="../docs/spec.md#L10"');
    const frag = await parseMarkdown('[jump](#task-7)');
    expect(frag).toContain('href="#task-7"');
  });

  it('disables raw HTML script/img/iframe tags (escaped to inert text, not live elements)', async () => {
    const html = await parseMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.example"></iframe>'
    );
    // No live opening tags are emitted...
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
    // ...they are escaped to display text, proving they were neutralized not dropped.
    expect(html).toContain('&lt;script');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;iframe');
  });

  it('never emits a live href/src carrying a dangerous scheme', async () => {
    const inputs = [
      '[x](javascript:alert(1))',
      '![x](javascript:alert(1))',
      '<javascript:alert(1)>',
      '[x]\n\n[x]: javascript:alert(1)',
      '[x](JaVaScRiPt:alert(1))',
      '[x](java&#115;cript:alert(1))',
      '[x](data:text/html,<h1>x</h1>)',
      '[x](vbscript:msgbox(1))',
    ];
    for (const md of inputs) {
      const html = await parseMarkdown(md);
      expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*javascript/i);
      expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*data:/i);
      expect(html).not.toMatch(/(?:href|src)\s*=\s*["']?\s*vbscript/i);
    }
  });

  it('neutralizes a javascript: image source', async () => {
    const html = await parseMarkdown('![alt](javascript:alert(1))');
    expect(html).not.toMatch(/src\s*=\s*["']?\s*javascript/i);
  });
});
