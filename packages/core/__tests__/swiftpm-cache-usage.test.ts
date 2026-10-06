import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readStatsReport,
  readSwiftpmCacheUsage,
  swiftpmCacheUsageFile,
  type SwiftpmCacheUsage,
} from '../state/index.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-core-swiftpm-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CACHE_HOME', join(home, '.cache'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('core stats returns only cached SwiftPM usage and tolerates missing, corrupt and future payloads', () => {
  const usage: SwiftpmCacheUsage = {
    version: 1,
    measuredAt: '2026-10-06T00:00:00Z',
    dir: join(home, 'cache'),
    present: true,
    bytes: 1536,
    complete: true,
  };
  expect(readStatsReport(null, Date.now()).report.swiftpmCache).toBe(null);
  for (const bytes of [1536, null]) {
    writeFileSync(swiftpmCacheUsageFile(), JSON.stringify({ ...usage, bytes, futureField: true }));
    expect(readSwiftpmCacheUsage()).toMatchObject({ ...usage, bytes });
    expect(readStatsReport(null, Date.now()).report.swiftpmCache).toMatchObject({ ...usage, bytes });
  }
  for (const raw of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...usage, version: 2 }),
    JSON.stringify({ ...usage, bytes: -1 }),
    JSON.stringify({ ...usage, bytes: 'large' }),
    JSON.stringify({ ...usage, measuredAt: 'invalid' }),
    JSON.stringify({ ...usage, dir: null }),
    JSON.stringify({ ...usage, present: 'yes' }),
    JSON.stringify({ ...usage, complete: null }),
  ]) {
    writeFileSync(swiftpmCacheUsageFile(), raw);
    expect(readSwiftpmCacheUsage()).toBe(null);
    expect(readStatsReport(null, Date.now()).report.swiftpmCache).toBe(null);
  }
});
