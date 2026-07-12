import { defineConfig, type Plugin } from 'vitest/config';
import { compileModule } from 'svelte/compiler';
import { transformSync } from 'esbuild';
import path from 'path';

/**
 * Compiles `.svelte.ts` rune modules (e.g. `src/webview/lib/commandNonce.svelte.ts`) so the
 * webview's reactive idioms can be unit-tested directly, not only through Playwright.
 *
 * Why this is hand-rolled rather than `@sveltejs/vite-plugin-svelte`:
 *   - Vitest transforms in SSR mode, and vite-plugin-svelte keys the compiler's `generate`
 *     option off that flag — so it would emit `generate: 'server'` code, in which `$effect.root`
 *     is a no-op stub whose body never runs and `$state` is inert. Rune tests would then observe
 *     nothing at all and pass VACUOUSLY, which is worse than not having them.
 *   - `compilerOptions.generate` cannot be used to force the issue: vite-plugin-svelte lists it
 *     in `ignoredCompilerOptions` and strips it.
 *   - Vitest 4 removed `testTransformMode`, so web-mode cannot be requested per-file either; the
 *     only supported route is a DOM `environment`, which would mean a new dependency (jsdom /
 *     happy-dom) and a DOM global for every unit test that does not want one.
 *
 * Compiling here with an explicit `generate: 'client'` sidesteps all three. We only ever need
 * rune MODULES (`.svelte.ts`), never mounted `.svelte` components, so this is the whole job.
 */
function svelteRuneModules(): Plugin {
  return {
    name: 'taskwright-svelte-rune-modules',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.svelte.ts')) return null;
      // svelte's compileModule consumes JS, so strip the TypeScript first.
      const js = transformSync(code, { loader: 'ts', target: 'esnext', sourcefile: file }).code;
      const compiled = compileModule(js, { filename: file, generate: 'client', dev: true });
      return { code: compiled.js.code, map: compiled.js.map };
    },
  };
}

export default defineConfig({
  plugins: [svelteRuneModules()],
  resolve: {
    // Svelte's package exports map `browser` → the CLIENT runtime and `default` → the SERVER
    // one. The client-generated modules above must be paired with the client runtime, or
    // `flushSync`/`untrack` come from a runtime that knows nothing about their effects.
    conditions: ['browser'],
  },
  ssr: {
    // Vitest resolves test modules through Vite's SSR pipeline, so the condition has to be
    // declared here too — `resolve.conditions` alone does not reach it.
    resolve: { conditions: ['browser'] },
  },
  test: {
    include: ['src/test/unit/**/*.test.ts'],
    globals: true,
    // Without this, `svelte` is externalized and loaded by plain Node ESM resolution, which
    // ignores the conditions above. The regex must cover the SUBPATHS (`svelte/internal/client`)
    // as well: inlining only the bare entry leaves the internals externalized, so the compiled
    // rune modules register their effects in a different copy of the client runtime — and hence
    // a different scheduler queue — from the one `flushSync` drains.
    server: { deps: { inline: [/^svelte($|\/)/] } },
    alias: {
      vscode: path.resolve(__dirname, 'src/test/mocks/vscode.ts'),
    },
  },
});
