import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/engines/**', 'tests/dsh/**', 'node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
})
