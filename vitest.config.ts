import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // SWC instead of esbuild for the TypeScript: NestJS needs the decorator metadata esbuild does not emit
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    // Each spec file in its own process (two at a time, `--maxWorkers=2` in the scripts): several specs swap
    // process.env, spawn engines or use fake timers, and a process keeps that to itself
    pool: 'forks',
  },
})
