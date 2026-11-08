import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // Integration files launch workerd, SQLite workers and package installs.
    // Isolate their resource use on Windows; races within each test stay concurrent.
    fileParallelism: process.platform !== 'win32',
  },
})
