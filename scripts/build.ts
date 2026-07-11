import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { installTaskwrightSkills } from '../src/core/skillInstaller';
import { codexPluginBundleFiles, renderCodexMarketplaceJson } from '../src/core/codexPlugin';
import type { McpServerDef } from '../src/core/mcpProjectConfig';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** esbuild configs for everything we ship as Node bundles. */
const builds: esbuild.BuildOptions[] = [
  {
    // VS Code extension host entry. `vscode` is provided by the host.
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  },
  {
    // Taskwright MCP server — a standalone stdio process. Bundles the MCP SDK
    // and the vscode-free core it reuses; `vscode` is marked external only
    // defensively (it must never be reached from this entry).
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'dist/mcp/server.js',
    external: ['vscode'],
  },
  {
    // Pre-commit worktree-isolation guard — a tiny standalone Node script the
    // git hook runs. Reuses the vscode-free worktreeGuard core.
    entryPoints: ['scripts/hooks/worktree-guard.ts'],
    outfile: 'dist/hooks/worktree-guard.js',
    external: ['vscode'],
  },
  {
    // Opt-in board-sync pre-push/post-merge hook payload — required (not run
    // directly) by the committed `scripts/board-sync-hook.cjs` launcher.
    entryPoints: ['scripts/hooks/board-sync-hook.ts'],
    outfile: 'dist/hooks/board-sync-hook.js',
    external: ['vscode'],
  },
  {
    // Advisory post-checkout worktree-isolation warn hook — a tiny standalone
    // Node script the git hook runs. Reuses the vscode-free worktreeGuard core.
    // Always exits 0 (advisory only; never blocks the checkout).
    entryPoints: ['scripts/hooks/worktree-warn.ts'],
    outfile: 'dist/hooks/worktree-warn.js',
    external: ['vscode'],
  },
];

const common: esbuild.BuildOptions = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  logLevel: 'info',
  plugins: [
    {
      name: 'watch-plugin',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            console.log(`[esbuild] Build succeeded: ${build.initialOptions.outfile}`);
          }
        });
      },
    },
  ],
};

/**
 * Bundle the shipped Taskwright skills into `dist/skills/` so a PUBLISHED .vsix
 * carries them. `.claude/**` is excluded from the package by .vscodeignore, and
 * `dist/**` ships — so the skills must live under dist to reach an installed
 * extension. Reuses installTaskwrightSkills, which copies EXACTLY the dirs named
 * in TASKWRIGHT_SKILL_NAMES, so the dev-only `visual-proof`/`agent-browser` skills
 * are never bundled. overwrite:true keeps dist/skills in sync on every rebuild.
 * The extension installs FROM this dir at runtime (setUpClaudeIntegration).
 */
function bundleSkills(): void {
  const srcSkillsDir = path.join('.claude', 'skills');
  const destSkillsDir = path.join('dist', 'skills');
  fs.mkdirSync(destSkillsDir, { recursive: true });
  const results = installTaskwrightSkills(srcSkillsDir, destSkillsDir, true);
  for (const r of results) {
    console.log(`[skills] ${r.action}: ${r.name} -> ${path.join(destSkillsDir, r.name)}`);
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/**
 * Assemble the distributable **Codex plugin bundle** into `dist/codex-plugin/`
 * so Taskwright's native skills and MCP server can be installed together via
 * Codex's `/plugins` browser (the distribution primitive, complementary to the
 * per-repo extension setup). Layout:
 *
 *   dist/codex-plugin/
 *   ├── .codex-plugin/plugin.json          (manifest: skills + mcpServers)
 *   ├── .mcp.json                          (bundled MCP server, bare-map form)
 *   ├── .agents/plugins/marketplace.json   (repo-scoped registration helper)
 *   ├── mcp/server.js                      (the standalone, dependency-free server)
 *   └── skills/<name>/SKILL.md             (the four native SKILL.md packages)
 *
 * Runs after esbuild so the built `dist/mcp/server.js` exists to copy in.
 */
function bundleCodexPlugin(): void {
  const version = packageVersion();
  const bundleDir = path.join('dist', 'codex-plugin');
  // The plugin ships the standalone server and launches it directly by node.
  const pluginServer: McpServerDef = { command: 'node', args: ['mcp/server.js'] };

  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  // Manifest + plugin .mcp.json (from the pure renderers).
  for (const [rel, content] of Object.entries(
    codexPluginBundleFiles({ version, server: pluginServer })
  )) {
    const dest = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }

  // Repo-scoped marketplace registration helper.
  const marketplacePath = path.join(bundleDir, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(marketplacePath, renderCodexMarketplaceJson({ version, source: './' }), 'utf-8');

  // Native skill packages (copied from dist/skills, produced by bundleSkills).
  installTaskwrightSkills(path.join('dist', 'skills'), path.join(bundleDir, 'skills'), true);

  // The standalone MCP server the manifest points at.
  const serverSrc = path.join('dist', 'mcp', 'server.js');
  if (fs.existsSync(serverSrc)) {
    fs.mkdirSync(path.join(bundleDir, 'mcp'), { recursive: true });
    fs.copyFileSync(serverSrc, path.join(bundleDir, 'mcp', 'server.js'));
  } else {
    console.warn(`[codex-plugin] ${serverSrc} not found — bundle omits the MCP server binary.`);
  }

  console.log(`[codex-plugin] assembled ${bundleDir} (v${version}).`);
}

async function main(): Promise<void> {
  // Bundle the shipped skills into dist/skills/ before building the JS bundles,
  // so a published .vsix carries them (runs in both one-shot and --watch builds).
  bundleSkills();

  const contexts = await Promise.all(
    builds.map((options) => esbuild.context({ ...common, ...options }))
  );

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    // Assemble the plugin once up front; subsequent rebuilds refresh dist/skills
    // and dist/mcp, but the plugin bundle is a distribution artifact, not part
    // of the dev inner loop.
    bundleCodexPlugin();
    console.log('[esbuild] Watching for changes...');
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    // After the JS bundles exist (dist/mcp/server.js), assemble the Codex plugin.
    bundleCodexPlugin();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
