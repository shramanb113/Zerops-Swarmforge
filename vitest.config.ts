import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'services/**/tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      '@swarmforge/agent-framework': new URL('./packages/agent-framework/src/index.ts', import.meta.url).pathname,
    },
  },
});
