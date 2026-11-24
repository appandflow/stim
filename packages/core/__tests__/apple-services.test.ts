import { readHelperRestarts } from '../state/apple-services.ts';

const logs = vi.hoisted(() => ({ current: '', rotated: '' }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: (path: string) => (path.endsWith('.1') ? logs.rotated : logs.current),
}));

test('recent helper restarts exclude failed signals, attempts, old entries and partial lines across rotation', () => {
  const now = 10_000_000;
  const row = {
    event: 'result',
    error: 0,
    at: now / 1000 - 60,
    name: 'PerfPowerServices',
    pid: 42,
    cpu: 198,
    rss: 123,
    seconds: 600,
  };
  logs.rotated = JSON.stringify(row);
  logs.current =
    [
      { ...row, pid: 43, at: now / 1000 - 1 },
      { ...row, error: 1 },
      { ...row, event: 'restart' },
      { ...row, at: now / 1000 - 3601 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n{"event":';
  expect(readHelperRestarts(now)).toEqual([
    { at: now - 60_000, name: 'PerfPowerServices', pid: 42, cpu: 198, rss: 123, seconds: 600 },
    { at: now - 1000, name: 'PerfPowerServices', pid: 43, cpu: 198, rss: 123, seconds: 600 },
  ]);
});
