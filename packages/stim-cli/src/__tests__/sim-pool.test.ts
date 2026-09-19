import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProject, loadConfig, saveConfig, setDevice, upsertProject, withConfigLock } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { IMPOSSIBLE_PID, liveClaimOwner, plantClaim, recycledClaimOwner } from './_factories.ts';
import {
  DEFAULT_PARKED_MAX,
  adoptParked,
  evictOverflow,
  parkSim,
  parkedMaxSetting,
  readParked,
  removeParkedAfter,
  selectParked,
  type ParkedSim,
} from '../sim-pool.ts';

const first: ParkedSim = {
  udid: 'FIRST',
  name: 'stim-parked (iPhone 17 26.5) firs',
  deviceTypeIdentifier: 'iphone-17',
  runtimeIdentifier: 'ios-26-5',
  parkedAt: '2026-09-01T10:00:00.000Z',
  simslimManaged: false,
};

const second: ParkedSim = {
  ...first,
  udid: 'SECOND',
  name: 'stim-parked (iPhone 17 26.5) seco',
  parkedAt: '2026-09-01T11:00:00.000Z',
};

let stimHome: string;

beforeEach(() => {
  stimHome = mkdtempSync(join(tmpdir(), 'stim-pool-test-'));
  process.env.STIM_HOME = stimHome;
});

afterEach(() => {
  rmSync(stimHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('the machine pool defaults to three but redirected homes default to off', () => {
  expect(parkedMaxSetting('ios', { config: null, env: {} })).toEqual({ max: DEFAULT_PARKED_MAX, error: null });
  expect(parkedMaxSetting('ios', { config: null, env: { STIM_HOME: '/tmp/scoped' } })).toEqual({
    max: 0,
    error: null,
  });
});

test('only the environment opts a redirected home into pooling', () => {
  const config = { version: 2, projects: {}, repos: {}, pool: { iosParkedMax: 2 } };
  expect(parkedMaxSetting('ios', { config, env: { STIM_HOME: '/tmp/scoped' } }).max).toBe(0);
  expect(
    parkedMaxSetting('ios', {
      config,
      env: { STIM_HOME: '/tmp/scoped', STIM_POOL_IOS_PARKED_MAX: '4' },
    }),
  ).toEqual({ max: 4, error: null });
});

test('invalid pool bounds fail closed', () => {
  expect(
    parkedMaxSetting('ios', {
      config: { version: 2, projects: {}, repos: {} },
      env: { STIM_POOL_IOS_PARKED_MAX: '-1' },
    }),
  ).toMatchObject({ max: 0, error: expect.stringContaining('Expected a whole number') });
  expect(
    parkedMaxSetting('ios', {
      config: { version: 2, projects: {}, repos: {}, pool: { iosParkedMax: '3' } },
      env: {},
    }),
  ).toMatchObject({ max: 0, error: expect.stringContaining('pool.iosParkedMax') });
});

test('selection is exact by model and runtime and oldest first', () => {
  const wrongModel = { ...first, udid: 'OTHER-MODEL', deviceTypeIdentifier: 'ipad-pro' };
  const wrongRuntime = { ...first, udid: 'OTHER-RUNTIME', runtimeIdentifier: 'ios-18-5' };
  expect(
    selectParked([second, wrongModel, first, wrongRuntime], {
      deviceTypeIdentifier: 'iphone-17',
      runtimeIdentifier: 'ios-26-5',
    }).map((record) => record.udid),
  ).toEqual(['FIRST', 'SECOND']);
});

test('overflow eviction removes the oldest records regardless of insertion order', () => {
  const third = { ...second, deviceTypeIdentifier: 'ipad-pro', udid: 'THIRD', parkedAt: '2026-09-01T12:00:00.000Z' };
  const result = evictOverflow([third, first, second], 1);
  expect(result.keep.map((record) => record.udid)).toEqual(['THIRD']);
  expect(result.evicted.map((record) => record.udid)).toEqual(['FIRST', 'SECOND']);
});

test('parking moves a device claim into the pool in one persisted update', () => {
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-project', owned: true } },
  });
  expect(parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 })).toEqual([]);
  expect(getProject('/tmp/project')?.platforms?.ios).toBeUndefined();
  expect(readParked('ios').map((record) => record.udid)).toEqual(['FIRST']);
});

