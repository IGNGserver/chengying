import { defineConfig } from 'vitest/config'

// Real-engine integration tests (darktable / RawTherapee). Each suite skips
// itself when its engine is not installed; CI installs them explicitly.
export default defineConfig({
  test: {
    include: ['tests/engines/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
