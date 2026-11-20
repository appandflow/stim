import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
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

const modes = vi.hoisted((): { refuseChmod: boolean } => ({ refuseChmod: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    chmod: async (...args: Parameters<typeof fs.chmod>) => {
      if (modes.refuseChmod) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      return fs.chmod(...args);
    },
  };
});

function fakeChild(ready: boolean, exitsOnKill: boolean) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn<(signal: string) => boolean>(() => {
      if (exitsOnKill) child.emit('exit', null, 'SIGKILL');
      return true;
    }),
  });
  if (ready) child.stdout.write('{"ready":true}\n');
  return child;
}

function plantFiles(dir: string): void {
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'file'), 'x');
}

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-delete-child-')));
});

afterEach(() => {
  modes.refuseChmod = false;
  resetExecutor();
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(!POSIX)(
  'a cancelled delete child whose exit cannot be proven fails as a refusal and keeps the claim with the child',
  async () => {
    const child = fakeChild(true, false);
    setExecutor({ ...getExecutor(), spawn: () => child });
    mkdirSync(join(base, 'tree'));
    writeFileSync(join(base, 'tree', 'file'), 'x');
    const claim = tryAcquireClaim({ root: join(base, 'claims'), mode: 'exclusive', label: 'test' }).acquired;
    if (!claim) throw new Error('the test claim was not acquired');
    const session = await openDeleteSession();
    const controller = new AbortController();
    const written = new Promise((resolve) => child.stdin.once('data', resolve));

    const deleting = session.rm(join(base, 'tree'), claim, {
      dev: lstatSync(base).dev,
      signal: controller.signal,
    });
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

describe.skipIf(!POSIX)('a delete child that is not ready', () => {
  test('is killed after 5 s and the delete runs in this thread', async () => {
    const child = fakeChild(false, true);
    setExecutor({ ...getExecutor(), spawn: () => child });
    plantFiles(join(base, 'tree'));
    const opening = openDeleteSession();
    await vi.advanceTimersByTimeAsync(5000);
    const session = await opening;

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const claim = tryAcquireClaim({ root: join(base, 'claims'), mode: 'exclusive', label: 'test' }).acquired;
    if (!claim) throw new Error('the test claim was not acquired');
    expect(await session.rm(join(base, 'tree'), claim, { dev: lstatSync(base).dev })).toEqual({ done: { left: [] } });
    expect(child.stdin.read()).toBeNull();
    releaseClaim(claim);
  });

  test('that does not exit once killed is refused with its pid, after seeing EOF', async () => {
    const child = fakeChild(false, false);
    setExecutor({ ...getExecutor(), spawn: () => child });
    const opening = openDeleteSession().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await opening).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportChild: { pid: process.pid } });
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('is killed when the caller cancels, and the cancel is thrown', async () => {
    const child = fakeChild(false, true);
    setExecutor({ ...getExecutor(), spawn: () => child });
    const controller = new AbortController();
    const opening = openDeleteSession(controller.signal).catch((error: unknown) => error);
    controller.abort(new Error('stop the sweep'));

    expect(await opening).toMatchObject({ message: 'stop the sweep' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

test.skipIf(!POSIX)('a delete keeps a tree with a mount point at or under it', async () => {
  const tree = join(base, 'tree');
  plantFiles(tree);
  const mountInfo = () =>
    `36 35 98:0 /data ${join(tree, 'nested').replaceAll(' ', '\\040')} rw,noatime - ext4 /dev/sda1 rw\n`;

  const outcome = await runRmJob(
    { id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev },
    new AbortController().signal,
    {
      mountInfo,
    },
  );

  expect(outcome).toEqual({ kept: `${join(tree, 'nested')} is a mount point` });
  expect(readdirSync(join(tree, 'nested'))).toEqual(['file']);
});

test.skipIf(!POSIX || process.getuid?.() === 0)(
  'a delete whose path cannot be inspected fails with the error instead of counting as done',
  async () => {
    setExecutor({
      ...getExecutor(),
      spawn: () => {
        throw new Error('no delete child in unit tests');
      },
    });
    const locked = join(base, 'locked');
    plantFiles(locked);
    chmodSync(locked, 0o000);
    const claim = tryAcquireClaim({ root: join(base, 'claims'), mode: 'exclusive', label: 'test' }).acquired;
    if (!claim) throw new Error('the test claim was not acquired');
    try {
      const session = await openDeleteSession();
      const failure = await session
        .rm(join(locked, 'nested', 'file'), claim, { dev: lstatSync(base).dev })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(locked, 0o700);
      releaseClaim(claim);
    }
  },
);

async function removesNamesThatAreNotUtf8(anchored: boolean, skip: (note: string) => void): Promise<void> {
  const tree = join(base, 'tree');
  mkdirSync(tree);
  const raw = (name: number[]) => Buffer.concat([Buffer.from(`${tree}/`), Buffer.from(name)]);
  try {
    writeFileSync(raw([0x66, 0xff]), 'x');
    mkdirSync(raw([0x64, 0xfe]));
    writeFileSync(Buffer.concat([raw([0x64, 0xfe]), Buffer.from('/inner')]), 'y');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EILSEQ')
      skip('this filesystem rejects such names');
    throw error;
  }

  const outcome = await runRmJob(
    { id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev },
    new AbortController().signal,
    anchored ? { cwd: { chdir: (path: string) => process.chdir(path), current: () => process.cwd() } } : {},
  );

  expect(outcome).toEqual({ done: { left: [] } });
  expect(existsSync(tree)).toBe(false);
}

test.skipIf(!POSIX)('the delete child removes a file and a directory whose names are not valid UTF-8', ({ skip }) =>
  removesNamesThatAreNotUtf8(true, skip),
);

test.skipIf(!POSIX)(
  'a delete in the caller thread removes a file and a directory whose names are not valid UTF-8',
  ({ skip }) => removesNamesThatAreNotUtf8(false, skip),
);

describe.skipIf(!POSIX)('an empty directory whose mode the user cannot change', () => {
  test.each([
    { name: 'the delete child removes it', anchored: true },
    { name: 'a delete in the caller thread removes it', anchored: false },
  ])('$name without changing its mode', async ({ anchored }) => {
    const tree = join(base, 'tree');
    mkdirSync(join(tree, 'owned-elsewhere'), { recursive: true });
    chmodSync(join(tree, 'owned-elsewhere'), 0o555);
    modes.refuseChmod = true;

    const outcome = await runRmJob(
      { id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev },
      new AbortController().signal,
      anchored ? { cwd: { chdir: (path: string) => process.chdir(path), current: () => process.cwd() } } : {},
    );

    expect(outcome).toEqual({ done: { left: [] } });
    expect(existsSync(tree)).toBe(false);
  });
});
