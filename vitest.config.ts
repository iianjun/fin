import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
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
