import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/cdp/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    pool: 'forks',
    maxConcurrency: 1,
    // One VS Code instance at a time: test FILES must also run sequentially
    // (maxConcurrency only serializes tests within a file). Parallel files
    // share the launcher's default --user-data-dir, so the second launch hands
    // off to the first instance and its CDP port never comes up.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
