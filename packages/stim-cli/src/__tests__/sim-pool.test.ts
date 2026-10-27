import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProject, loadConfig, saveConfig, setDevice, upsertProject, withConfigLock } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { runReport } from '../report-runtime.ts';
import * as identities from '../process-identity.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import { readClaimSet } from '../ownership-claim.ts';
import { IMPOSSIBLE_PID, liveClaimOwner, plantClaim, recycledClaimOwner } from './_factories.ts';
import {
  adoptParked,
  evictOverflow,
  parkSim,
  parkedMaxSetting,
  readParked,
  removeParkedAfter,
  selectParked,
  type ParkedSim,
} from '../devices/sim-pool.ts';

const KILLED_EXIT = process.platform === 'win32' ? [1, null] : [null, 'SIGKILL'];

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
  expect(parkedMaxSetting('ios', { config: null, env: {} })).toEqual({ max: 3, error: null });
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

test('parking carries the workspace scheme approvals into the pool record', () => {
  const schemeApprovals = ['com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app'];
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-project', owned: true, schemeApprovals } },
  });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  expect(readParked('ios')).toEqual([expect.objectContaining({ udid: first.udid, schemeApprovals })]);
});

test('parking without recorded scheme approvals leaves the pool record without the field', () => {
  upsertProject('/tmp/project', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-project', owned: true } },
  });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  expect(readParked('ios')[0]).not.toHaveProperty('schemeApprovals');
});

test('adoption restores scheme approvals from the locked pool record, not a stale caller value', async () => {
  const schemeApprovals = ['com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app'];
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true, schemeApprovals } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  // The caller's device object (built before adoptParked takes its lock) carries a stale value of its own.
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true, schemeApprovals: ['stale'] };
  const adopted = await adoptParked({ platform: 'ios', projectPath: '/tmp/adopter', udid: first.udid, device });
  expect(adopted?.schemeApprovals).toEqual(schemeApprovals);
  expect(getProject('/tmp/adopter')?.platforms?.ios).toMatchObject({ schemeApprovals });
});

test('adoption leaves the device record without scheme approvals when the pool record has none', async () => {
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  await adoptParked({ platform: 'ios', projectPath: '/tmp/adopter', udid: first.udid, device });
  expect(getProject('/tmp/adopter')?.platforms?.ios).not.toHaveProperty('schemeApprovals');
});

test('overflow records stay claimed until deletion succeeds', async () => {
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

  await expect(
    removeParkedAfter('ios', first.udid, () => {
      throw new Error('simctl busy');
    }),
  ).rejects.toThrow(/simctl busy/);
  expect(
    readParked('ios')
      .map((record) => record.udid)
      .toSorted(),
  ).toEqual(['FIRST', 'SECOND']);

  expect(await removeParkedAfter('ios', first.udid, () => {})).toEqual(first);
  expect(readParked('ios').map((record) => record.udid)).toEqual(['SECOND']);
});

test('unresolved native cleanup keeps the pool claim and prevents another workspace adopting the device', async () => {
  upsertProject('/tmp/source', { platforms: { ios: { deviceUdid: first.udid, deviceName: first.name, owned: true } } });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const controller = new AbortController();
  const context: StimContext = {
    home: stimHome,
    projectRoot: stimHome,
    cwd: stimHome,
    env: { ...process.env, STIM_HOME: stimHome },
    buildCache: null,
    runId: 'pool-cleanup',
    signal: controller.signal,
    output: () => {},
  };
  const root = join(stimHome, 'pool-locks', 'ios', 'first.lock');
  let owned: { pid: number; processToken: string } | undefined;
  let closed: Promise<void> = Promise.resolve();
  const inspect = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('unknown');
  try {
    const failure = await runReport(context, (operation) =>
      withAmbientContext(operation, () =>
        removeParkedAfter(
          'ios',
          first.udid,
          async () => {
            await getExecutor().runFileAsync(
              process.execPath,
              ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
              {
                timeoutMs: 10000,
                declareFor: operation,
                onSpawn: (child) => {
                  const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
                  if (child.pid === undefined || !captured?.ok)
                    throw new Error('The fixture child has no verified identity');
                  owned = { pid: child.pid, processToken: captured.token };
                  closed = new Promise((resolve) => child.once('close', () => resolve()));
                  child.stdout?.once('data', () => controller.abort());
                },
              },
            );
          },
          operation,
        ),
      ),
    ).catch((error: unknown) => error);
    const held = readClaimSet(root).live[0];
    expect(held).toBeDefined();
    if (!held) throw new Error('The unresolved fixture claim was released');
    expect(failure).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', remedy: expect.stringContaining(held.path) });
    expect(held).toMatchObject({ childDeclared: true, child: owned });
    expect(readParked('ios')[0]).toHaveProperty('deletionClaim');
    expect(
      await adoptParked({
        platform: 'ios',
        projectPath: '/tmp/adopter',
        udid: first.udid,
        device: { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true },
      }),
    ).toBeNull();
  } finally {
    inspect.mockRestore();
    controller.abort();
    if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
    await closed;
    if (owned) await waitForProcessExit(owned, 2000);
  }
});

