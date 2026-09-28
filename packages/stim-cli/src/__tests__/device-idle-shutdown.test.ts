import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_IDLE_SHUTDOWN_KEY, readDeviceIdleShutdowns, type DeviceActivity } from '@stim-cli/core/state';
import { clearDeviceIdleShutdown, idleShutdownDueMs } from '../devices/idle-shutdown.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const due = (activity: DeviceActivity, buildInProgress = false) =>
  idleShutdownDueMs(activity, {
    idleMs: 2 * MINUTE,
    now: NOW,
    buildInProgress,
  });

describe('idleShutdownDueMs', () => {
  test('a device with no activity for the threshold is due, one used more recently is not', () => {
    expect(
      due({
        state: 'active',
        lastActivityAt: at(2 * MINUTE),
        basis: ['workspace-use'],
      }),
    ).toBe(2 * MINUTE);
    expect(
      due({
        state: 'idle',
        lastActivityAt: at(3 * 3_600_000),
        basis: ['device-log'],
      }),
    ).toBe(3 * 3_600_000);
    expect(
      due({
        state: 'active',
        lastActivityAt: at(2 * MINUTE - 1),
        basis: ['device-log'],
      }),
    ).toBe(null);
  });

  test('an open viewer is activity now, so the device stays up', () => {
    expect(
      due({
        state: 'active',
        lastActivityAt: at(0),
        recent: { viewer: at(0) },
        basis: ['viewer'],
      }),
    ).toBe(null);
  });

  test('a driver, a Stim or agent-device lock, or unreadable evidence keeps an old device up', () => {
    const old = at(5 * 3_600_000);
    const driven = (tool: string, basis: string): DeviceActivity => ({
      state: 'driven',
      driver: { tool, pid: null, since: old },
      lastActivityAt: old,
      basis: [basis],
    });
    expect(due(driven('agent-device', 'agent-device-lease'))).toBe(null);
    expect(due(driven('stim device lock', 'device-lock'))).toBe(null);
    expect(due(driven('maestro', 'driver-process'))).toBe(null);
    expect(
      due({
        state: 'unknown',
        lastActivityAt: old,
        basis: ['agent-device-claim'],
      }),
    ).toBe(null);
  });

  test('a build in the workspace keeps an old device up', () => {
    expect(
      due(
        {
          state: 'idle',
          lastActivityAt: at(5 * 3_600_000),
          basis: ['device-log'],
        },
        true,
      ),
    ).toBe(null);
  });

  test('a device with no dated activity cannot be proven idle', () => {
    expect(due({ state: 'idle', basis: [] })).toBe(null);
  });
});

describe('clearDeviceIdleShutdown', () => {
  let stimHome: string;

  beforeEach(() => {
    stimHome = mkdtempSync(join(tmpdir(), 'stim-idle-shutdown-'));
    process.env.STIM_HOME = stimHome;
  });

  afterEach(() => {
    rmSync(stimHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test("a run that boots one slot's device forgets only that slot's idle shutdown", () => {
    const root = join(stimHome, 'app');
    const record = { at: at(0), idleMinutes: 30 };
    writeWorkspaceState(root, {
      [DEVICE_IDLE_SHUTDOWN_KEY]: { ios: record, 'ios:fold': record },
      lastUsedAt: at(0),
    });

    clearDeviceIdleShutdown(root, 'ios');
    expect(readDeviceIdleShutdowns(readWorkspaceState(root))).toEqual({
      'ios:fold': record,
    });

    clearDeviceIdleShutdown(root, 'ios', 'fold');
    expect(readWorkspaceState(root)).toEqual({ lastUsedAt: at(0) });
  });
});
