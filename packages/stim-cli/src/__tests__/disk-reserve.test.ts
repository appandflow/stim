import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceDir } from '@stim-cli/core/state';
import { keepReserve, releaseReserveWhenFull } from '../disk-reserve.ts';

const volume = vi.hoisted(() => ({ freeBytes: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, statfs: async () => ({ bavail: volume.freeBytes / 4096, bsize: 4096 }) };
});

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'stim-disk-reserve-'));
  vi.stubEnv('STIM_HOME', home);
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  keepReserve();
});
afterEach(() => vi.unstubAllEnvs());

test('the reserve is released once when the volume has under 64 MiB free, and kept when it has more', async () => {
  const reserve = join(maintenanceDir(), 'disk-reserve');
  volume.freeBytes = 512 * 1024 * 1024;
  expect(await releaseReserveWhenFull('/')).toBe(false);
  expect(existsSync(reserve)).toBe(true);

  volume.freeBytes = 16 * 1024 * 1024;
  expect(await releaseReserveWhenFull('/')).toBe(true);
  expect(existsSync(reserve)).toBe(false);
  expect(await releaseReserveWhenFull('/')).toBe(false);
});
