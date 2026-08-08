import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'services/**/tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      '@swarmforge/agent-framework': fileURLToPath(new URL('./packages/agent-framework/src/index.ts', import.meta.url)),
    },
  },
});
