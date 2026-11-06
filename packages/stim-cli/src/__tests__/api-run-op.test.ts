import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStim, runOp } from '../api.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-api-run-op-')));
});
afterEach(() => {
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
