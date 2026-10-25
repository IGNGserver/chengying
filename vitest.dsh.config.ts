import { defineConfig } from 'vitest/config'

// End-to-end tests against a real DeepSeek Harness runtime driven by a scripted
// mock model server. Requires DSH_E2E_RUNTIME (a directory with @deepseek-ai/dsh installed).
export default defineConfig({
  test: {
    include: ['tests/dsh/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
