import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // Consumer tests run prepack, which deletes and rebuilds shared package dist.
    // Serialize files so other suites cannot import those outputs mid-rebuild.
    // Races within each test stay concurrent.
    fileParallelism: false,
  },
})
