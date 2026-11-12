import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { teardownUnavailableOwnedIosSim } from '../devices/teardown.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import type { SimRuntimeRecord } from '../commands/gc/inventory.ts';
import { collectsEngineStore } from '../commands/gc.ts';
import { testContext } from './_context.ts';
import {
  deleteRuntimeAction,
  runtimePins,
  selectUnusedRuntimes,
  unavailableSimsToDelete,
} from '../stimd/passes/runtimes.ts';

const runtime = (version: string, overrides: Partial<SimRuntimeRecord> = {}): SimRuntimeRecord => ({
  identifier: `IMG-${version}`,
  runtimeIdentifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`,
  version,
  build: null,
  sizeBytes: 8e9,
  deletable: true,
  lastUsedAt: null,
  ...overrides,
});
const sim = (version: string) => ({ runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}` });

test.each([
  { name: 'the only installed runtime stays', runtimes: [runtime('26.2')], sims: [], take: [] },
  {
    name: 'a runtime any simulator uses, a user one included, stays',
    runtimes: [runtime('26.2'), runtime('27.0')],
    sims: [sim('27.0')],
    take: ['IMG-26.2'],
  },
  {
    name: 'a runtime simctl does not mark deletable stays',
    runtimes: [runtime('26.2', { deletable: false }), runtime('27.0')],
    sims: [sim('27.0')],
    take: [],
  },
  {
    name: 'a runtime of the active Xcode SDK major version stays though no simulator uses it',
    runtimes: [
      runtime('26.2', { lastUsedAt: '2020-01-01T00:00:00Z' }),
      runtime('27.0', { lastUsedAt: '2020-01-01T00:00:00Z' }),
      runtime('18.6', { lastUsedAt: '2020-01-01T00:00:00Z' }),
    ],
    sims: [sim('18.6')],
    recent: { sdk: '27.1', since: Date.parse('2026-01-01T00:00:00Z') },
    take: ['IMG-26.2'],
  },
  {
    name: 'a runtime simctl records as used recently, or never, stays',
    runtimes: [runtime('26.2', { lastUsedAt: '2026-06-01T00:00:00Z' }), runtime('26.1'), runtime('27.0')],
    sims: [sim('27.0')],
    recent: { sdk: '27.0', since: Date.parse('2026-01-01T00:00:00Z') },
    take: [],
  },
  {
    name: 'a runtime a project pins with ios.runtime stays though no simulator uses it',
    runtimes: [runtime('26.2'), runtime('27.0')],
    sims: [sim('27.0')],
    pinned: ['26.2'],
    take: [],
  },
  {
    name: 'when no simulator uses any runtime the newest stays',
    runtimes: [runtime('27.0'), runtime('26.2'), runtime('26.10')],
    sims: [],
    take: ['IMG-26.2', 'IMG-26.10'],
  },
])('$name', ({ runtimes, sims, pinned = [], recent, take }) => {
  expect(selectUnusedRuntimes(runtimes, sims, pinned, recent).take.map((entry) => entry.identifier)).toEqual(take);
});

