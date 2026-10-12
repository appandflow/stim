import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resetExecutor } from '../exec.ts';
import { git, gitAsync, gitQuiet } from '../workspace/git.ts';

let dir: string;
let path: string | undefined;

beforeEach(() => {
  resetExecutor();
  dir = mkdtempSync(join(tmpdir(), 'stim-git-'));
  path = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

function blockGit(): void {
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
}

test('a read leaves the index alone, while a call marked write lets git refresh it', () => {
  const index = join(dir, '.git', 'index');
  git(dir, ['init', '-q'], { write: true });
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, ['add', 'a.txt'], { write: true });
  const stamp = () => statSync(index, { bigint: true }).mtimeNs;
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, 'a.txt'), hourAgo, hourAgo);
  const before = stamp();
  expect(gitQuiet(dir, ['status', '--porcelain'])).toBe('A  a.txt');
  expect(stamp()).toBe(before);
  gitQuiet(dir, ['status', '--porcelain'], { write: true });
  expect(stamp()).not.toBe(before);
});

test.skipIf(process.platform === 'win32')('a git that never answers fails within its budget', async () => {
  blockGit();
  const started = Date.now();
  expect(() => git(dir, ['status'], { timeoutMs: 200 })).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
  expect(gitQuiet(dir, ['status'], { timeoutMs: 200 })).toBeNull();
  await expect(gitAsync(dir, ['status'], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(Date.now() - started).toBeLessThan(5000);
});

test.skipIf(process.platform === 'win32')(
  'a queued git call gets its whole budget once one of the six running calls ends',
  async () => {
    blockGit();
    const started = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: 7 }, () => gitAsync(dir, ['status'], { timeoutMs: 300 })),
    );
    const elapsed = Date.now() - started;
    expect(settled.every((result) => result.status === 'rejected')).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(5000);
  },
);

test.skipIf(process.platform === 'win32')(
  'aborting an active git rejects with the caller reason and frees its slot',
  async () => {
    blockGit();
    const controller = new AbortController();
    const reason = new Error('cancel source listing');
    const started = Date.now();
    const pending = gitAsync(dir, ['status'], { timeoutMs: 10_000, signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(5000);
  },
);

test.skipIf(process.platform === 'win32')(
  'aborting a queued git never starts it and does not consume a slot',
  async () => {
    blockGit();
    const running = Array.from({ length: 6 }, () => new AbortController());
    const pending = running.map((controller) =>
      gitAsync(dir, ['status'], { timeoutMs: 10_000, signal: controller.signal }),
    );
    const queued = new AbortController();
    const reason = new Error('cancel queued listing');
    let spawned = false;
    const seventh = gitAsync(dir, ['status'], {
      timeoutMs: 10_000,
      signal: queued.signal,
      onSpawn: () => {
        spawned = true;
      },
    });
    try {
      queued.abort(reason);
      await expect(seventh).rejects.toBe(reason);
      expect(spawned).toBe(false);
    } finally {
      for (const controller of running) controller.abort();
      await Promise.allSettled(pending);
    }
    const next = new AbortController();
    const eighth = gitAsync(dir, ['status'], {
      timeoutMs: 10_000,
      signal: next.signal,
      onSpawn: () => {
        spawned = true;
      },
    });
    next.abort(reason);
    await expect(eighth).rejects.toBe(reason);
    expect(spawned).toBe(true);
  },
);
