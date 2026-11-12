import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    globalSetup: ['./vitest.integration-slot.ts', ...(config.test?.globalSetup ?? [])],
    include: [
      'packages/*/src/**/*.integration.test.ts',
      'packages/*/__tests__/**/*.integration.test.ts',
      'scripts/**/*.integration.test.mjs',
      '.github/actions/stim-ci/src/**/*.integration.test.ts',
      'website/scripts/**/*.integration.test.mjs',
      'website/src/**/*.integration.test.ts',
    ],
  },
});
