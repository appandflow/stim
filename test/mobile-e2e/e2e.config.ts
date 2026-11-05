import { mobile } from '@e2e-dev/mobile';
import type { E2EConfig } from 'e2e';

const udid = process.env.PILOT_UDID;
const metro = process.env.PILOT_METRO_PORT;
if (!udid || !metro) throw new Error('Set PILOT_UDID and PILOT_METRO_PORT from the selected Stim fixture.');
const agent =
  process.env.PILOT_AI === '1' ? (await import(new URL('./model.local.mjs', import.meta.url).href)).default : null;

export default {
  targets: [
    {
      name: 'owned-ios',
      engine: mobile({ platform: 'ios', device: udid, session: 'stim-mobile-pilot' }),
      app: {
        bundleId: 'com.appandflow.stim.dev',
        identity: 'stim-mobile-mock-pilot',
        launchArguments: [
          '--initialUrl',
          `http://127.0.0.1:${metro}`,
          '-EXDevMenuShowsAtLaunch',
          'NO',
          '-EXDevMenuIsOnboardingFinished',
          'YES',
          '-EXDevMenuShowFloatingActionButton',
          'NO',
        ],
      },
    },
  ],
  workers: 1,
  retries: 0,
  timeout: 240_000,
  trace: 'off',
  cache: 'read-write',
  reporters: ['list', 'markdown'],
  ...(agent ? { agents: { default: { ...agent, maxSteps: 8, maxModelCalls: 8 } } } : {}),
} satisfies E2EConfig;
