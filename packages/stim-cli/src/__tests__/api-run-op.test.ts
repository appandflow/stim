import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStim, runOp, StimError } from '../api.ts';
import type { RunOp } from '../api/engine-route.ts';

const engine = vi.hoisted((): { runOp: RunOp | null } => ({ runOp: null }));
vi.mock('../api/engine-route.ts', () => ({ engineRunOp: () => Promise.resolve(engine.runOp) }));

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-api-run-op-')));
});
afterEach(() => {
  engine.runOp = null;
  rmSync(scratch, { recursive: true, force: true });
});

describe('runOp', () => {
  it('runs the named operation of a client made from ctx and resolves its result', async () => {
    const ctx = { projectRoot: scratch, home: join(scratch, 'home') };
    const identity = await runOp('identity', [], ctx);
    expect(identity).toBe(await createStim(ctx).identity());
  });

  it.each([
    ['an operation this build does not have', 'teleport', [], 'STIM_BAD_ARG'],
    ['an operation that refuses', 'setSetting', ['no.such.setting', 'x'], 'STIM_BAD_ARG'],
  ])('rejects %s with a plain failure another build can wrap', async (_name, op, args, code) => {
    const failure = await runOp(op, args, { projectRoot: scratch, home: join(scratch, 'home') }).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code, message: expect.any(String) });
  });
});

describe('createStim', () => {
  it('runs each operation in the selected engine of another build and wraps its plain failure', async () => {
    const calls: unknown[][] = [];
    engine.runOp = async (...call) => {
      calls.push(call);
      if (call[0] === 'build') throw { code: 'STIM_BUILD_FAILED', message: 'no', remedy: 'retry' };
      return 'engine identity';
    };
    const client = createStim({ projectRoot: scratch, home: join(scratch, 'home') });
    expect(await client.identity()).toBe('engine identity');
    const build = await client.build({ platform: 'android' }).catch((error: unknown) => error);
    expect(build).toBeInstanceOf(StimError);
    expect(build).toMatchObject({ code: 'STIM_BUILD_FAILED', remedy: 'retry' });
    expect(calls.map(([name, args]) => [name, args])).toEqual([
      ['identity', []],
      ['build', [{ platform: 'android' }]],
    ]);
  });

  it('sends an engine of another build the operation and option names engines read', async () => {
    const calls: unknown[][] = [];
    engine.runOp = async (...call) => {
      calls.push(call);
      return null;
    };
    const buildCacheDir = join(scratch, 'cache');
    const client = createStim({ projectRoot: scratch, home: join(scratch, 'home'), buildCacheDir });
    await client.previewGarbage({ pressure: 'high' });
    await client.run({ platform: 'ios', waitSeconds: 30 });
    await client.run({ platform: 'android', waitSeconds: false });
    await client.diagnostics({ errorsOnly: true });
    expect(calls.map(([name, args]) => [name, args])).toEqual([
      ['gc', [{ pressure: 'high' }]],
      ['run', [{ platform: 'ios', wait: '30' }]],
      ['run', [{ platform: 'android', wait: false }]],
      ['diagnostics', [{ errors: true }]],
    ]);
    expect(calls[0]?.[2]).toMatchObject({ buildCache: buildCacheDir });
    expect(calls[0]?.[2]).not.toHaveProperty('buildCacheDir');
  });

  it('refuses a renamed option or method, naming the new one, before it reaches an engine', async () => {
    const calls: unknown[] = [];
    engine.runOp = async (...call) => {
      calls.push(call);
      return null;
    };
    const client = createStim({ projectRoot: scratch, home: join(scratch, 'home') });
    const refusal = (work: Promise<unknown>) => work.catch((error: unknown) => error);
    const untyped = (name: string, options: object): Promise<unknown> =>
      Reflect.apply(Reflect.get(client, name), client, [options]);
    expect(await refusal(untyped('gc', {}))).toMatchObject({
      code: 'STIM_BAD_ARG',
      message: expect.stringContaining('previewGarbage()'),
    });
    expect(await refusal(untyped('run', { platform: 'ios', wait: '30' }))).toMatchObject({
      message: expect.stringContaining('waitSeconds'),
    });
    expect(await refusal(untyped('run', { platform: 'ios', wait: '30', waitSeconds: 30 }))).toMatchObject({
      code: 'STIM_BAD_ARG',
    });
    expect(await refusal(untyped('diagnostics', { errors: true }))).toMatchObject({
      message: expect.stringContaining('errorsOnly'),
    });
    for (const waitSeconds of [0, 1.5])
      expect(await refusal(client.run({ platform: 'ios', waitSeconds }))).toMatchObject({
        message: expect.stringContaining('waitSeconds'),
      });
    expect(() => Reflect.apply(createStim, undefined, [{ projectRoot: scratch, buildCache: scratch }])).toThrow(
      /buildCacheDir/,
    );
    expect(calls).toEqual([]);
  });

  it('runs in this build when the caller already runs inside a Stim resident process', async () => {
    engine.runOp = async () => 'engine identity';
    const ctx = { projectRoot: scratch, home: join(scratch, 'home'), admission: 'none' } as const;
    expect(await createStim(ctx).identity()).toBe(await runOp('identity', [], ctx));
  });
});