test('a deletion claim skips a simulator that another workspace adopted', async () => {
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  await adoptParked({ platform: 'ios', projectPath: '/tmp/adopter', udid: first.udid, device });
  let deleted = false;

  expect(
    await removeParkedAfter('ios', first.udid, () => {
      deleted = true;
    }),
  ).toBe(null);
  expect(deleted).toBe(false);
  expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(device);
});

test('a live deletion claim blocks adoption beyond the ordinary lock stale window', async () => {
  upsertProject('/tmp/source', {
    platforms: { ios: { deviceUdid: first.udid, deviceName: 'stim-source', owned: true } },
  });
  upsertProject('/tmp/adopter', { platforms: {} });
  parkSim({ platform: 'ios', projectPath: '/tmp/source', record: first, max: 3 });
  const device = { deviceUdid: first.udid, deviceName: 'stim-adopter', owned: true };
  let childResult = '';

  const removed = await removeParkedAfter('ios', first.udid, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_250);
    const script = `
        const { adoptParked, removeParkedAfter } = await import(process.argv[1]);
        const request = JSON.parse(process.argv[2]);
        let deleted = false;
        const result = await removeParkedAfter(request.platform, request.udid, () => { deleted = true; });
        process.stdout.write(JSON.stringify({ adopted: await adoptParked(request), removed: result, deleted }));
      `;
    childResult = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        new URL('../devices/sim-pool.ts', import.meta.url).href,
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
             ? await adoptParked(request)
             : removeParkedAfter(request.platform, request.udid, () => { deleted = true; });
           process.stdout.write(JSON.stringify({ result, deleted }));`,
          pathToFileURL(module).href,
          JSON.stringify(request),
          action,
        ],
        { encoding: 'utf8', env: process.env, timeout: 5000 },
      ),
    );
  }

  test.each(['adopt', 'delete'] as const)('an older CLI cannot %s during a new deletion', async (action) => {
    const removed = await removeParkedAfter('ios', first.udid, () => {
      expect(legacyAttempt(action)).toEqual({ result: null, deleted: false });
      expect(getProject('/tmp/adopter')?.platforms?.ios).toBeUndefined();
    });
    expect(removed).toEqual(first);
    expect(readParked('ios')).toEqual([]);
  });

  async function killOwnerAfterMarking(): Promise<void> {
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
    expect(await once(child, 'exit')).toEqual(KILLED_EXIT);
    expect(readClaimSet(claimRoot()).dead).toHaveLength(1);
  }

  test.each(['adopt', 'delete'])(
    '%s recovers a claim after its owner is killed outside native work',
    async (action) => {
      await killOwnerAfterMarking();
      expect(selectParked(readParked('ios'), first)).toMatchObject([first]);
      let deleted = false;
      const result =
        action === 'adopt'
          ? await adoptParked(request)
          : await removeParkedAfter('ios', first.udid, () => {
              deleted = true;
            });
      expect(result).toEqual(first);
      expect(deleted).toBe(action === 'delete');
      expect(readParked('ios')).toEqual([]);
      expect(readClaimSet(claimRoot()).dead).toEqual([]);
      expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(action === 'adopt' ? device : undefined);
    },
  );

  test('adoption after an owner died between marking and persisting drops what an erase would have cleared', async () => {
    const schemeApprovals = ['com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app'];
    withConfigLock(() => {
      const config = loadConfig()!;
      config.parked = { ios: [{ ...first, bundleId: 'com.example.app', cacheKey: 'before-erase', schemeApprovals }] };
      saveConfig(config);
    });
    await killOwnerAfterMarking();
    expect(selectParked(readParked('ios'), first)).toMatchObject([first]);

    const adopted = await adoptParked(request);

    expect(adopted).toEqual(first);
    expect(getProject('/tmp/adopter')?.platforms?.ios).toEqual(device);
    expect(readParked('ios')).toEqual([]);
    expect(readClaimSet(claimRoot())).toMatchObject({ live: [], dead: [], unresolved: [] });
  });

  test('a reused owner PID does not prevent adoption or deletion', async () => {
    plantClaim(claimRoot(), 'exclusive', recycledClaimOwner());
    expect(await adoptParked(request)).toEqual(first);
    parkSim({ platform: 'ios', projectPath: '/tmp/adopter', record: first, max: 3 });
    plantClaim(claimRoot(), 'exclusive', recycledClaimOwner());
    let deleted = false;
    expect(
      await removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).toEqual(first);
    expect(deleted).toBe(true);
    expect(readParked('ios')).toEqual([]);
  });

  test('an unreadable owner identity protects the pool record from adoption and native deletion', async () => {
    const path = plantClaim(claimRoot(), 'exclusive', { pid: process.pid, processToken: 'unverifiable' });
    await expect(adoptParked(request)).rejects.toThrow(path);
    let deleted = false;
    await expect(
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).rejects.toThrow(path);
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
        new URL('../devices/sim-pool.ts', import.meta.url).href,
        first.udid,
      ],
      { stdio: 'ignore' },
    );
    expect(await once(child, 'exit')).toEqual(KILLED_EXIT);
    expect(readClaimSet(claimRoot()).unresolved).toHaveLength(1);
    await expect(adoptParked(request)).rejects.toThrow(claimRoot());
    let deleted = false;
    await expect(
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).rejects.toThrow(claimRoot());
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
  ] as const)('a replacement pool %s survives a removal callback (throws: %s)', async (change, fails) => {
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
      result = await remove();
    } catch (error) {
      result = (error as Error).message;
    }
    expect(result).toBe(fails ? 'simctl failed' : null);
    expect(readParked('ios')).toEqual([replacement]);
    const adopted = await adoptParked(request);
    expect(adopted).toMatchObject({ ...first, parkedAt: replacement?.parkedAt });
    expect(adopted?.deletionClaim).toBeUndefined();
  });

  test.each([
    { pid: process.pid, token: 'legacy-live' },
    { pid: IMPOSSIBLE_PID, token: 'legacy-gone' },
    { invalid: 'legacy' },
  ])('a legacy inline deletion claim requires field-only manual recovery: %j', async (deletionClaim) => {
    withConfigLock(() => {
      const config = loadConfig()!;
      config.parked = { ios: [{ ...first, deletionClaim }] };
      saveConfig(config);
    });
    expect(await adoptParked(request)).toBeNull();
    expect(selectParked(readParked('ios'), first)).toEqual([]);
    let deleted = false;
    await expect(
      removeParkedAfter('ios', first.udid, () => {
        deleted = true;
      }),
    ).rejects.toThrow(/remove only that record's deletionClaim field/);
    expect(deleted).toBe(false);
    expect(readParked('ios')).toEqual([{ ...first, deletionClaim }]);
  });

  test('a nonblocking refusal releases its waiting fence without touching the active holder', async () => {
    plantClaim(claimRoot(), 'shared', liveClaimOwner());
    expect(await adoptParked(request)).toBeNull();
    const claims = readClaimSet(claimRoot());
    expect(claims.live.map((claim) => claim.mode)).toEqual(['shared']);
    expect(readParked('ios')).toEqual([first]);
  });
});

test('adoption takes a pool record and creates the owned project claim in one persisted update', async () => {
  upsertProject('/tmp/project', { platforms: {} });
  setDevice('/tmp/project', 'ios', { deviceUdid: first.udid, owned: true });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  const device = {
    deviceUdid: first.udid,
    deviceName: 'stim-project (iPhone 17 26.5)',
    owned: true,
    adoptionPending: true,
  };
  expect(await adoptParked({ platform: 'ios', projectPath: '/tmp/project', udid: first.udid, device })).toEqual(first);
  expect(readParked('ios')).toEqual([]);
  expect(loadConfig()?.projects['/tmp/project']?.platforms?.ios).toEqual(device);
});

test('adoption waits for a config lock held by another process without blocking the event loop', async () => {
  upsertProject('/tmp/project', { platforms: {} });
  setDevice('/tmp/project', 'ios', { deviceUdid: first.udid, owned: true });
  parkSim({ platform: 'ios', projectPath: '/tmp/project', record: first, max: 3 });
  const holder = getExecutor().spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        const { withConfigLock } = await import(process.argv[1]);
        withConfigLock(() => {
          process.stdout.write('held');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
        });
      `,
      new URL('../workspace/config.ts', import.meta.url).href,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(holder, 'exit');
  const { stdout } = holder;
  if (!stdout) throw new Error('the holder has no stdout');
  try {
    await once(stdout, 'data');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const device = { deviceUdid: first.udid, deviceName: 'stim-project (iPhone 17 26.5)', owned: true };
    try {
      expect(await adoptParked({ platform: 'ios', projectPath: '/tmp/project', udid: first.udid, device })).toEqual(
        first,
      );
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
    expect(loadConfig()?.projects['/tmp/project']?.platforms?.ios).toEqual(device);
  } finally {
    holder.kill('SIGKILL');
    await exited;
  }
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

test('parking and adopting a named slot preserve its default and sibling assignments', async () => {
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
    await adoptParked({ platform: 'ios', projectPath: '/tmp/project', slot: 'second-phone', udid: first.udid, device }),
  ).toEqual(first);
  expect(readParked('ios')).toEqual([]);
  expect(getProject('/tmp/project')?.deviceSlots?.['second-phone']?.ios?.deviceUdid).toBe(first.udid);
  expect(getProject('/tmp/project')?.platforms?.ios?.deviceUdid).toBe('DEFAULT');
});

test('pool transfers refuse to overwrite or clear another device in the same slot', async () => {
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
    await adoptParked({
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
