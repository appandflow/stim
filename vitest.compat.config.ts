import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import config from './vitest.config.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    agentDeviceBin: string;
  }
}

const userAgentDevice = join(homedir(), '.local', 'bin', 'agent-device');

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    globalSetup: [],
    include: ['packages/*/src/**/*.compat.test.ts', 'packages/*/__tests__/**/*.compat.test.ts'],
    exclude: [],
    env: { npm_config_offline: 'false' },
    provide: {
      agentDeviceBin: process.env.STIM_AGENT_DEVICE_BIN?.trim() || (existsSync(userAgentDevice) ? userAgentDevice : ''),
      agentDeviceSource: process.env.STIM_AGENT_DEVICE_SOURCE ?? '',
      agentDeviceAndroidSerial: process.env.STIM_AGENT_DEVICE_ANDROID_SERIAL ?? '',
      iosDeviceUdid: process.env.STIM_COMPAT_IOS_UDID ?? '',
    },
  },
});