test('overflow records stay claimed until deletion succeeds', () => {
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-project', owned: true } },
  });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 1 });
  setDevice('/tmp/project', 'ios', { deviceUdid: second.udid, owned: true });
  expect(parkSim({ platform: 'ios', projectPath: '/tmp/project', record: second, max: 1 })).toEqual([first]);
  expect(
    readParked('ios')
      .map((record) => record.udid)
      .toSorted(),
  ).toEqual(['FIRST', 'SECOND']);

  expect(() =>
    removeParkedAfter('ios', first.udid, () => {
      throw new Error('simctl busy');
    }),
  ).toThrow(/simctl busy/);
  expect(
    readParked('ios')
      .map((record) => record.udid)
      .toSorted(),
  ).toEqual(['FIRST', 'SECOND']);

  expect(removeParkedAfter('ios', first.udid, () => {})).toEqual(first);
  expect(readParked('ios').map((record) => record.udid)).toEqual(['SECOND']);
});

test('a deletion claim skips a simulator that another workspace adopted', () => {
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  adoptParked({ platform: 'ios', projectPath: '/tmp/adopter', udid: first.udid, device });
  let deleted = false;

  expect(
    removeParkedAfter('ios', first.udid, () => {
      deleted = true;
    }),
  ).toBe(null);
  expect(deleted).toBe(false);
  expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(device);
});

test('a live deletion claim blocks adoption beyond the ordinary lock stale window', () => {
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  let childResult = '';

  const removed = removeParkedAfter('ios', first.udid, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_250);
    const script = `
        const { adoptParked, removeParkedAfter } = await import(process.argv[1]);
        const request = JSON.parse(process.argv[2]);
        let deleted = false;
        const result = removeParkedAfter(request.platform, request.udid, () => { deleted = true; });
        process.stdout.write(JSON.stringify({ adopted: adoptParked(request), removed: result, deleted }));
      `;
    childResult = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        new URL('../sim-pool.ts', import.meta.url).href,
        JSON.stringify({ platform: 'ios', projectPath: '/tmp/adopter', udid: first.udid, device }),
      ],
      { encoding: 'utf8', env: { ...process.env, STIM_HOME: stimHome } },
    );
  });

  expect(JSON.parse(childResult)).toEqual({ adopted: null, removed: null, deleted: false });
  expect(removed).toEqual(first);
  expect(getProject('/tmp/adopter')?.platforms?.ios).toBeUndefined();
  expect(readParked('ios')).toEqual([]);
}, 20_000);

