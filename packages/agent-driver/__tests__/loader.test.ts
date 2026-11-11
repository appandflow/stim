import { agentDriverUnavailable, loadAgentDriver, loadAgentDriverModule } from '../index.ts';

const input = { env: {}, stateDir: '/nonexistent/state', claimRoot: '/nonexistent/claims' };

function driver(name = 'fake', start = () => Promise.reject(agentDriverUnavailable('fake is not installed.'))) {
  return {
    name,
    start,
    stop: () => Promise.resolve(),
    issue: () => Promise.reject(new Error('not running')),
    revoke: () => Promise.resolve(),
    target: () => Promise.resolve(null),
    onExit: () => () => undefined,
  };
}

const manifest = () => ({ stimPlugin: { kinds: { 'agent-driver': 1 } } });
const source = (module: unknown) => ({ manifest, load: () => Promise.resolve(module) });

const fake = (overrides: Record<string, unknown> = {}) => ({
  id: 'fake',
  createAgentDriver: () => driver(),
  ...overrides,
});

test('a module that is not a version 1 driver with the expected id is unavailable, never a throw', async () => {
  const unavailable = async (load: () => Promise<unknown>) => {
    const loaded = await loadAgentDriverModule('fake', { load, manifest }, 20);
    return 'unavailable' in loaded ? loaded.unavailable : null;
  };
  expect(await unavailable(() => Promise.reject(new Error('Cannot find package x\n  at stack')))).toBe(
    'Cannot find package x',
  );
  const incompatible = await loadAgentDriverModule('fake', {
    manifest: () => ({ stimPlugin: { kinds: { 'agent-driver': 2 } } }),
    load: () => {
      throw new Error('imported');
    },
  });
  expect(incompatible).toEqual({
    unavailable: 'plugin fake speaks agent-driver 2, this stim speaks 1: stim engine update',
  });
  expect(await unavailable(() => Promise.resolve({ default: fake() }))).toBeNull();
  expect(await unavailable(() => Promise.resolve(fake({ id: 'other' })))).toBe('expected id "fake", found "other"');
  expect(await unavailable(() => Promise.resolve(fake({ createAgentDriver: undefined })))).toBe(
    'the module does not export createAgentDriver()',
  );
  expect(await unavailable(() => Promise.resolve(fake({ client: {} })))).toBe(
    'the client capability must implement access()',
  );
  const blocked = unavailable(() => new Promise(() => undefined));
  await vi.advanceTimersByTimeAsync(20);
  expect(await blocked).toBe('the module did not load within 20ms');
});

test('a factory that throws or returns a driver under another name is unavailable', async () => {
  const throwing = fake({
    createAgentDriver: () => {
      throw new Error('bad options');
    },
  });
  expect(await loadAgentDriver('fake', source(throwing), input)).toEqual({
    unavailable: 'createAgentDriver() failed: bad options',
  });
  const renamed = fake({ createAgentDriver: () => driver('other') });
  expect(await loadAgentDriver('fake', source(renamed), input)).toEqual({
    unavailable: 'the driver is named "other", not "fake"',
  });
});

test('a module or factory that fails in an unusual way is unavailable, never a rejection', async () => {
  const unhandled = vi.fn<(reason: unknown) => void>();
  process.on('unhandledRejection', unhandled);
  try {
    expect(await loadAgentDriverModule('fake', source(null))).toEqual({
      unavailable: expect.any(String),
    });
    const getter = fake();
    Object.defineProperty(getter, 'client', {
      get() {
        throw new Error('no client');
      },
    });
    expect(await loadAgentDriverModule('fake', source(getter))).toEqual({ unavailable: 'no client' });
    const async = fake({ createAgentDriver: () => Promise.reject(new Error('later')) });
    expect(await loadAgentDriver('fake', source(async), input)).toEqual({
      unavailable: 'createAgentDriver() failed: later',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('awaits an async driver factory and stops a driver returned after the deadline', async () => {
  const stop = vi.fn<() => Promise<void>>(async () => {});
  const module = fake({ createAgentDriver: async () => ({ ...driver(), stop }) });
  expect(await loadAgentDriver('fake', source(module), input)).toHaveProperty('driver');
  const pending = loadAgentDriver(
    'fake',
    source(
      fake({
        createAgentDriver: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { ...driver(), stop };
        },
      }),
    ),
    input,
    10,
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual({ unavailable: 'the module did not load within 10ms' });
  await vi.advanceTimersByTimeAsync(30);
  expect(stop).toHaveBeenCalledOnce();
});
