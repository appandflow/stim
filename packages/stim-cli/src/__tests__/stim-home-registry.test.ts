import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStimHomes, stimHomesFile, stimHomesLock } from '@stim-cli/core/state';
import { readClaimSet } from '../ownership-claim.ts';
import { recordCreatedDevice, forgetCreatedDevice } from '../devices/created-devices.ts';
import { STIM_HOMES_TEST_GUARD_ROOT_ENV } from '../engine/eas-machine-root-guard-env.ts';
import { forgetStimHomes, isTrackedStimHome, noteStimHome, recordStimHome } from '../engine/stim-home-registry.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';

const renameHook = vi.hoisted((): { beforeRename?: (path: unknown) => void } => ({}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      renameHook.beforeRename?.(args[1]);
      return fs.renameSync(...args);
    },
  };
});

describe('the machine list of Stim homes', () => {
  let dir: string;
  let root: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-homes-')));
    root = join(dir, 'machine-homes');
    previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      STIM_HOME: process.env.STIM_HOME,
      [STIM_HOMES_TEST_GUARD_ROOT_ENV]: process.env[STIM_HOMES_TEST_GUARD_ROOT_ENV],
    };
  });

  afterEach(() => {
    renameHook.beforeRename = undefined;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function listed(): string[] {
    return [...readStimHomes(root).homes.keys()].toSorted();
  }

  describe('recordStimHome', () => {
    test('lists a home once and keeps its creation time on later calls', () => {
      const home = join(dir, 'scratch');
      recordStimHome(home, { root, now: Date.parse('2026-11-03T10:00:00Z') });
      recordStimHome(home, { root, now: Date.parse('2026-11-03T10:02:00Z') });

      const entry = readStimHomes(root).homes.get(home);
      expect(listed()).toEqual([home]);
      expect(entry).toEqual({
        path: home,
        createdAt: '2026-11-03T10:00:00.000Z',
        lastSeenAt: '2026-11-03T10:00:00.000Z',
        devices: { ios: [], android: [] },
      });
    });

    test('moves the last-seen time forward only after ten minutes', () => {
      const home = join(dir, 'scratch');
      recordStimHome(home, { root, now: Date.parse('2026-11-03T10:00:00Z') });
      recordStimHome(home, { root, now: Date.parse('2026-11-03T10:09:00Z') });
      expect(readStimHomes(root).homes.get(home)?.lastSeenAt).toBe('2026-11-03T10:00:00.000Z');

      recordStimHome(home, { root, now: Date.parse('2026-11-03T10:10:00Z') });
      expect(readStimHomes(root).homes.get(home)).toMatchObject({
        createdAt: '2026-11-03T10:00:00.000Z',
        lastSeenAt: '2026-11-03T10:10:00.000Z',
      });
    });

    test('replaces the recorded devices and keeps other homes', () => {
      const first = join(dir, 'first');
      const second = join(dir, 'second');
      recordStimHome(first, { root, devices: { ios: ['UDID-1'], android: [] } });
      recordStimHome(second, { root });
      recordStimHome(first, { root, devices: { ios: [], android: ['stim-avd'] } });

      expect(listed()).toEqual([first, second]);
      expect(readStimHomes(root).homes.get(first)?.devices).toEqual({ ios: [], android: ['stim-avd'] });
    });

    test('writes the list while it holds the list lock', () => {
      let lockedDuringWrite: boolean | undefined;
      renameHook.beforeRename = (target) => {
        if (String(target) === stimHomesFile(root))
          lockedDuringWrite = readClaimSet(`${stimHomesLock(root)}.claims`).live.length === 1;
      };
      recordStimHome(join(dir, 'scratch'), { root });
      expect(lockedDuringWrite).toBe(true);
      expect(readClaimSet(`${stimHomesLock(root)}.claims`).live).toEqual([]);
    });

    test('refuses an unreadable list and leaves it as it was', () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(stimHomesFile(root), '{ not json');
      expect(() => recordStimHome(join(dir, 'scratch'), { root })).toThrow(/unreadable/);
      expect(readFileSync(stimHomesFile(root), 'utf-8')).toBe('{ not json');
    });

    test('refuses the guarded machine root', () => {
      process.env[STIM_HOMES_TEST_GUARD_ROOT_ENV] = root;
      expect(() => recordStimHome(join(dir, 'scratch'), { root })).toThrow(/Refusing to write the real machine list/);
      expect(() => forgetStimHomes([join(dir, 'scratch')], () => true, root)).toThrow(
        /Refusing to write the real machine list/,
      );
      expect(existsSync(stimHomesFile(root))).toBe(false);
    });

    test('refuses the real machine root by default, as the test setup records it', () => {
      expect(() => recordStimHome(join(dir, 'scratch'))).toThrow(/Refusing to write the real machine list/);
    });
  });

  describe('forgetStimHomes', () => {
    test('removes only the entries that still satisfy the check', () => {
      const keep = join(dir, 'keep');
      const drop = join(dir, 'drop');
      recordStimHome(keep, { root });
      recordStimHome(drop, { root });
      expect(forgetStimHomes([keep, drop], (entry) => entry.path === drop, root)).toEqual([drop]);
      expect(listed()).toEqual([keep]);
    });
  });

  describe('from a workspace or a device', () => {
    let home: string;
    let machineRoot: string;

    beforeEach(() => {
      process.env.HOME = join(dir, 'user');
      process.env.USERPROFILE = join(dir, 'user');
      home = join(dir, 'scratch');
      mkdirSync(home, { recursive: true });
      process.env.STIM_HOME = home;
      machineRoot = join(dir, 'user', '.stim', 'machine', 'homes');
      root = machineRoot;
    });

    test('a workspace lists its scratch home', () => {
      ensureWorkspaceStorage(join(dir, 'project'));
      expect(listed()).toEqual([home]);
    });

    test('a created device is mirrored into the entry and forgotten with it', () => {
      recordCreatedDevice('ios', 'UDID-1');
      recordCreatedDevice('android', 'stim-avd');
      expect(readStimHomes(root).homes.get(home)?.devices).toEqual({ ios: ['UDID-1'], android: ['stim-avd'] });

      forgetCreatedDevice('ios', 'UDID-1');
      expect(readStimHomes(root).homes.get(home)?.devices).toEqual({ ios: [], android: ['stim-avd'] });
    });

    test('the default home and the homes inside it are not listed', () => {
      const defaultHome = join(dir, 'user', '.stim');
      const hosted = join(defaultHome, 'device-host', 'sessions', 'one');
      mkdirSync(hosted, { recursive: true });
      expect(isTrackedStimHome(realpathSync(defaultHome))).toBe(false);
      expect(isTrackedStimHome(realpathSync(hosted))).toBe(false);
      expect(isTrackedStimHome(realpathSync(home))).toBe(true);

      process.env.STIM_HOME = defaultHome;
      noteStimHome({ ios: ['UDID-1'], android: [] });
      process.env.STIM_HOME = hosted;
      noteStimHome({ ios: ['UDID-2'], android: [] });
      expect(listed()).toEqual([]);
    });

    test('a refused write never fails the workspace or the device record', () => {
      process.env[STIM_HOMES_TEST_GUARD_ROOT_ENV] = machineRoot;
      expect(() => ensureWorkspaceStorage(join(dir, 'project'))).not.toThrow();
      expect(() => recordCreatedDevice('ios', 'UDID-1')).not.toThrow();
      expect(existsSync(stimHomesFile(machineRoot))).toBe(false);
    });
  });
});
