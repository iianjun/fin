import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@fin/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/dist/**'],
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: '@fin/mcp',
          root: 'apps/mcp',
        },
      },
      {
        extends: true,
        test: {
          name: '@fin/core',
          root: 'packages/core',
        },
      },
    ],
  },
})
