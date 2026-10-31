import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedNativeLogsDir, readHostedNativeLogsCheckpoint, readLogsSince } from '@stim-cli/core/state';
import { collectHostedAndroidLogs } from '../device-host/android-logs.ts';

const native = vi.hoisted(() => {
  const runFile = vi.fn<(file: string, args?: string[], options?: { timeoutMs?: number }) => string>();
  const runFileQuiet = vi.fn<(file: string, args?: string[]) => string>();
  return {
    runFile,
    runFileAsync: async (file: string, args?: string[], options?: { timeoutMs?: number }) =>
      runFile(file, args, options),
    runFileQuiet,
    runFileQuietAsync: async (file: string, args?: string[]) => runFileQuiet(file, args),
  };
});
vi.mock('../exec.ts', () => ({ getExecutor: () => native }));
let root: string;
let home: string;
let pid: string;
let output: string;
const session = '12345678-1234-1234-1234-123456789abc';
const start = 1700000000000;
const avdName = 'stim-private';
const serial = 'emulator-5554';
const fixture = readFileSync(join(import.meta.dirname, 'fixtures/hosted-android-logcat-epoch.txt'), 'utf8');
const records = () => readLogsSince(hostedNativeLogsDir(home, 'android'), {}).records;
const checkpoint = () => readHostedNativeLogsCheckpoint(home, 'android');
const pidofOutput = () => {
  if (!pid)
    throw Object.assign(new Error('pidof found no process'), { status: 1, signal: null, stdout: '', stderr: '' });
  return pid;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-android-log-worker-'));
  home = join(root, 'home');
  mkdirSync(home);
  process.env.STIM_HOME = home;
  writeFileSync(
    join(home, 'hosted-device.json'),
    JSON.stringify({
      avdName,
      serial,
      consolePort: 5554,
      systemImage: 'system-images;android-30;google_apis;arm64-v8a',
      deviceProfile: 'pixel_6',
      architecture: 'arm64-v8a',
    }),
  );
  writeFileSync(
    join(home, 'created-devices.json'),
    JSON.stringify({ version: 1, ios: [], android: [avdName], web: [] }),
  );
  const area = join(root, 'apps', 'app');
  mkdirSync(area, { recursive: true });
  writeFileSync(
    join(area, 'receipt.json'),
    JSON.stringify({
      session,
      attempt: 'app',
      bundleId: 'dev.fixture',
      mode: 'development',
      manifest: { size: 1, sha256: createHash('sha256').update('x').digest('hex') },
      state: 'installed',
      launched: 'unverified',
    }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start + 500);
  pid = '321';
  output = fixture;
  native.runFileQuiet.mockReset().mockReturnValue(`${avdName}\nOK`);
  native.runFile.mockReset().mockImplementation((_file, args = []) => {
    if (args.includes('pidof')) return pidofOutput();
    if (args.includes('date')) return String(Date.now());
    const selected = args[args.indexOf('--pid') + 1];
    return output
      .split('\n')
      .filter((line) => !selected || line.includes(`   ${selected} `) || line.includes('   999 '))
      .join('\n');
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('a failed query exhausts ten seconds without advancing its checkpoint', async () => {
  await collectHostedAndroidLogs(home, session, 'app', start);
  vi.setSystemTime(start + 240_000);
  pid = '';
  native.runFile.mockImplementation((_file, args = [], options) => {
    if (args.includes('pidof')) return pidofOutput();
    if (args.includes('date')) return String(Date.now());
    expect(options?.timeoutMs).toBeLessThanOrEqual(4000);
    vi.setSystemTime(Date.now() + options!.timeoutMs!);
    throw new Error('query timed out');
  });
  await expect(collectHostedAndroidLogs(home, session, 'app', start)).rejects.toThrow('collection budget');
  expect(Date.now()).toBe(start + 250_000);
  expect(checkpoint()).toMatchObject({ until: start, pid: 321 });
  expect(records()).toHaveLength(3);
  native.runFile.mockImplementation((_file, args = []) => {
    if (args.includes('pidof')) return pidofOutput();
    if (args.includes('date')) return String(Date.now());
    return '1700000249.100   321   321 F libc: final crash tail';
  });
  await collectHostedAndroidLogs(home, session, 'app', start, true);
  expect(records().at(-1)).toMatchObject({ level: 'fatal', msg: 'final crash tail' });
  expect(checkpoint()?.pid).toBeUndefined();
});
