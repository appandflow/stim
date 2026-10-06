import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  maintenanceDir,
  maintenanceStateFile,
  maintenanceChildLogFile,
  maintenanceRunClaims,
} from '@stim-cli/core/state';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import { setExecutor, resetExecutor, type Executor } from '../exec.ts';
import { tryAcquireClaim, releaseClaim } from '../ownership-claim.ts';
import { makeChildProcess, goneClaimOwner } from './_factories.ts';

let home: string;
const spawned = vi.fn<Executor['spawn']>();
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-trigger-'));
  process.env.STIM_HOME = home;
  process.env.STIM_MAINTENANCE = 'report';
  spawned.mockReset().mockImplementation((_file, _args, opts) => {
    writeSync((opts!.stdio as ['ignore', number, number])[1], 'detached child\n');
    return makeChildProcess();
  });
  setExecutor({ spawn: spawned });
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const key of ['STIM_HOME', 'STIM_MAINTENANCE', 'STIM_MAINTENANCE_CHILD', 'CI']) delete process.env[key];
});

test.each([
  ['guide'],
  ['settings'],
  ['help'],
  ['status', '--help'],
  ['--version'],
  ['-V'],
  ['gc', '--delete'],
  ['gc', '--delete', '--json'],
])('excluded command %s never spawns maintenance', (...argv) => {
  triggerMaintenance('command', { argv });
  expect(spawned).not.toHaveBeenCalled();
});

test('child, scoped home, CI, off and invalid config cannot launch maintenance accidentally', () => {
  process.env.STIM_MAINTENANCE_CHILD = '1';
  triggerMaintenance('status', { argv: ['status'] });
  delete process.env.STIM_MAINTENANCE_CHILD;
  delete process.env.STIM_MAINTENANCE;
  triggerMaintenance('status', { argv: ['status'] });
  process.env.CI = '1';
  delete process.env.STIM_HOME;
  triggerMaintenance('status', { argv: ['status'] });
  process.env.STIM_HOME = home;
  process.env.STIM_MAINTENANCE = 'off';
  triggerMaintenance('status', { argv: ['status'] });
  process.env.STIM_MAINTENANCE = 'report';
  writeFileSync(join(home, 'config.json'), JSON.stringify({ maintenance: { pressureCheckMinutes: 'bad' } }));
  triggerMaintenance('status', { argv: ['status'] });
  writeFileSync(join(home, 'config.json'), '{');
  expect(() => triggerMaintenance('status', { argv: ['status'] })).not.toThrow();
  expect(spawned).not.toHaveBeenCalled();
});

test('fresh stamps suppress spawning, while a due check starts one detached child with no inherited command streams', () => {
  const out = vi.spyOn(console, 'log');
  const err = vi.spyOn(console, 'error');
  mkdirSync(maintenanceDir());
  writeFileSync(
    maintenanceStateFile(),
    JSON.stringify({
      version: 1,
      lastAt: { pressure: Date.now(), size: Date.now() },
      pressure: null,
      sizes: [],
      lastPass: null,
      recent: [],
      plan: [],
    }),
  );
  triggerMaintenance('status', { argv: ['status'] });
  expect(spawned).not.toHaveBeenCalled();
  writeFileSync(maintenanceStateFile(), '{');
  triggerMaintenance('status', { argv: ['status'], platform: 'linux' });
  expect(spawned).toHaveBeenCalledTimes(1);
  const [file, args, opts] = spawned.mock.calls[0]!;
  expect(file).toBe(process.execPath);
  expect(args).toEqual([expect.stringMatching(/maintenance(?:-run\.mjs|[\\/]run\.ts)$/), 'status']);
  expect(opts).toMatchObject({ cwd: process.cwd(), detached: true, env: { STIM_MAINTENANCE_CHILD: '1' } });
  expect(opts!.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
  expect((opts!.stdio as ['ignore', number, number])[1]).toBe((opts!.stdio as ['ignore', number, number])[2]);
  expect(readFileSync(maintenanceChildLogFile(), 'utf8')).toBe('detached child\n');
  expect(out).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
});

test('Windows maintenance uses the handle-free launcher and asks the entry to relaunch into child.log', () => {
  triggerMaintenance('status', { argv: ['status'], platform: 'win32' });
  const [file, args, opts] = spawned.mock.calls[0]!;
  expect(file).toBe('powershell.exe');
  expect(args).toContain('-NonInteractive');
  expect(opts!.env!.STIM_WINDOWS_LAUNCH_ARGS).toContain('--log-file');
  expect(opts!.env!.STIM_WINDOWS_LAUNCH_ARGS).toContain(maintenanceChildLogFile());
  expect(opts!.env!.STIM_WINDOWS_LAUNCH_CWD).toBe(process.cwd());
  expect(opts!.env!.STIM_MAINTENANCE_CHILD).toBe('1');
});

test('a spawn failure is silent and cannot turn a command into a failure', () => {
  spawned.mockImplementation(() => {
    throw new Error('spawn refused');
  });
  const out = vi.spyOn(console, 'log');
  const err = vi.spyOn(console, 'error');
  expect(() => triggerMaintenance('status', { argv: ['status'] })).not.toThrow();
  expect(out).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
});

test('live and unresolved pass claims suppress detached children, while a dead holder can be reaped', () => {
  const attempt = tryAcquireClaim({ root: maintenanceRunClaims(), mode: 'exclusive', label: 'maintenance' });
  expect(attempt.acquired).toBeDefined();
  try {
    triggerMaintenance('status', { argv: ['status'] });
    expect(spawned).not.toHaveBeenCalled();
    const path = attempt.acquired!.path;
    const holder = JSON.parse(readFileSync(path, 'utf8'));
    holder.owner = goneClaimOwner();
    writeFileSync(path, JSON.stringify(holder));
    triggerMaintenance('status', { argv: ['status'] });
    expect(spawned).toHaveBeenCalledTimes(1);
    spawned.mockClear();
    writeFileSync(path, '{');
    triggerMaintenance('status', { argv: ['status'] });
    expect(spawned).not.toHaveBeenCalled();
  } finally {
    releaseClaim(attempt.acquired!);
  }
});
