import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['scripts/agent-benchmark/**/*.test.mjs'],
    exclude: [],
  },
});