describe('pool operation recovery', () => {
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  const request = { platform: 'ios' as const, projectPath: '/tmp/adopter', udid: first.udid, device };
  const claimRoot = () => join(stimHome, 'pool-locks', 'ios', 'first.lock');

  beforeEach(() => {
    upsertProject('/tmp/source', { platforms: { ios: { deviceUdid: first.udid, owned: true } } });
    upsertProject('/tmp/adopter', {});
    parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  });

  function legacyAttempt(action: 'adopt' | 'delete'): unknown {
    const source = readFileSync(new URL('fixtures/legacy-sim-pool-968ad85b6.ts.txt', import.meta.url), 'utf8');
    const module = join(stimHome, 'legacy-sim-pool.ts');
    writeFileSync(module, source.replaceAll("from './", `from '${new URL('../', import.meta.url).href}`));
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { adoptParked, removeParkedAfter } = await import(process.argv[1]);
           const request = JSON.parse(process.argv[2]);
           let deleted = false;
           const result = process.argv[3] === 'adopt'
             ? adoptParked(request)
             : removeParkedAfter(request.platform, request.udid, () => { deleted = true; });
           process.stdout.write(JSON.stringify({ result, deleted }));`,
          module,
          JSON.stringify(request),
          action,
        ],
        { encoding: 'utf8', env: process.env, timeout: 5000 },
      ),
    );
  }

  test.each(['adopt', 'delete'] as const)('an older CLI cannot %s during a new deletion', (action) => {
    const removed = removeParkedAfter('ios', first.udid, () => {
      expect(legacyAttempt(action)).toEqual({ result: null, deleted: false });
      expect(getProject('/tmp/adopter')?.platforms?.ios).toBeUndefined();
    });
    expect(removed).toEqual(first);
    expect(readParked('ios')).toEqual([]);
  });

  test.each(['adopt', 'delete'])(
    '%s recovers a claim after its owner is killed outside native work',
    async (action) => {
      const script = `
      const { tryAcquireClaim } = await import(process.argv[1]);
      const claim = tryAcquireClaim({ root: process.argv[2], mode: 'exclusive' });
      if (!claim.acquired) throw new Error('fixture did not acquire the claim');
      const { loadConfig, saveConfig, withConfigLock } = await import(process.argv[3]);
      withConfigLock(() => {
        const config = loadConfig();
        config.parked.ios[0].deletionClaim = { kind: 'ownership-claim', claimId: claim.acquired.claimId };
        saveConfig(config);
      });
      process.kill(process.pid, 'SIGKILL');
    `;
      const child = getExecutor().spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          new URL('../ownership-claim.ts', import.meta.url).href,
          claimRoot(),
          new URL('../workspace/config.ts', import.meta.url).href,
        ],
        { stdio: 'ignore' },
      );
      expect(await once(child, 'exit')).toEqual([null, 'SIGKILL']);
      expect(readClaimSet(claimRoot()).dead).toHaveLength(1);
      expect(selectParked(readParked('ios'), first)).toMatchObject([first]);
      let deleted = false;
      const result =
        action === 'adopt'
          ? adoptParked(request)
          : removeParkedAfter('ios', first.udid, () => {
              deleted = true;
            });
      expect(result).toEqual(first);
      expect(deleted).toBe(action === 'delete');
      expect(readParked('ios')).toEqual([]);
      expect(readClaimSet(claimRoot()).dead).toEqual([]);
      expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(action === 'adopt' ? device : undefined);
    },
  );

  test('a reused owner PID does not prevent adoption or deletion', () => {
    plantClaim(claimRoot(), 'exclusive', recycledClaimOwner());
    expect(adoptParked(request)).toEqual(first);
    parkSim({ platform: 'ios', projectPath: '/tmp/adopter', record: first, max: 3 });
    plantClaim(claimRoot(), 'exclusive', recycledClaimOwner());
    let deleted = false;
    expect(
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).toEqual(first);
    expect(deleted).toBe(true);
    expect(readParked('ios')).toEqual([]);
  });

  test('an unreadable owner identity protects the pool record from adoption and native deletion', () => {
    const path = plantClaim(claimRoot(), 'exclusive', { pid: process.pid, processToken: 'unverifiable' });
    expect(() => adoptParked(request)).toThrow(path);
    let deleted = false;
    expect(() =>
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).toThrow(path);
    expect(deleted).toBe(false);
    expect(readParked('ios')).toEqual([first]);
    expect(getProject('/tmp/adopter')?.platforms?.ios).toBeUndefined();
  });

  test('an owner killed inside the native callback leaves an unresolved claim protecting the device', async () => {
    const child = getExecutor().spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { removeParkedAfter } = await import(process.argv[1]);
         removeParkedAfter('ios', process.argv[2], () => process.kill(process.pid, 'SIGKILL'));`,
        new URL('../sim-pool.ts', import.meta.url).href,
        first.udid,
      ],
      { stdio: 'ignore' },
    );
    expect(await once(child, 'exit')).toEqual([null, 'SIGKILL']);
    expect(readClaimSet(claimRoot()).unresolved).toHaveLength(1);
    expect(() => adoptParked(request)).toThrow(claimRoot());
    let deleted = false;
    expect(() =>
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).toThrow(claimRoot());
    expect(deleted).toBe(false);
    expect(readParked('ios')).toMatchObject([{ ...first, deletionClaim: { kind: 'ownership-claim' } }]);
    expect(legacyAttempt('adopt')).toEqual({ result: null, deleted: false });
    expect(legacyAttempt('delete')).toEqual({ result: null, deleted: false });
  });

  test.each([
    ['record', false],
    ['record', true],
    ['marker', false],
    ['marker', true],
  ] as const)('a replacement pool %s survives a removal callback (throws: %s)', (change, fails) => {
    let replacement: ParkedSim | undefined;
    const remove = () =>
      removeParkedAfter('ios', first.udid, () => {
        withConfigLock(() => {
          const config = loadConfig()!;
          const marked = readParked('ios', { config })[0]!;
          replacement =
            change === 'record'
              ? { ...marked, parkedAt: second.parkedAt }
              : { ...marked, deletionClaim: { kind: 'ownership-claim', claimId: 'replacement' } };
          config.parked = { ios: [replacement] };
          saveConfig(config);
        });
        if (fails) throw new Error('simctl failed');
      });
    let result: unknown;
    try {
      result = remove();
    } catch (error) {
      result = (error as Error).message;
    }
    expect(result).toBe(fails ? 'simctl failed' : null);
    expect(readParked('ios')).toEqual([replacement]);
    const adopted = adoptParked(request);
    expect(adopted).toMatchObject({ ...first, parkedAt: replacement?.parkedAt });
    expect(adopted?.deletionClaim).toBeUndefined();
  });

  test.each([
    { pid: process.pid, token: 'legacy-live' },
    { pid: IMPOSSIBLE_PID, token: 'legacy-gone' },
    { invalid: 'legacy' },
  ])('a legacy inline deletion claim requires field-only manual recovery: %j', (deletionClaim) => {
    withConfigLock(() => {
      const config = loadConfig()!;
      config.parked = { ios: [{ ...first, deletionClaim }] };
      saveConfig(config);
    });
    expect(adoptParked(request)).toBeNull();
    expect(selectParked(readParked('ios'), first)).toEqual([]);
    let deleted = false;
    expect(() =>
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).toThrow(/remove only that record's deletionClaim field/);
    expect(deleted).toBe(false);
    expect(readParked('ios')).toEqual([{ ...first, deletionClaim }]);
  });

  test('a nonblocking refusal releases its waiting fence without touching the active holder', () => {
    plantClaim(claimRoot(), 'shared', liveClaimOwner());
    expect(adoptParked(request)).toBeNull();
    const claims = readClaimSet(claimRoot());
    expect(claims.live.map((claim) => claim.mode)).toEqual(['shared']);
    expect(readParked('ios')).toEqual([first]);
  });
});

