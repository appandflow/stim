import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resetExecutor } from '../exec.ts';
import { git, gitAsync, gitQuiet } from '../workspace/git.ts';

let dir: string;
let path: string | undefined;

beforeEach(() => {
  resetExecutor();
  dir = mkdtempSync(join(tmpdir(), 'stim-git-'));
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
});

afterEach(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')('a git that never answers fails within its budget', async () => {
  const started = Date.now();
  expect(() => git(dir, ['status'], { timeoutMs: 200 })).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
  expect(gitQuiet(dir, ['status'], { timeoutMs: 200 })).toBeNull();
  await expect(gitAsync(dir, ['status'], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(Date.now() - started).toBeLessThan(5000);
});

test.skipIf(process.platform === 'win32')(
  'a queued git call gets its whole budget once one of the six running calls ends',
  async () => {
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
