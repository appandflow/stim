import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['packages/*/__tests__/**/*.browser.test.ts'],
    exclude: [],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
