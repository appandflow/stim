import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REVERSE_PORTS, reversePorts } from '@stim-cli/core/state';
import type { LeaseFileEntry } from '../engine/device-lease.ts';
import { setDevice, upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { recordPhoneReverse, readPhoneReverseSerials } from '../devices/phone-reverses.ts';
import {
  applyRecordedReverses,
  dropLabelReverses,
  recordReversePort,
  resolveReversePort,
  reverseOnDevices,
  type ReverseDeps,
} from '../reverse-ports.ts';

let home: string;
let root: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-reverse-ports-')));
  root = join(home, 'project');
  mkdirSync(root);
  process.env.STIM_HOME = home;
  upsertProject(root, { metroPort: 8082, ports: { api: 8901 } });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('resolveReversePort', () => {
  test.each([
    ['8901', 8901],
    ['api', 8901],
    ['3000', 3000],
  ])('%s names port %i', (target, port) => {
    expect(resolveReversePort(root, target)).toBe(port);
  });

  test.each([
    ['0', /not a TCP port/],
    ['70000', /not a TCP port/],
    ['8082', /Metro port/],
    ['metro', /managed/],
    ['web-cdp', /stim web/],
    ['missing', /stim ports get missing/],
  ])('refuses %s', (target, message) => {
    expect(() => resolveReversePort(root, target)).toThrow(message);
  });
});

test('recording is idempotent, sorted, removable, and capped', async () => {
  expect(await recordReversePort(root, 9000, true)).toEqual([9000]);
  expect(await recordReversePort(root, 3000, true)).toEqual([3000, 9000]);
  expect(await recordReversePort(root, 9000, true)).toEqual([3000, 9000]);
  expect(reversePorts(readWorkspaceState(root))).toEqual([3000, 9000]);
  expect(await recordReversePort(root, 3000, false)).toEqual([9000]);
  expect(await recordReversePort(root, 9000, false)).toEqual([]);
  expect(readWorkspaceState(root)).not.toHaveProperty('reversePorts');
  for (let port = 4000; port < 4000 + MAX_REVERSE_PORTS; port++) await recordReversePort(root, port, true);
  await expect(recordReversePort(root, 5000, true)).rejects.toThrow(/at most/);
  expect(await recordReversePort(root, 4000, true)).toHaveLength(MAX_REVERSE_PORTS);
});

describe('reverseOnDevices', () => {
  const calls: string[] = [];
  const deps = (over: Partial<ReverseDeps> = {}): Partial<ReverseDeps> => ({
    resolveAvd: async () => ({ serial: 'emulator-5554' }),
    applyReverse: async (serial, port) => {
      calls.push(`apply ${serial} ${port}`);
      return {};
    },
    removeReverse: async (serial, port) => void calls.push(`remove ${serial} ${port}`),
    leases: () => [],
    ...over,
  });
  beforeEach(() => {
    calls.length = 0;
    setDevice(root, 'ios', { owned: true, deviceUdid: 'U1', deviceName: 'stim-a' });
    setDevice(root, 'android', { owned: true, avdName: 'stim-a', consolePort: 5554 });
  });

  test('a simulator needs nothing, an emulator gets adb reverse', async () => {
    const reports = await reverseOnDevices(root, 8901, 'add', deps());
    expect(reports.map(({ platform, status }) => [platform, status])).toEqual([
      ['ios', 'reachable'],
      ['android', 'applied'],
    ]);
    expect(calls).toEqual(['apply emulator-5554 8901']);
  });

  test('an emulator that is not running is left for the next launch', async () => {
    const reports = await reverseOnDevices(
      root,
      8901,
      'add',
      deps({ resolveAvd: async () => ({ notRunning: true as const }) }),
    );
    expect(reports.find((r) => r.platform === 'android')?.status).toBe('pending');
    expect(calls).toEqual([]);
  });

  test('a failed adb reverse is reported as failed', async () => {
    const reports = await reverseOnDevices(
      root,
      8901,
      'add',
      deps({ applyReverse: async () => ({ failed: true, reason: 'adb offline' }) }),
    );
    expect(reports.find((r) => r.platform === 'android')).toMatchObject({ status: 'failed', detail: 'adb offline' });
  });

  test('removal removes the emulator reverse and forgets the phone', async () => {
    await recordPhoneReverse(root, 'default', 'RFCR1', 8901);
    const reports = await reverseOnDevices(root, 8901, 'remove', deps());
    expect(calls).toEqual(['remove emulator-5554 8901', 'remove RFCR1 8901']);
    expect(reports.filter((r) => r.platform === 'android').every((r) => r.status === 'removed')).toBe(true);
    expect(readPhoneReverseSerials(root)).toEqual([]);
  });

  test('a leased phone gets the reverse and a leased iPhone is refused', async () => {
    const lease = (platform: 'ios' | 'android', id: string): LeaseFileEntry => ({
      path: id,
      name: id,
      platform,
      id,
      lease: {
        version: 1,
        platform,
        id,
        deviceName: id,
        holder: root,
        token: 't',
        grantedAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const reports = await reverseOnDevices(
      root,
      8901,
      'add',
      deps({ leases: () => [lease('android', 'RFCR1'), lease('ios', '0000-IPHONE')] }),
    );
    expect(calls).toContain('apply RFCR1 8901');
    expect(readPhoneReverseSerials(root)).toEqual(['RFCR1']);
    expect(reports.find((r) => r.device === '0000-IPHONE')).toMatchObject({ platform: 'ios', status: 'unsupported' });
  });
});

describe('ports recorded for a workspace', () => {
  test('launch applies them to the serial it launches on, records a phone for the lease, and skips a remote device', async () => {
    await recordReversePort(root, 8901, true);
    await recordReversePort(root, 9000, true);
    const applied: string[] = [];
    const apply = async (serial: string, port: number) => {
      applied.push(`${serial} ${port}`);
      return port === 9000 ? { failed: true as const, reason: 'adb offline' } : {};
    };
    const lines: string[] = [];
    await applyRecordedReverses(
      root,
      { slot: 'default', serial: 'RFCR1', physical: true, remote: false },
      (l) => lines.push(l),
      apply,
    );
    expect(applied).toEqual(['RFCR1 8901', 'RFCR1 9000']);
    expect(lines).toEqual(['reverse port 9000: adb offline']);
    expect(readPhoneReverseSerials(root)).toEqual(['RFCR1']);
    applied.length = 0;
    await applyRecordedReverses(
      root,
      { slot: 'default', serial: 'emulator-5554', physical: false, remote: true },
      () => {},
      apply,
    );
    expect(applied).toEqual([]);
  });

  test('releasing a label drops its reverse and no other', async () => {
    await recordReversePort(root, 8901, true);
    await recordReversePort(root, 3000, true);
    setDevice(root, 'android', { owned: true, avdName: 'stim-a', consolePort: 5554 });
    const removed: string[] = [];
    const deps = {
      resolveAvd: async () => ({ serial: 'emulator-5554' }),
      removeReverse: async (serial: string, port: number) => void removed.push(`${serial} ${port}`),
      leases: () => [],
    };
    await dropLabelReverses(root, 'other', deps);
    expect(reversePorts(readWorkspaceState(root))).toEqual([3000, 8901]);
    expect(removed).toEqual([]);
    await dropLabelReverses(root, 'api', deps);
    expect(reversePorts(readWorkspaceState(root))).toEqual([3000]);
    expect(removed).toEqual(['emulator-5554 8901']);
  });
});

describe('reverseOnDevices on hosted sessions', () => {
  const session = '12345678-1234-1234-1234-123456789abc';
  beforeEach(() => {
    const host = (platform: string) => ({
      [platform]: { host: { machine: 'mini', session, appAttempt: 'a', selected: 'mini', device: null } },
    });
    updateWorkspaceState(root, (state) => ({ ...state, ...host('ios'), deviceSlots: { tablet: host('android') } }));
  });

  test('a hosted simulator and emulator are reported with how the host reaches this machine', async () => {
    const synced: string[] = [];
    const reports = await reverseOnDevices(root, 8901, 'add', {
      leases: () => [],
      requireLinks: () => {},
      syncHosted: async (_root, machine, id) => {
        synced.push(`${machine} ${id}`);
        return [{ port: 8901, workerPort: 49152 }];
      },
    });
    expect(synced).toEqual([`mini ${session}`, `mini ${session}`]);
    expect(reports).toEqual([
      expect.objectContaining({
        platform: 'ios',
        status: 'applied',
        detail: expect.stringContaining('loopback port 8901'),
      }),
      expect.objectContaining({
        platform: 'android',
        status: 'applied',
        detail: expect.stringContaining('adb reverse tcp:8901 tcp:49152'),
      }),
    ]);
  });

  test('a host that cannot reverse, or a missing Metro supervisor, is unsupported with its remedy', async () => {
    const reports = await reverseOnDevices(root, 8901, 'add', {
      leases: () => [],
      requireLinks: () => {
        throw Object.assign(new Error('needs the supervisor'), {
          code: 'STIM_HOSTING_REFUSED',
          remedy: 'Run stim start.',
        });
      },
    });
    expect(reports.map((r) => [r.status, r.detail])).toEqual([
      ['unsupported', 'needs the supervisor Run stim start.'],
      ['unsupported', 'needs the supervisor Run stim start.'],
    ]);
  });
});
