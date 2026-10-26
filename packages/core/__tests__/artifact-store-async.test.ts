import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { storeArtifactAsync } from '../artifact-store-async.ts';

const execute = promisify(execFile);
let root: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stim-artifact-async-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGKILL');
    await once(child, 'close');
  }
  await rm(root, { recursive: true, force: true });
});

async function runFile(file: string, args: string[], signal?: AbortSignal, started?: (child: ChildProcess) => void) {
  const completion = execute(file, args, { signal });
  const child = completion.child;
  children.push(child);
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  started?.(child);
  try {
    await completion;
  } finally {
    if (!closed) await once(child, 'close');
  }
}

async function app(parent: string, contents: string) {
  const directory = join(root, parent, 'Fixture.app');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'value'), contents);
  return directory;
}

async function value(directory: string | null) {
  if (!directory) throw new Error('No artifact was returned.');
  return readFile(join(directory, 'value'), 'utf8');
}

test('awaits a delayed real copy without blocking timers and publishes metadata with the artifact', async () => {
  const source = await app('source', 'new app');
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 10);
  try {
    const stored = await storeArtifactAsync(join(root, 'cache'), source, {
      runFile: async (file, args) => {
        await runFile(process.execPath, ['-e', 'setTimeout(() => {}, 80)']);
        await runFile(file, args);
      },
      writeMetadata: async (staging) => {
        await writeFile(join(staging, 'metadata.json'), '{"source":"fixture"}');
      },
    });
    expect(timerRan).toBe(true);
    expect(await value(stored)).toBe('new app');
    expect(JSON.parse(await readFile(join(root, 'cache', 'metadata.json'), 'utf8'))).toEqual({ source: 'fixture' });
    expect((await readdir(root)).toSorted()).toEqual(['cache', 'source']);
  } finally {
    clearTimeout(timer);
  }
});

test('ordinary clone-copy failure uses the fallback and publishes the actual copied bytes', async () => {
  const source = await app('source', 'fallback app');
  const stored = await storeArtifactAsync(join(root, 'cache'), source, {
    runFile: async (file, args) => {
      if (args.includes('-c')) await runFile(file, ['--stim-invalid-clone-option']);
      else await runFile(file, args);
    },
  });
  expect(await value(stored)).toBe('fallback app');
  expect((await readdir(root)).toSorted()).toEqual(['cache', 'source']);
});

test('cancelling a copy stops its child, preserves the old entry and removes only its staging', async () => {
  const source = await app('source', 'new app');
  const previous = await app('cache', 'old app');
  const controller = new AbortController();
  let copies = 0;
  await expect(
    storeArtifactAsync(join(root, 'cache'), source, {
      overwrite: true,
      signal: controller.signal,
      runFile: async () => {
        copies++;
        await runFile(
          process.execPath,
          ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 30000)"],
          controller.signal,
          (child) => {
            child.stdout?.once('data', () => controller.abort());
          },
        );
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(copies).toBe(1);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(await value(previous)).toBe('old app');
  expect((await readdir(root)).toSorted()).toEqual(['cache', 'source']);
});

test('overlapping same-process stores cannot remove another copy staging or replace its published winner', async () => {
  const first = await app('first', 'first app');
  const second = await app('second', 'second app');
  let notifyCopied = () => {};
  let releaseFirst = () => {};
  const copied = new Promise<void>((resolve) => {
    notifyCopied = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const dest = join(root, 'cache');
  const pending = storeArtifactAsync(dest, first, {
    runFile: async (file, args) => {
      await runFile(file, args);
      notifyCopied();
      await released;
    },
  });
  try {
    await copied;
    const winner = await storeArtifactAsync(dest, second, { runFile });
    releaseFirst();
    expect(await value(winner)).toBe('second app');
    expect(await pending).toBe(winner);
    expect(await value(winner)).toBe('second app');
    expect((await readdir(root)).toSorted()).toEqual(['cache', 'first', 'second']);
  } finally {
    releaseFirst();
    await pending;
  }
});
