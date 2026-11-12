import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { measureTick } from '../daemon/measure.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import type { Config } from '../workspace/config.ts';

let home: string;
let simctlCalls: number[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-sim-retry-')));
  process.env.STIM_HOME = home;
  simctlCalls = [];
});
afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const owning = (): Config => ({
  repos: {},
  projects: { [join(home, 'app')]: { platforms: { ios: { owned: true } } } },
});

function stubSimctl(outcomes: ('timeout' | 'ok')[]): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file !== 'xcrun' || args[0] !== 'simctl') return real.runFileAsync(file, args, options);
      simctlCalls.push(Number(options?.timeoutMs));
      if (outcomes.shift() === 'timeout')
        throw Object.assign(new Error('Command timed out after 10000ms: xcrun simctl list devices --json'), {
          code: 'ETIMEDOUT',
        });
      return '{"devices":{}}';
    },
  });
}

test.runIf(process.platform === 'darwin')(
  'a simctl list that times out is retried once with a longer timeout',
  async () => {
    stubSimctl(['timeout', 'ok']);
    const measured = await measureTick(owning(), Date.now(), { probe: false });
    expect(measured.sims).toEqual([]);
    expect(measured.simsError).toBeNull();
    expect(simctlCalls).toEqual([10_000, 30_000]);
  },
);

test.runIf(process.platform === 'darwin')('a simctl list that times out twice is a failed listing', async () => {
  stubSimctl(['timeout', 'timeout']);
  const measured = await measureTick(owning(), Date.now(), { probe: false });
  expect(measured.sims).toBeNull();
  expect(measured.simsError).toContain('timed out');
  expect(simctlCalls).toHaveLength(2);
});
