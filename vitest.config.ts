import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // SWC instead of esbuild for the TypeScript: NestJS needs the decorator metadata esbuild does not emit
  plugins: [swc.vite({ module: { type: 'es6' } })],
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
