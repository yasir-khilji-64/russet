import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@russet/agent',
    environment: 'node',
    globals: false,
    isolate: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    unstubEnvs: true,
    unstubGlobals: true,
    retry: 0,
    testTimeout: 5_000,
    hookTimeout: 10_000,
    include: ['tests/**/*.spec.ts'],
  },
});
