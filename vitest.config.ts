import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// pnpm's bin shims export NODE_PATH with node_modules/.pnpm/node_modules, where
// pnpm hoists every workspace dependency, including apps/mobile's expo and
// react-native. Forked test workers would then resolve them from any temporary
// project directory.
delete process.env.NODE_PATH;

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@theme/CodeBlock': fileURLToPath(new URL('./website/src/test/CodeBlock.ts', import.meta.url)),
      '@docusaurus/useIsBrowser': fileURLToPath(new URL('./website/src/test/useIsBrowser.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    disableConsoleIntercept: true,
    // Real git and spawn work take several times longer on the hosted Windows
    // runner; a hang still fails, just later.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
      'packages/*/__tests__/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'website/scripts/**/*.test.mjs',
      'website/src/**/*.test.ts',
    ],
    exclude: ['**/*.compat.test.ts'],
    pool: 'forks',
  },
});
