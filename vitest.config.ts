import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: './.artifacts/vitest/junit.xml' }],
      ['html', { outputDir: './.artifacts/vitest/report' }],
    ],
    coverage: {
      provider: 'v8',
      enabled: false,
      reportsDirectory: './.artifacts/vitest/coverage',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['**/src/**/*.{ts,tsx,mts,cts}'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/build/**',
        '**/node_modules/**',
        '**/generated/**',
        '**/__generated__/**',
        '**/*.{test,spec}.{ts,tsx,mts,cts}',
      ],
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
});
