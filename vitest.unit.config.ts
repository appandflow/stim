import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    exclude: ['**/*.compat.test.ts', '**/*.integration.test.ts', '**/*.integration.test.mjs'],
  },
});
