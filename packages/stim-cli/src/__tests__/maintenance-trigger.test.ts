import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceChildLogFile, maintenanceRunClaims, readMaintenanceAttempt } from '@stim-cli/core/state';
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

test('the trigger stamps the attempt before spawning, so a child that dies at once is not respawned by the next command', () => {
  triggerMaintenance('status', { argv: ['status'], platform: 'linux' });
  expect(spawned).toHaveBeenCalledTimes(1);
  expect(readMaintenanceAttempt()).toBeLessThanOrEqual(Date.now());
  triggerMaintenance('status', { argv: ['status'], platform: 'linux' });
  expect(spawned).toHaveBeenCalledTimes(1);
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
