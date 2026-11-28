import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import * as helperState from '@stim-cli/core/state';
import { runCli } from '../cli/define-op.ts';
import service from '../commands/service.ts';
import { appleServicesLines, createAppleServicesObserver, helperStatus } from '../apple-services.ts';
import { measureTick } from '../daemon/measure.ts';
import { keepHostCurrent } from '../stimd/host-update.ts';
import { saveConfig } from '../workspace/config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const pinned = vi.hoisted(() => ({ version: '9.9.9', sha256: '0'.repeat(64) }));

vi.mock('../server-cli.ts', async () => {
  const server = await import('@stim-cli/server/cli');
  return {
    loadServerCli: async () => ({
      ...server,
      installHostApp: (sources?: string) => server.installHostApp(sources, pinned),
      updateInstalledHostApp: () => server.updateInstalledHostApp(pinned),
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: (
      file: string,
      args: string[],
      options: import('node:child_process').ExecFileOptionsWithStringEncoding,
      callback: (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => void,
    ) =>
      file === '/usr/bin/codesign' && args[0] === '--verify'
        ? callback(null, '', '')
        : original.execFile(file, args, options, callback),
  };
});

let home: string;
let download: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
beforeEach(() => {
  pinned.sha256 = '0'.repeat(64);
  home = mkdtempSync(join(tmpdir(), 'stim-helper-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.spyOn(helperState, 'readHelperHeartbeat').mockImplementation(() => ({ at: Date.now(), ok: true }));
  download = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response('missing', { status: 404 }),
  );
  vi.stubGlobal('fetch', download);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function installHost(version = pinned.version, applications = join(home, 'Applications')): string {
  const app = join(applications, 'Stim Host.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleIdentifier</key><string>dev.stim.host</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  const executable = join(app, 'Contents', 'MacOS', 'stim-host');
  writeFileSync(executable, version);
  return executable;
}

test.each(['install', 'uninstall'])('%s --helper refuses on non-macOS with a Mac remedy', async (action) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  await expect(runCli(service, [action, '--helper'], { version: '1' })).rejects.toThrow(/requires macOS.*on a Mac/);
  expect(download).not.toHaveBeenCalled();
});

test('helper registration through the pinned Stim Host reports approval without a download', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = installHost();
  const calls: string[][] = [];
  setExecutor({
    async runFileAsync(file, args) {
      expect(file).toBe(executable);
      calls.push(args);
      return JSON.stringify({ state: args[0] === 'helper-register' ? 'requires approval' : 'not registered' });
    },
  });
  const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runCli(service, ['install', '--helper'], { version: '1' });
  expect(log).toHaveBeenLastCalledWith(
    expect.stringContaining('requires approval; approve Stim Host in System Settings'),
  );
  await runCli(service, ['uninstall', '--helper'], { version: '1' });
  expect(log).toHaveBeenLastCalledWith('Runaway service helper: not registered\n');
  expect(calls).toEqual([['helper-register'], ['helper-unregister']]);
  expect(download).not.toHaveBeenCalled();
});

test('helper unregistration uses an older Stim Host as it is', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = installHost('0.1.1');
  const calls: string[][] = [];
  setExecutor({
    async runFileAsync(file, args) {
      calls.push([file, ...args]);
      return '{"state":"not registered"}';
    },
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runCli(service, ['uninstall', '--helper'], { version: '1' });
  expect(calls).toEqual([[executable, 'helper-unregister']]);
  expect(download).not.toHaveBeenCalled();
});

test('helper registration stops when the pinned Stim Host cannot be downloaded', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  installHost('0.1.1');
  const run = vi.fn<() => Promise<string>>(async () => '{"state":"registered"}');
  setExecutor({ runFileAsync: run });
  await expect(runCli(service, ['install', '--helper'], { version: '1' })).rejects.toThrow(
    /Could not download Stim Host 9\.9\.9 .*host-v9\.9\.9.*HTTP 404/,
  );
  expect(run).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== 'darwin')(
  'helper registration replaces an older Stim Host with the pinned release before registering',
  async () => {
    const executable = installHost('0.1.1');
    const release = join(home, 'release');
    installHost(pinned.version, release);
    const archive = join(home, 'StimHost.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(release, 'Stim Host.app'), archive]);
    const zip = readFileSync(archive);
    pinned.sha256 = createHash('sha256').update(zip).digest('hex');
    download.mockResolvedValue(new Response(zip));
    const registeredWith: string[] = [];
    setExecutor({
      async runFileAsync(file, args) {
        expect(args).toEqual(['helper-register']);
        registeredWith.push(readFileSync(file, 'utf8'));
        return '{"state":"requires approval"}';
      },
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runCli(service, ['install', '--helper'], { version: '1' });
    expect(download).toHaveBeenCalledWith(expect.stringContaining('/host-v9.9.9/'), expect.anything());
    expect(registeredWith).toEqual([pinned.version]);
    expect(readFileSync(executable, 'utf8')).toBe(pinned.version);
  },
  30_000,
);

test.each([
  ['no Stim Host', null, false],
  ['the pinned Stim Host', '9.9.9', false],
  ['a newer Stim Host', '10.0.0', false],
  ['an older Stim Host with engine.autoUpdate off', '0.1.1', true],
])('stimd leaves %s as it is', async (_case, version, off) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = version ? installHost(version) : undefined;
  if (off) saveConfig({ projects: {}, repos: {}, engine: { autoUpdate: 'off' } });
  const log = vi.fn<Parameters<typeof keepHostCurrent>[0]>();
  await keepHostCurrent(log);
  expect(download).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(executable ? readFileSync(executable, 'utf8') : existsSync(join(home, 'Applications'))).toBe(version ?? false);
});

test('stimd retries a failed Stim Host update an hour later', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  installHost('0.1.1');
  const log = vi.fn<Parameters<typeof keepHostCurrent>[0]>();
  await keepHostCurrent(log);
  expect(log).toHaveBeenCalledWith(
    'warn',
    'host_update_failed',
    expect.stringMatching(/HTTP 404.*retrying in an hour/),
  );
  expect(download).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(download).toHaveBeenCalledTimes(2);
});

test.skipIf(process.platform !== 'darwin')(
  'stimd replaces an older Stim Host with the pinned release',
  async () => {
    const executable = installHost('0.1.1');
    const release = join(home, 'release');
    installHost(pinned.version, release);
    const archive = join(home, 'StimHost.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(release, 'Stim Host.app'), archive]);
    const zip = readFileSync(archive);
    pinned.sha256 = createHash('sha256').update(zip).digest('hex');
    download.mockResolvedValue(new Response(zip));
    const log = vi.fn<Parameters<typeof keepHostCurrent>[0]>();
    await keepHostCurrent(log);
    expect(log).toHaveBeenCalledWith('info', 'host_updated', expect.stringContaining('Stim Host.app'));
    expect(readFileSync(executable, 'utf8')).toBe(pinned.version);
  },
  30_000,
);

test.skipIf(process.platform !== 'darwin')(
  'stimd waits for a running Stim Host install and does not downgrade what it installed',
  async () => {
    const { installHostApp } = await import('@stim-cli/server/cli');
    const executable = installHost('0.1.1');
    const release = join(home, 'release');
    installHost('10.0.0', release);
    const archive = join(home, 'StimHost.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(release, 'Stim Host.app'), archive]);
    const zip = readFileSync(archive);
    let deliver: (response: Response) => void = () => {};
    download.mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve)));
    const explicit = installHostApp(undefined, {
      version: '10.0.0',
      sha256: createHash('sha256').update(zip).digest('hex'),
    });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const log = vi.fn<Parameters<typeof keepHostCurrent>[0]>();
    const automatic = keepHostCurrent(log);
    await vi.advanceTimersByTimeAsync(2000);
    deliver(new Response(zip));
    await explicit;
    await vi.advanceTimersByTimeAsync(2000);
    await automatic;
    expect(download).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(readFileSync(executable, 'utf8')).toBe('10.0.0');
  },
  30_000,
);

test('helper install refuses server options before changing either service', async () => {
  await expect(runCli(service, ['install', '--helper', '--serve'], { version: '1' })).rejects.toThrow(
    /cannot be combined/,
  );
});

test('helper status distinguishes non-macOS and missing Stim Host', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  expect(await helperStatus()).toBe('unavailable on this OS');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  expect(await helperStatus()).toBe('Stim Host missing');
});

test.each([
  [Object.assign(new Error('usage: stim-host ...'), { status: 64 }), 'Stim Host too old'],
  [Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'status timed out'],
  [new Error('cannot execute'), 'status error'],
])('helper status diagnoses %s without calling it an unsupported OS', async (error, state) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  installHost();
  setExecutor({
    async runFileAsync() {
      throw error;
    },
  });
  expect(await helperStatus()).toBe(state);
});

test('helper status caches registration for five minutes and invalidates it after mutations', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  installHost();
  const run = vi.fn<() => Promise<string>>(async () => '{"state":"registered"}');
  setExecutor({ runFileAsync: run });
  await Promise.all([helperStatus(), helperStatus()]);
  expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(299_999);
  await helperStatus();
  expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  await helperStatus();
  expect(run).toHaveBeenCalledTimes(2);
  await runCli(service, ['uninstall', '--helper'], { version: '1' });
  await helperStatus();
  expect(run).toHaveBeenCalledTimes(4);
});

test.each(['not registered', 'registered'] as const)(
  'a stale heartbeat rechecks cached registration before reporting %s',
  async (state) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    installHost();
    const run = vi.fn<(file: string, args: string[]) => Promise<string>>(async () => '{"state":"registered"}');
    setExecutor({
      runFileAsync: run,
      async runFileQuietAsync() {
        return '';
      },
    });
    expect(await helperStatus()).toBe('registered');
    vi.mocked(helperState.readHelperHeartbeat).mockReturnValue({ at: Date.now() - 180_000, ok: true });
    run.mockImplementation(async (file) => {
      if (!file.endsWith('stim-host')) return '';
      if (state === 'registered')
        vi.mocked(helperState.readHelperHeartbeat).mockReturnValue({ at: Date.now(), ok: true });
      return JSON.stringify({ state });
    });
    const measured = await measureTick(null, Date.now(), { probe: false, disk: [], appleServices: true });
    const status = measured.measurement.appleServices;
    expect(status?.helper).toBe(state);
    expect(status && createAppleServicesObserver()(status).lines).toEqual([]);
    expect(run.mock.calls.filter((args) => args[0]?.endsWith('stim-host'))).toHaveLength(2);
  },
);

const warning = {
  name: 'PerfPowerServices',
  pid: 123,
  cpu: 198,
  rss: 1024,
  commands: ['stim service install --helper'],
};

test('stimd requires consecutive high samples and logs only warning transitions and new restart receipts', () => {
  const observe = createAppleServicesObserver();
  const sample = { helper: 'not registered' as const, warnings: [warning], restarts: [] };
  expect(observe(sample)).toEqual({ status: { ...sample, warnings: [] }, lines: [] });
  expect(observe({ ...sample, warnings: [] }).lines).toEqual([]);
  expect(observe(sample).status.warnings).toEqual([]);
  expect(observe(sample).lines).toEqual(appleServicesLines(sample));
  expect(observe({ ...sample, warnings: [{ ...warning, cpu: 210 }] }).lines).toEqual([]);
  const memory = { ...sample, warnings: [{ ...warning, cpu: 20, rss: 3 * 1024 ** 3 }] };
  expect(observe(memory).lines).toHaveLength(1);
  const receipt = { name: warning.name, pid: 123, at: Date.now(), cpu: 198, rss: 1024, seconds: 600 };
  const restarted = { ...memory, restarts: [receipt] };
  expect(observe(restarted).lines).toHaveLength(1);
  expect(observe(restarted).lines).toEqual([]);
  expect(observe({ ...sample, warnings: [] }).lines).toEqual([]);
  expect(observe(sample).status.warnings).toEqual([]);
  expect(observe(sample).lines).toHaveLength(1);
});

test('stimd logs helper health only when it changes', () => {
  const observe = createAppleServicesObserver();
  const sample = { helper: 'registered' as const, warnings: [], restarts: [] };
  expect(observe(sample).lines[0]).toContain('missing heartbeat');
  expect(observe(sample).lines).toEqual([]);
  const failed = { ...sample, heartbeat: { at: Date.now(), ok: false, error: 'process listing failed' } };
  expect(observe(failed).lines[0]).toContain('process listing failed');
  expect(observe(failed).lines).toEqual([]);
  expect(observe({ ...sample, heartbeat: { at: Date.now(), ok: true } }).lines).toEqual([]);
  expect(observe(sample).lines).toHaveLength(1);
});

test('measureTick samples Apple services only when the home pass opts in', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  installHost();
  const calls: string[] = [];
  setExecutor({
    async runFileAsync(file) {
      calls.push(file);
      return file.endsWith('stim-host') ? '{"state":"not registered"}' : '';
    },
    async runFileQuietAsync(file) {
      calls.push(file);
      return file === 'ps'
        ? [
            '123 1 1024 198.0 Sat Sep 26 15:33:49 2026 /System/Library/PrivateFrameworks/PhotoAnalysis.framework/Versions/A/Support/photoanalysisd',
            '124 1 1024 198.0 Sat Sep 26 15:33:49 2026 /Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/System/Library/PrivateFrameworks/PhotoAnalysis.framework/Versions/A/Support/photoanalysisd',
          ].join('\n')
        : '';
    },
  });
  const ordinary = await measureTick(null, Date.now(), { probe: false, disk: [] });
  expect(ordinary.measurement.appleServices).toBeUndefined();
  expect(calls).not.toContain('ps');
  expect(calls.some((file) => file.endsWith('stim-host'))).toBe(false);
  const maintenance = await measureTick(null, Date.now(), { probe: false, disk: [], appleServices: true });
  expect(maintenance.measurement.appleServices?.helper).toBe('not registered');
  expect(maintenance.measurement.appleServices?.warnings).toEqual([
    {
      name: 'photoanalysisd',
      pid: 123,
      cpu: 198,
      rss: 1024 * 1024,
      commands: ['stim service install --helper'],
    },
  ]);
  expect(calls).toContain('ps');
  expect(calls.filter((file) => file.endsWith('stim-host'))).toHaveLength(1);
});
