import { testContext } from './_context.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { removeTree } from '../engine/remove-tree.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-remove-tree-'));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'output', 'artifact'), 'build');
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

test.each(process.platform === 'win32' ? [] : [false, true])(
  'removes the selected tree with throttleIo=%s',
  async (throttleIo) => {
    const original = getExecutor();
    const run = vi.fn<typeof original.runFileAsync>(original.runFileAsync.bind(original));
    setExecutor({ ...original, runFileAsync: run });
    const output = join(root, 'output');
    await removeTree(output, undefined, undefined, throttleIo);
    expect(existsSync(output)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    expect(call?.[1].slice(-3)).toEqual(['-rf', '--', output]);
    const wrapper = process.platform === 'darwin' ? ['/usr/sbin/taskpolicy'] : ['nice', 'ionice'];
    expect(throttleIo ? wrapper : ['rm']).toContain(call?.[0]);
  },
);

test.skipIf(process.platform !== 'win32')('Windows keeps the existing in-process remover', async () => {
  const run = vi.fn<ReturnType<typeof getExecutor>['runFileAsync']>(getExecutor().runFileAsync);
  setExecutor({ ...getExecutor(), runFileAsync: run });
  await removeTree(join(root, 'output'), undefined, undefined, true);
  expect(existsSync(join(root, 'output'))).toBe(false);
  expect(run).not.toHaveBeenCalled();
});

test.skipIf(process.platform === 'win32')('unverified child cleanup leaves the tree for its owner', async () => {
  const failure = Object.assign(new Error('child cleanup unverified'), { reportCleanup: true });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async () => {
      throw failure;
    },
  });
  await expect(removeTree(join(root, 'output'))).rejects.toBe(failure);
  expect(existsSync(join(root, 'output', 'artifact'))).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  'cancelled child cleanup cannot fall back to in-process removal',
  async () => {
    const controller = new AbortController();
    setExecutor({
      ...getExecutor(),
      runFileAsync: async () => {
        controller.abort();
        throw new Error('cancelled');
      },
    });
    await expect(removeTree(join(root, 'output'), undefined, controller.signal)).rejects.toThrow('aborted');
    expect(existsSync(join(root, 'output', 'artifact'))).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')('a workspace claim stays held until its remover child exits', async () => {
  const operation = testContext({ home: join(root, 'home'), cwd: root, projectRoot: root });
  const started = join(root, 'started');
  const release = join(root, 'release');
  const script = join(root, 'held-rm.sh');
  writeFileSync(script, `echo $$ > "$1"\nwhile [ ! -f "$2" ]; do sleep 0.05; done\nshift 2\nexec /bin/rm "$@"\n`);
  const original = getExecutor();
  setExecutor({
    ...original,
    runFileAsync: async (_file, args, options) =>
      original.runFileAsync('/bin/sh', [script, started, release, ...args], options),
  });
  const holder = withWorkspaceProcessLock(root, 'native-run', () => removeTree(join(root, 'output'), operation), {
    external: true,
    declareSpawnsFor: operation,
  });
  try {
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    await expect(
      withWorkspaceProcessLock(root, 'native-run', async () => 'entered', { external: true, waitMs: 0 }),
    ).rejects.toMatchObject({ code: 'STIM_LOCK_TIMEOUT' });
    expect(existsSync(join(root, 'output', 'artifact'))).toBe(true);
  } finally {
    writeFileSync(release, 'go');
    await holder;
  }
  expect(existsSync(join(root, 'output'))).toBe(false);
  expect(await withWorkspaceProcessLock(root, 'native-run', async () => 'entered', { external: true, waitMs: 0 })).toBe(
    'entered',
  );
});