describe('deleting a runtime', () => {
  const calls: string[][] = [];
  let simsJson = '';
  let home = '';
  const image = (version: string) => ({
    identifier: `IMG-${version}`,
    runtimeIdentifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`,
    version,
    deletable: true,
    sizeBytes: 8e9,
    lastUsedAt: '2020-01-01T00:00:00Z',
    platformIdentifier: 'com.apple.platform.iphonesimulator',
  });
  const runtimesJson = JSON.stringify({ 'IMG-26.2': image('26.2'), 'IMG-27.0': image('27.0') });
  const device = (runtimeId: string, isAvailable = true) =>
    JSON.stringify({
      devices: {
        [runtimeId]: [{ udid: 'U1', name: 'My iPhone', state: 'Shutdown', deviceTypeIdentifier: 'x', isAvailable }],
      },
    });
  const unscoped = () => testContext({ env: { ...process.env, STIM_HOME: undefined } });
  const remove = (operation = unscoped()) =>
    deleteRuntimeAction({ kind: 'would-delete-runtime', target: 'IMG-26.2', bytes: 0, reason: '' }, operation);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-runtime-delete-'));
    vi.stubEnv('STIM_HOME', home);
    calls.length = 0;
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        calls.push([file, ...args]);
        if (args[1] === 'list') return simsJson;
        if (args[1] === 'runtime' && args[2] === 'list') return runtimesJson;
        return '';
      },
      runFileQuietAsync: async (file, args) => (file === 'xcrun' && args[0] === '--sdk' ? '27.1\n' : null),
    });
  });
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  test('runs simctl runtime delete for an unused image after listing again', async () => {
    simsJson = device('com.apple.CoreSimulator.SimRuntime.iOS-27-0');
    expect((await remove()).status).toBe('done');
    expect(calls).toContainEqual(['xcrun', 'simctl', 'runtime', 'delete', 'IMG-26.2']);
  });

  test.each([
    { name: 'a simulator started using it since the plan', available: true },
    { name: 'only an unavailable simulator uses it', available: false },
  ])('keeps an image when $name', async ({ available }) => {
    simsJson = device('com.apple.CoreSimulator.SimRuntime.iOS-26-2', available);
    expect(await remove()).toMatchObject({ status: 'kept', detail: '1 simulator uses it' });
    expect(calls.some((call) => call.includes('delete'))).toBe(false);
  });

  test('refuses from a scoped home and keeps the image', async () => {
    simsJson = device('com.apple.CoreSimulator.SimRuntime.iOS-27-0');
    expect((await remove(testContext())).status).toBe('kept');
    expect(calls).toEqual([]);
  });
});

describe('an owned simulator whose runtime is gone', () => {
  const calls: string[][] = [];
  let home = '';
  const listing = (name: string, available: boolean) =>
    JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
          { udid: 'U1', name, state: 'Shutdown', deviceTypeIdentifier: 'x', isAvailable: available },
        ],
      },
    });
  let simsJson = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-runtimes-'));
    vi.stubEnv('STIM_HOME', home);
    calls.length = 0;
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        calls.push([file, ...args]);
        return args[1] === 'list' ? simsJson : '';
      },
    });
  });
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  test.each([
    { name: 'is deleted when this home created it', ledger: true, available: false, deleted: true },
    { name: 'stays when a person created it', ledger: false, available: false, deleted: false },
    { name: 'stays while its runtime is installed', ledger: true, available: true, deleted: false },
  ])('$name', async ({ ledger, available, deleted }) => {
    simsJson = listing('stim-app (iPhone 17 26.2)', available);
    if (ledger) recordCreatedDevice('ios', 'U1');
    const outcome = await teardownUnavailableOwnedIosSim('U1');
    expect(outcome.status === 'torn-down').toBe(deleted);
    expect(calls.some((call) => call.join(' ') === 'xcrun simctl delete U1')).toBe(deleted);
  });
});

test('a project whose settings cannot be read blocks runtime cleanup, and a provably gone one does not', () => {
  expect(
    runtimePins([
      { path: '/a', state: 'resolved', pin: '26.2' },
      { path: '/gone', state: 'gone' },
    ]),
  ).toEqual({ pins: ['26.2'], unresolved: [] });
  expect(
    runtimePins([
      { path: '/a', state: 'resolved', pin: null },
      { path: '/Volumes/off/app', state: 'unresolved', reason: 'its path cannot be reached' },
    ]).unresolved,
  ).toEqual(['/Volumes/off/app: its path cannot be reached']);
});

test('maintenance deletes only unavailable owned simulators no registered workspace records', () => {
  const sims = [
    { udid: 'PARKED', available: false },
    { udid: 'WORKSPACE', available: false },
    { udid: 'LIVE', available: true },
  ];
  expect(unavailableSimsToDelete(sims, new Set(['WORKSPACE'])).map((entry) => entry.udid)).toEqual(['PARKED']);
});

describe('the shared engine store', () => {
  let root = '';
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-scope-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test.each([
    { name: 'the default home collects it', scoped: false, inside: false, collects: true },
    { name: 'a scoped home leaves a store outside it', scoped: true, inside: false, collects: false },
    { name: 'a scoped home collects a store inside it', scoped: true, inside: true, collects: true },
  ])('$name', ({ scoped, inside, collects }) => {
    const home = join(root, 'home');
    const store = inside ? join(home, 'engine') : join(root, 'shared', 'engine');
    mkdirSync(store, { recursive: true });
    mkdirSync(home, { recursive: true });
    expect(collectsEngineStore(scoped ? { STIM_HOME: home } : {}, store, home)).toBe(collects);
  });
});
