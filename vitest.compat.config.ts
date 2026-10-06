import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['packages/*/src/**/*.compat.test.ts', 'packages/*/__tests__/**/*.compat.test.ts'],
    exclude: [],
    provide: { agentDeviceSource: process.env.STIM_AGENT_DEVICE_SOURCE ?? '' },
  },
});
