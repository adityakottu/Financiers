import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
