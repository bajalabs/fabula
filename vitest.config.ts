import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    pool: 'threads',
    poolOptions: {
      threads: {
        // One file at a time: several specs spawn engines, swap process.env or use fake timers
        singleThread: true,
      },
    },
  },
})
