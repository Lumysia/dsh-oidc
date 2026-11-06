import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // Rendered in a real browser by the acceptance test, not in unit tests.
      exclude: ['src/client/AccountMenu.tsx'],
      thresholds: { lines: 90, functions: 90, statements: 85, branches: 80 },
    },
  },
})
