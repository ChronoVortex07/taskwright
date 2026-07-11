import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..', '..');

function vscodeIgnoreLines(): Set<string> {
  return new Set(
    fs
      .readFileSync(path.join(root, '.vscodeignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
}

describe('release packaging', () => {
  it.each([
    '.taskwright/**',
    '.worktrees/**',
    '.superpowers/**',
    'AGENTS.md',
    '.depcheckrc.yml',
    '.generate-license-file.config.json',
    '.release-it.json',
    'bunfig.toml',
    'idea.md',
    'vitest.cdp.config.ts',
  ])('excludes repository-only state with %s', (pattern) => {
    expect(vscodeIgnoreLines()).toContain(pattern);
  });

  it('retains the runtime MCP launcher and project template', () => {
    const ignore = vscodeIgnoreLines();
    expect(ignore).toContain('!scripts/taskwright-mcp.cjs');
    expect(ignore).toContain('!.mcp.json');
  });

  it('cleans obsolete webview chunks before each Vite build', () => {
    const config = fs.readFileSync(path.join(root, 'vite.webview.config.ts'), 'utf8');
    expect(config).toMatch(/emptyOutDir:\s*true/);
  });

  it('rebuilds Tailwind CSS after Vite cleans the webview output directory', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe(
      'bun run compile:webview && bun run build:css && bun run compile'
    );
  });
});
