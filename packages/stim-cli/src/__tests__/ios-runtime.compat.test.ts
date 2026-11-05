import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ensureIosRuntime } from '../devices/ios-runtime.ts';

test('Xcode accepts runtime-download arguments and refuses an impossible version without downloading', async () => {
  if (process.platform !== 'darwin')
    throw new Error('Runtime compatibility requires macOS, Xcode and access to its download catalog.');
  const home = mkdtempSync(join(tmpdir(), 'stim-runtime-compat-'));
  vi.stubEnv('STIM_HOME', home);
  try {
    const result = await ensureIosRuntime({ requested: '0.0', signal: AbortSignal.timeout(45_000), note: () => {} });
    expect(result).toMatchObject({
      ok: false,
      code: 'STIM_NO_DEVICE',
      message: expect.stringContaining('not available for download'),
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
