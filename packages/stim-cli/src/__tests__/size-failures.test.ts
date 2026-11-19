import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonNdjsonFile } from '@stim-cli/core/state';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-size-failures-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const freshInstance = async () => {
  vi.resetModules();
  return import('../size-failures.ts');
};

test('a size failure another thread already recorded is not recorded again within 6 hours', async () => {
  const path = join(home, 'cache');
  const timeout = { reason: 'timeout', limitMs: 1000 } as const;
  const records = () =>
    readFileSync(daemonNdjsonFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): { event?: unknown } => JSON.parse(line))
      .filter((record) => record.event === 'size_failed');

  (await freshInstance()).noteSizeFailure(path, timeout, 1000);
  (await freshInstance()).noteSizeFailure(path, timeout, 1000);
  expect(records()).toHaveLength(1);

  vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
  (await freshInstance()).noteSizeFailure(path, timeout, 1000);
  expect(records()).toHaveLength(2);
});
