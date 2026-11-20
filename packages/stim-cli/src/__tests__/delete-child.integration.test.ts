import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { withAmbientContext } from '@stim-cli/core';
import { deleteTrash } from '../commands/gc/trash.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { openDeleteSession } from '../delete-child.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runReport } from '../report-runtime.ts';
import { warmTrash } from '../workspace/worktree-trash.ts';
import { testContext } from './_context.ts';

const CHILD = fileURLToPath(new URL('../../dist/delete-child.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';

let base: string;
let trash: string;

beforeEach(() => {
  resetExecutor();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-delete-child-')));
  mkdirSync(join(base, 'home'));
  symlinkSync(join(base, 'home'), join(base, 'home-link'));
  process.env.STIM_HOME = join(base, 'home-link');
  trash = join(base, 'home', 'trash');
});

afterEach(() => {
  resetExecutor();
  takeGcResults();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

function plantTree(root: string, files: number): void {
  mkdirSync(join(root, 'nested'), { recursive: true });
  for (let index = 0; index < files; index++) writeFileSync(join(root, 'nested', `f${index}`), 'x');
}

function plantEntry(name: string, files = 3): string {
  const dir = join(trash, name);
  plantTree(join(dir, 'entries', '0'), files);
  writeFileSync(join(dir, 'trash.json'), JSON.stringify({ worktree: join(base, 'gone'), createdAt: 'T' }));
  return dir;
}

function recordedChild(claims: string): number | null {
  if (!existsSync(claims)) return null;
  for (const name of readdirSync(claims, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.child')) continue;
    try {
      const pid = JSON.parse(readFileSync(join(claims, name), 'utf8'))?.record?.pid;
      if (typeof pid === 'number') return pid;
    } catch {}
  }
  return null;
}

function whenChildRecorded(claims: string, act: (pid: number) => void): () => void {
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    const pid = recordedChild(claims);
    if (pid === null) setImmediate(poll);
    else act(pid);
  };
  setImmediate(poll);
  return () => {
    stopped = true;
  };
}

test.skipIf(!POSIX)(
  'the delete child removes a tree in place, with directories it may not read or search, and never follows a link',
  async () => {
    const tree = join(base, 'tree');
    plantTree(tree, 3);
    mkdirSync(join(tree, 'read-only'));
    writeFileSync(join(tree, 'read-only', 'file'), 'r');
    chmodSync(join(tree, 'read-only'), 0o500);
    mkdirSync(join(tree, 'locked'));
    writeFileSync(join(tree, 'locked', 'file'), 'l');
    chmodSync(join(tree, 'locked'), 0o000);
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'keep'), 'k');
    symlinkSync(join(base, 'outside'), join(tree, 'link'));

    const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const messages: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.ready)
          child.stdin.write(`${JSON.stringify({ id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev })}\n`);
        if (message.id === 1 && !message.progress) resolve();
      });
    });
    await done;
    child.stdin.end();

    expect(messages[0]).toEqual({ ready: true });
    expect(messages[1]).toEqual({ id: 1, progress: { entries: 1 } });
    expect(messages.at(-1)).toEqual({ id: 1, done: { left: [] } });
    expect(existsSync(tree)).toBe(false);
    expect(readFileSync(join(base, 'outside', 'keep'), 'utf8')).toBe('k');
    expect(await exited).toBe(0);
  },
);

test.skipIf(!POSIX)('a cancel sent after the first progress stops the delete part way', async () => {
  const tree = join(base, 'tree');
  plantTree(tree, 2000);
  const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = await new Promise<Record<string, unknown>>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.ready)
        child.stdin.write(`${JSON.stringify({ id: 1, op: 'rm', path: tree, dev: lstatSync(tree).dev })}\n`);
      else if (message.progress) child.stdin.write(`${JSON.stringify({ cancel: 1 })}\n`);
      else resolve(message);
    });
  });
  child.stdin.end();

  expect(reply).toEqual({ id: 1, cancelled: { left: [tree] } });
  const remaining = readdirSync(join(tree, 'nested')).length;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(2000);
});

test.skipIf(!POSIX)('gc deletes trash entries through one delete child under a symlinked Stim home', async () => {
  const real = getExecutor();
  let spawned = 0;
  setExecutor({
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      spawned++;
      return real.spawn(...args);
    },
  });
  const first = plantEntry('remove-first');
  const second = plantEntry('remove-second');

  expect(await deleteTrash(undefined)).toMatchObject({ count: 2, failures: 0 });

  expect(spawned).toBe(1);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
});

test.skipIf(!POSIX)('a killed delete child fails the delete and leaves an entry the next gc deletes', async () => {
  const entry = plantEntry('remove-killed', 2000);
  const stop = whenChildRecorded(join(entry, 'claims'), (pid) => process.kill(pid, 'SIGKILL'));

  const result = await deleteTrash(undefined);
  stop();

  expect(result).toMatchObject({ count: 0, failures: 1 });
  expect(existsSync(join(entry, 'trash.json'))).toBe(true);
  expect(readClaimSet(join(entry, 'claims')).live).toEqual([]);
  expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });
  expect(existsSync(entry)).toBe(false);
});

test.skipIf(!POSIX)('a cancelled delete clears the child record and the child takes the next job', async () => {
  const tree = join(base, 'tree');
  plantTree(tree, 2000);
  const claim = tryAcquireClaim({ root: join(base, 'claims'), mode: 'exclusive', label: 'test' }).acquired;
  if (!claim) throw new Error('the test claim was not acquired');
  const session = await openDeleteSession();
  try {
    const controller = new AbortController();
    const stop = whenChildRecorded(join(base, 'claims'), () => controller.abort());
    const cancelled = await session.rm(tree, claim, controller.signal);
    stop();

    expect(cancelled).toEqual({ cancelled: { left: [tree] } });
    expect(readdirSync(join(tree, 'nested')).length).toBeGreaterThan(0);
    expect(recordedChild(join(base, 'claims'))).toBeNull();
    expect(await session.rm(tree, claim)).toEqual({ done: { left: [] } });
    expect(existsSync(tree)).toBe(false);
  } finally {
    await session.close();
    releaseClaim(claim);
  }
});

test.skipIf(!POSIX)('a delete child that exits before it is ready leaves the delete to this thread', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    spawn: (file: string, _args: string[], options: object) => real.spawn(file, ['-e', 'process.exit(1)'], options),
  });
  const entry = plantEntry('remove-fallback');

  expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });
  expect(existsSync(entry)).toBe(false);
});

test.skipIf(!POSIX)(
  'inside a report, a trash entry goes through the delete child when the caller cwd is gone',
  async () => {
    const worktree = join(base, 'worktree');
    plantTree(join(worktree, 'store'), 3);
    const gone = join(base, 'gone');
    mkdirSync(gone);
    const context = testContext({ home: join(base, 'home'), cwd: gone, projectRoot: gone });
    rmSync(gone, { recursive: true });
    const real = getExecutor();
    const exits: (number | null)[] = [];
    setExecutor({
      ...real,
      spawn: (...args: Parameters<typeof real.spawn>) => {
        const child = real.spawn(...args);
        child.once('exit', (code) => exits.push(code));
        return child;
      },
    });
    const warm = warmTrash(worktree);

    await runReport(context, (operation) =>
      withAmbientContext(operation, async () => {
        expect(await warm.take(join(worktree, 'store'))).toBe(true);
        await warm.dispose(operation);
      }),
    );

    expect(exits).toEqual([0]);
    expect(readdirSync(trash)).toEqual([]);
  },
);
