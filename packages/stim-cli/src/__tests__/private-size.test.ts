import { measureTree } from '../private-size.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

vi.mock('real-size', () => ({ binaryPath: () => '/fake/real-size' }));

const platform = process.platform;

afterEach(() => {
  resetExecutor();
  Object.defineProperty(process, 'platform', { value: platform });
});

test('uses du allocated bytes and marks the volume unknown when real-size exits 2 without output', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (file, args) => {
      if (file === '/fake/real-size' || args.includes('/fake/real-size'))
        throw Object.assign(new Error('unsupported filesystem'), { status: 2, stdout: '' });
      if (file === 'du' || args.includes('du')) return '8\t/tree\n';
      throw new Error(`unexpected command: ${file}`);
    },
  });

  expect(await measureTree('/tree', { timeoutMs: 1000 })).toEqual({
    bytes: 8192,
    privateBytes: null,
    privateUnknown: 'volume',
  });
});

test('returns both lower bounds without du when real-size skips an unreadable entry', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const runFileAsync = vi.fn<ReturnType<typeof getExecutor>['runFileAsync']>(async () => {
    throw Object.assign(new Error('unreadable entry'), {
      status: 1,
      stdout: JSON.stringify({
        paths: [{ path: '/tree', allocated: 8192, private: 4096, files: 1, exact: false, skipped: 1 }],
        total: { allocated: 8192, private: 4096, files: 1, exact: false, skipped: 1 },
      }),
    });
  });
  setExecutor({ ...getExecutor(), runFileAsync });

  expect(await measureTree('/tree', { timeoutMs: 1000 })).toEqual({
    bytes: 8192,
    privateBytes: 4096,
    partial: true,
  });
  expect(runFileAsync).toHaveBeenCalledTimes(1);
});

test.each(['', 'not JSON'])('one deadline covers real-size exit 1 (%j) and the du fallback', async (stdout) => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  let takesMs = 0;
  const duTimeouts: number[] = [];
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (file, args, options) => {
      if (file === '/fake/real-size' || args.includes('/fake/real-size')) {
        vi.setSystemTime(Date.now() + takesMs);
        throw Object.assign(new Error('unreadable'), { status: 1, stdout });
      }
      if (file === 'du' || args.includes('du')) {
        duTimeouts.push(options?.timeoutMs ?? 0);
        return '8\t/tree\n';
      }
      throw new Error(`unexpected command: ${file}`);
    },
  });

  takesMs = 100_000;
  expect(await measureTree('/tree', { timeoutMs: 120_000 })).toMatchObject({ bytes: 8192, privateUnknown: 'walk' });
  expect(duTimeouts).toEqual([20_000]);

  takesMs = 130_000;
  expect(await measureTree('/tree', { timeoutMs: 120_000 })).toBeNull();
  expect(duTimeouts).toEqual([20_000]);
});
