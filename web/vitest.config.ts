import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  // Mirrors the `@/*` path alias from tsconfig so tests import modules the same
  // way application code does.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // One jsdom worker a core filled a 7 GB laptop (2026-11-25); off CI there are two at most.
    ...(process.env.CI ? {} : { maxWorkers: 2 }),
  },
});
