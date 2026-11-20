import { EventEmitter } from 'node:events';
import {
  readdirSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { openDeleteSession } from '../delete-child.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runRmJob } from '../workspace/remover.ts';

const POSIX = process.platform !== 'win32';

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-delete-child-')));
});

afterEach(() => {
  resetExecutor();
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(!POSIX)(
  'a cancelled delete child whose exit cannot be proven fails as a refusal and keeps the claim with the child',
  async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn<(signal: string) => boolean>(() => true),
    });
    child.stdout.write('{"ready":true}\n');
    setExecutor({ ...getExecutor(), spawn: () => child });
    mkdirSync(join(base, 'tree'));
    writeFileSync(join(base, 'tree', 'file'), 'x');
    const claim = tryAcquireClaim({ root: join(base, 'claims'), mode: 'exclusive', label: 'test' }).acquired;
    if (!claim) throw new Error('the test claim was not acquired');
    const session = await openDeleteSession();
    const controller = new AbortController();
    const written = new Promise((resolve) => child.stdin.once('data', resolve));

    const deleting = session.rm(join(base, 'tree'), claim, controller.signal);
    const refused = deleting.catch((error: unknown) => error);
    await written;
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await refused).toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      claims: [claim],
      reportChild: { pid: process.pid },
    });

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(readClaimSet(join(base, 'claims')).live[0]?.child?.pid).toBe(process.pid);
    releaseClaim(claim);
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
  },
);

describe.skipIf(!POSIX)('a directory swapped for a link after its check', () => {
  test.each([
    {
      name: 'the delete child keeps deleting the directory it checked, never the link target',
      anchored: true,
      kept: 'a directory above the delete was replaced while it ran, so the delete stopped',
      movedDeleted: true,
    },
    {
      name: 'a delete in the caller thread stops before the link target',
      anchored: false,
      kept: 'no longer resolves to itself, so the delete stopped',
      movedDeleted: false,
    },
  ])('$name', async ({ anchored, kept, movedDeleted }) => {
    const tree = join(base, 'tree');
    mkdirSync(join(tree, 'dir'), { recursive: true });
    mkdirSync(join(base, 'outside'));
    for (const name of ['a', 'b']) {
      writeFileSync(join(tree, 'dir', name), 'x');
      writeFileSync(join(base, 'outside', name), 'keep');
    }
    const cwd = process.cwd();
    let swapped = false;

    const outcome = await runRmJob(
      { id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev },
      new AbortController().signal,
      {
        cwd: anchored ? { chdir: (path: string) => process.chdir(path), current: () => process.cwd() } : undefined,
        removed: () => {
          if (swapped) return;
          swapped = true;
          renameSync(join(tree, 'dir'), join(base, 'moved'));
          symlinkSync(join(base, 'outside'), join(tree, 'dir'));
        },
      },
    );

    expect(outcome).toEqual({ kept: expect.stringContaining(kept) });
    expect(readdirSync(join(base, 'outside')).toSorted()).toEqual(['a', 'b']);
    expect(readdirSync(join(base, 'moved')).length).toBe(movedDeleted ? 0 : 1);
    expect(process.cwd()).toBe(cwd);
  });
});
