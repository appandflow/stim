import { AgentDriverUnavailable, loadAgentDriver, loadAgentDriverModule, runAgentDriverContract } from '../index.ts';

const input = { env: {}, stateDir: '/nonexistent/state', claimRoot: '/nonexistent/claims' };
const app = { client: 'client', session: '11111111-1111-4111-8111-111111111111', bundleId: 'dev.example.app', pid: 42 };

function driver(name = 'fake', start = () => Promise.reject(new AgentDriverUnavailable('fake is not installed.'))) {
  return {
    name,
    start,
    stop: () => Promise.resolve(),
    issue: () => Promise.reject(new Error('not running')),
    revoke: () => Promise.resolve(),
    forward: (_session: string, _request: unknown, response: { writeHead(status: number): { end(): void } }) =>
      response.writeHead(503).end(),
    onExit: () => undefined,
  };
}

const fake = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 1,
  id: 'fake',
  createAgentDriver: () => driver(),
  ...overrides,
});

test('a module that is not a version 1 driver with the expected id is unavailable, never a throw', async () => {
  const unavailable = async (load: () => Promise<unknown>) => {
    const loaded = await loadAgentDriverModule('fake', load, 20);
    return 'unavailable' in loaded ? loaded.unavailable : null;
  };
  expect(await unavailable(() => Promise.reject(new Error('Cannot find package x\n  at stack')))).toBe(
    'Cannot find package x',
  );
  expect(await unavailable(() => Promise.resolve(fake({ apiVersion: 2 })))).toBe('expected apiVersion 1, found 2');
  expect(await unavailable(() => Promise.resolve({ default: fake() }))).toBeNull();
  expect(await unavailable(() => Promise.resolve(fake({ id: 'other' })))).toBe('expected id "fake", found "other"');
  expect(await unavailable(() => Promise.resolve(fake({ createAgentDriver: undefined })))).toBe(
    'the module does not export createAgentDriver()',
  );
  expect(await unavailable(() => Promise.resolve(fake({ client: { access: () => null } })))).toBe(
    'the client capability must name configFile and implement access()',
  );
  expect(await unavailable(() => new Promise(() => undefined))).toBe('the module did not load within 20ms');
});

test('a factory that throws or returns a driver under another name is unavailable', async () => {
  const throwing = fake({
    createAgentDriver: () => {
      throw new Error('bad options');
    },
  });
  expect(await loadAgentDriver('fake', () => Promise.resolve(throwing), input)).toEqual({
    unavailable: 'createAgentDriver() failed: bad options',
  });
  const renamed = fake({ createAgentDriver: () => driver('other') });
  expect(await loadAgentDriver('fake', () => Promise.resolve(renamed), input)).toEqual({
    unavailable: 'the driver is named "other", not "fake"',
  });
});

test('a module or factory that fails in an unusual way is unavailable, never a rejection', async () => {
  const unhandled = vi.fn<(reason: unknown) => void>();
  process.on('unhandledRejection', unhandled);
  try {
    expect(await loadAgentDriverModule('fake', () => Promise.resolve(fake({ apiVersion: 2n })))).toEqual({
      unavailable: expect.any(String),
    });
    const getter = fake();
    Object.defineProperty(getter, 'client', {
      get() {
        throw new Error('no client');
      },
    });
    expect(await loadAgentDriverModule('fake', () => Promise.resolve(getter))).toEqual({ unavailable: 'no client' });
    const async = fake({ createAgentDriver: () => Promise.reject(new Error('later')) });
    expect(await loadAgentDriver('fake', () => Promise.resolve(async), input)).toEqual({
      unavailable: 'createAgentDriver() must return the driver, not a promise',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('the contract kit fails a driver whose forward() throws or never answers', async () => {
  const run = (forward: () => void) =>
    runAgentDriverContract({
      id: 'fake',
      load: () => Promise.resolve(fake({ createAgentDriver: () => ({ ...driver(), forward }) })),
      unavailableInput: input,
      app,
      checkTimeoutMs: 200,
    });
  const failedNames = async (forward: () => void) =>
    (await run(forward)).filter((result) => !result.passed).map((result) => result.name);
  const throwing = await failedNames(() => {
    throw new Error('boom');
  });
  expect(throwing).toHaveLength(1);
  expect(await failedNames(() => undefined)).toEqual(throwing);
});

test('the contract kit fails a driver that reports a missing tool as a plain error', async () => {
  const passing = await runAgentDriverContract({
    id: 'fake',
    load: () => Promise.resolve(fake()),
    unavailableInput: input,
    app,
  });
  expect(passing.filter((result) => !result.passed)).toEqual([]);
  const plain = fake({ createAgentDriver: () => driver('fake', () => Promise.reject(new Error('ENOENT'))) });
  const failing = await runAgentDriverContract({
    id: 'fake',
    load: () => Promise.resolve(plain),
    unavailableInput: input,
    app,
  });
  expect(failing.filter((result) => !result.passed).map((result) => result.name)).toEqual([
    'start refuses with AgentDriverUnavailable when the tool is missing, then stops',
  ]);
});
