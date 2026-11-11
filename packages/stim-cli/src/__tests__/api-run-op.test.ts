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

  it('runs in this build when the caller already runs inside a Stim resident process', async () => {
    engine.runOp = async () => 'engine identity';
    const ctx = { projectRoot: scratch, home: join(scratch, 'home'), admission: 'none' } as const;
    expect(await createStim(ctx).identity()).toBe(await runOp('identity', [], ctx));
  });
});
