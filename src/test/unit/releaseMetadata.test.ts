import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../../mcp/serverMeta';

/**
 * Guards DERIVABLE release metadata against drift (TASK-102). `package.json` is
 * the single source of truth for the version; everything that restates it (the
 * CHANGELOG's newest entry, the MCP server's advertised version) and the
 * discoverability metadata (keywords vs the supported dispatch agents) must stay
 * reconciled automatically instead of by hand — this is the "checked
 * automatically to prevent recurrence" guard for the metadata that had drifted
 * (a `0.0.1` MCP-server placeholder; Claude-only marketing copy after Codex
 * became a first-class dispatch target).
 */
const repoRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
  version: string;
  keywords: string[];
  contributes: { configuration: { properties: Record<string, { enum?: string[] }> } };
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('release metadata is reconciled with package.json', () => {
  it('has a valid semver version', () => {
    expect(pkg.version).toMatch(SEMVER);
  });

  it('CHANGELOG.md newest version entry matches the package version', () => {
    const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf-8');
    // First `## [x.y.z]` heading = the newest released/pending entry. A future
    // `## [Unreleased]` heading is skipped because it is not a semver.
    const match = changelog.match(/^##\s*\[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/m);
    expect(match, 'no versioned "## [x.y.z]" heading found in CHANGELOG.md').not.toBeNull();
    expect(match?.[1]).toBe(pkg.version);
  });

  it('MCP server advertises the package version (not a stale placeholder)', () => {
    expect(MCP_SERVER_NAME).toBe('taskwright');
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    // The retired placeholder that drifted (TASK-102) must never come back.
    expect(MCP_SERVER_VERSION).not.toBe('0.0.1');
  });

  it('server.ts derives its version instead of hardcoding a semver literal', () => {
    const serverSrc = fs.readFileSync(path.join(repoRoot, 'src', 'mcp', 'server.ts'), 'utf-8');
    expect(serverSrc).toContain('MCP_SERVER_VERSION');
    // No hand-written semver in the McpServer construction (e.g. `version: '0.0.1'`).
    expect(serverSrc).not.toMatch(/version:\s*['"]\d+\.\d+\.\d+/);
  });

  it('keywords name every supported dispatch agent', () => {
    const agents = pkg.contributes.configuration.properties['taskwright.dispatchAgent'].enum ?? [];
    expect(agents.length).toBeGreaterThan(0);
    const keywordBlob = pkg.keywords.map((k) => k.toLowerCase()).join(' ');
    for (const agent of agents) {
      // Each dispatch agent id should be discoverable in keywords
      // (claude → "claude code", codex → "codex"), so adding an agent forces the
      // Marketplace discoverability metadata to be updated too.
      expect(keywordBlob, `keywords should mention dispatch agent "${agent}"`).toContain(agent);
    }
  });
});
