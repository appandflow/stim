import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/define-op.ts';
import service from '../commands/service.ts';
import { appleServicesLines, createAppleServicesObserver, helperStatus } from '../apple-services.ts';
import { measureTick } from '../daemon/measure.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-helper-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test.each(['install', 'uninstall'])('%s --helper refuses on non-macOS with a Mac remedy', async (action) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  await expect(runCli(service, [action, '--helper'], { version: '1' })).rejects.toThrow(/requires macOS.*on a Mac/);
});

test('helper registration reports approval and unregistration does not require the server service', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const executable = join(home, 'Applications', 'Stim Host.app', 'Contents', 'MacOS', 'stim-host');
  mkdirSync(join(executable, '..'), { recursive: true });
  writeFileSync(executable, '');
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
});

test('helper install refuses server options before changing either service', async () => {
  await expect(runCli(service, ['install', '--helper', '--serve'], { version: '1' })).rejects.toThrow(
    /cannot be combined/,
  );
});

function installHost(): void {
  const executable = join(home, 'Applications', 'Stim Host.app', 'Contents', 'MacOS', 'stim-host');
  mkdirSync(join(executable, '..'), { recursive: true });
  writeFileSync(executable, '');
}

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

const warning = {
  name: 'PerfPowerServices',
  pid: 123,
  cpu: 198,
  rss: 1024,
  commands: ['sudo killall -TERM PerfPowerServices', 'stim service install --helper'],
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
      return file.endsWith('stim-host') ? '{"state":"registered"}' : '';
    },
    async runFileQuietAsync(file) {
      calls.push(file);
      return '';
    },
  });
  const ordinary = await measureTick(null, Date.now(), { probe: false, disk: [] });
  expect(ordinary.measurement.appleServices).toBeUndefined();
  expect(calls).not.toContain('ps');
  expect(calls.some((file) => file.endsWith('stim-host'))).toBe(false);
  const maintenance = await measureTick(null, Date.now(), { probe: false, disk: [], appleServices: true });
  expect(maintenance.measurement.appleServices?.helper).toBe('registered');
  expect(calls).toContain('ps');
  expect(calls.filter((file) => file.endsWith('stim-host'))).toHaveLength(1);
});
