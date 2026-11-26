import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureTree } from '../private-size.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn<typeof fs.lstatSync>(fs.lstatSync) };
});

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

test('targets count private bytes from the real-size total of their directories plus their singly linked files', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const root = mkdtempSync(join(tmpdir(), 'stim-private-targets-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'file'), 'x'.repeat(10_000));
  writeFileSync(join(root, 'linked'), 'y'.repeat(10_000));
  linkSync(join(root, 'linked'), join(root, 'a', 'link'));
  const fileBytes = lstatSync(join(root, 'file')).blocks * 512;
  const linkedBytes = lstatSync(join(root, 'linked')).blocks * 512;
  const runFileAsync = vi.fn<ReturnType<typeof getExecutor>['runFileAsync']>(async () =>
    JSON.stringify({ paths: [{ allocated: 300, private: 90 }], total: { allocated: 300, private: 90, skipped: 0 } }),
  );
  setExecutor({ ...getExecutor(), runFileAsync });
  expect(
    await measureTree(root, { timeoutMs: 1000, targets: [join(root, 'a'), join(root, 'file'), join(root, 'linked')] }),
  ).toEqual({ bytes: 300 + fileBytes + linkedBytes, privateBytes: 90 + fileBytes });
  expect(runFileAsync.mock.calls[0]?.[1].slice(-3)).toEqual(['--json', '--', join(root, 'a')]);
});

test('file-only targets count their singly linked files without a real-size run', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const root = mkdtempSync(join(tmpdir(), 'stim-private-targets-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file'), 'x'.repeat(10_000));
  const bytes = lstatSync(join(root, 'file')).blocks * 512;
  const runFileAsync = vi.fn<ReturnType<typeof getExecutor>['runFileAsync']>();
  setExecutor({ ...getExecutor(), runFileAsync });
  expect(await measureTree(root, { timeoutMs: 1000, targets: [join(root, 'file')] })).toEqual({
    bytes,
    privateBytes: bytes,
  });
  expect(runFileAsync).not.toHaveBeenCalled();
});

test('targets skip foreign volumes and retain local private bytes as a lower bound', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const root = mkdtempSync(join(tmpdir(), 'stim-private-targets-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, 'src');
  const foreign = join(root, 'hfsmnt');
  const file = join(root, 'file');
  mkdirSync(local);
  mkdirSync(foreign);
  writeFileSync(file, 'x'.repeat(10_000));
  const fileBytes = lstatSync(file).blocks * 512;
  const foreignStat = lstatSync(foreign);
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(lstatSync).mockImplementation((...args) =>
    args[0] === foreign ? Object.assign(foreignStat, { dev: foreignStat.dev + 1 }) : fs.lstatSync(...args),
  );
  onTestFinished(() => {
    vi.mocked(lstatSync).mockImplementation(fs.lstatSync);
  });
  const runFileAsync = vi.fn<ReturnType<typeof getExecutor>['runFileAsync']>(async () =>
    JSON.stringify({ paths: [], total: { allocated: 300, private: 90, skipped: 0 } }),
  );
  setExecutor({ ...getExecutor(), runFileAsync });

  expect(await measureTree(root, { timeoutMs: 1000, targets: [local, foreign, file] })).toEqual({
    bytes: 300 + fileBytes,
    privateBytes: 90 + fileBytes,
    partial: true,
  });
  expect(runFileAsync).toHaveBeenCalledTimes(1);
  expect(runFileAsync.mock.calls[0]?.[1].slice(-3)).toEqual(['--json', '--', local]);
  expect(runFileAsync.mock.calls[0]?.[1]).not.toContain(foreign);

  runFileAsync.mockClear();
  expect(await measureTree(root, { timeoutMs: 1000, targets: [foreign, file] })).toEqual({
    bytes: fileBytes,
    privateBytes: fileBytes,
    partial: true,
  });
  expect(runFileAsync).not.toHaveBeenCalled();
});
