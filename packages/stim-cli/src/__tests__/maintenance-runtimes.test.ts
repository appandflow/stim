import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import type { SimRuntimeRecord } from '../commands/gc/inventory.ts';
import { deleteRuntimeAction, selectUnusedRuntimes } from '../stimd/passes/runtimes.ts';

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
    name: 'when no simulator uses any runtime the newest stays',
    runtimes: [runtime('27.0'), runtime('26.2'), runtime('26.10')],
    sims: [],
    take: ['IMG-26.2', 'IMG-26.10'],
  },
])('$name', ({ runtimes, sims, take }) => {
  expect(selectUnusedRuntimes(runtimes, sims).take.map((entry) => entry.identifier)).toEqual(take);
});

describe('deleting a runtime', () => {
  const calls: string[][] = [];
  let simsJson = '';
  const runtimesJson = JSON.stringify({
    'IMG-26.2': {
      identifier: 'IMG-26.2',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      version: '26.2',
      deletable: true,
      sizeBytes: 8e9,
      platformIdentifier: 'com.apple.platform.iphonesimulator',
    },
    'IMG-27.0': {
      identifier: 'IMG-27.0',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      version: '27.0',
      deletable: true,
      sizeBytes: 8e9,
      platformIdentifier: 'com.apple.platform.iphonesimulator',
    },
  });
  const device = (runtimeId: string) =>
    JSON.stringify({
      devices: {
        [runtimeId]: [
          { udid: 'U1', name: 'My iPhone', state: 'Shutdown', deviceTypeIdentifier: 'x', isAvailable: true },
        ],
      },
    });

  beforeEach(() => {
    calls.length = 0;
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        calls.push([file, ...args]);
        if (args[1] === 'list') return simsJson;
        if (args[1] === 'runtime' && args[2] === 'list') return runtimesJson;
        return '';
      },
    });
  });
  afterEach(() => resetExecutor());

  test('runs simctl runtime delete for an unused image after listing again', async () => {
    simsJson = device('com.apple.CoreSimulator.SimRuntime.iOS-27-0');
    const outcome = await deleteRuntimeAction({
      kind: 'would-delete-runtime',
      target: 'IMG-26.2',
      bytes: 0,
      reason: '',
    });
    expect(outcome.status).toBe('done');
    expect(calls).toContainEqual(['xcrun', 'simctl', 'runtime', 'delete', 'IMG-26.2']);
  });

  test('keeps an image a simulator started using since the plan', async () => {
    simsJson = device('com.apple.CoreSimulator.SimRuntime.iOS-26-2');
    const outcome = await deleteRuntimeAction({
      kind: 'would-delete-runtime',
      target: 'IMG-26.2',
      bytes: 0,
      reason: '',
    });
    expect(outcome).toMatchObject({ status: 'kept', detail: '1 simulator uses it' });
    expect(calls.some((call) => call.includes('delete'))).toBe(false);
  });
});