test('adoption takes a pool record and creates the owned project claim in one persisted update', () => {
  upsertProject('/tmp/project', { platforms: {} });
  setDevice('/tmp/project', 'ios', { deviceUdid: first.udid, owned: true });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  const device = {
    deviceUdid: first.udid,
    deviceName: 'stim-project (iPhone 17 26.5)',
    owned: true,
    adoptionPending: true,
  };
  expect(adoptParked({ platform: 'ios', projectPath: '/tmp/project', udid: first.udid, device })).toEqual(first);
  expect(readParked('ios')).toEqual([]);
  expect(loadConfig()?.projects['/tmp/project']?.platforms?.ios).toEqual(device);
});

test('malformed and non-Stim pool records are ignored', () => {
  const config = {
    version: 2,
    projects: {},
    repos: {},
    parked: { ios: [{ ...first, name: 'My iPhone' }, { nope: true }, first] },
  };
  expect(readParked('ios', { config }).map((record) => record.udid)).toEqual(['FIRST']);
});

test('parking and adopting a named slot preserve its default and sibling assignments', () => {
  const device = { deviceUdid: first.udid, owned: true };
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: 'DEFAULT', owned: true } },
    deviceSlots: {
      phone: { ios: device },
      tablet: { ios: { deviceUdid: 'TABLET', owned: true } },
    },
  });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', slot: 'phone', record: first, max: 3 });
  expect(getProject('/tmp/project')?.deviceSlots?.phone).toBeUndefined();
  expect(getProject('/tmp/project')?.platforms?.ios?.deviceUdid).toBe('DEFAULT');
  expect(getProject('/tmp/project')?.deviceSlots?.tablet?.ios?.deviceUdid).toBe('TABLET');
  expect(
    adoptParked({ platform: 'ios', projectPath: '/tmp/project', slot: 'second-phone', udid: first.udid, device }),
  ).toEqual(first);
  expect(readParked('ios')).toEqual([]);
  expect(getProject('/tmp/project')?.deviceSlots?.['second-phone']?.ios?.deviceUdid).toBe(first.udid);
  expect(getProject('/tmp/project')?.platforms?.ios?.deviceUdid).toBe('DEFAULT');
});

test('pool transfers refuse to overwrite or clear another device in the same slot', () => {
  const path = '/tmp/project';
  upsertProject(path, {});
  setDevice(path, 'ios', { deviceUdid: first.udid, owned: true }, 'phone');
  expect(() => parkSim({ platform: 'ios', projectPath: path, slot: 'phone', record: second, max: 3 })).toThrow(
    /assignment changed/,
  );
  expect(readParked('ios')).toEqual([]);
  parkSim({ platform: 'ios', projectPath: path, slot: 'phone', record: first, max: 3 });
  setDevice(path, 'ios', { deviceUdid: second.udid, owned: true }, 'phone');
  expect(
    adoptParked({
      platform: 'ios',
      projectPath: path,
      slot: 'phone',
      udid: first.udid,
      device: { deviceUdid: first.udid, owned: true },
    }),
  ).toBeNull();
  expect(getProject(path)?.deviceSlots?.phone?.ios?.deviceUdid).toBe(second.udid);
  expect(readParked('ios')).toEqual([first]);
});

test('a rare tablet is evicted by later phone parking under the shared platform cap', () => {
  const root = '/tmp/rare-model';
  const tablet = { ...first, deviceTypeIdentifier: 'ipad-pro' };
  upsertProject(root, {});
  setDevice(root, 'ios', { owned: true, deviceUdid: tablet.udid }, 'tablet');
  expect(parkSim({ platform: 'ios', projectPath: root, slot: 'tablet', record: tablet, max: 1 })).toEqual([]);
  setDevice(root, 'ios', { owned: true, deviceUdid: second.udid }, 'phone');
  expect(parkSim({ platform: 'ios', projectPath: root, slot: 'phone', record: second, max: 1 })).toEqual([tablet]);
});
