import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  pruneEmptyProcessLockDirs,
  withManagedRemoteWorktreeLock,
  withManagedRemoteWorktreeRemovalLock,
  withManagedTunnelLock,
  withManagedTunnelRemovalLock,
} from '../engine/tunnel.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-process-locks-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const lockEntries = (): string[] => {
  try {
    return readdirSync(join(home, 'process-locks'));
  } catch {
    return [];
  }
};

test('the managed locks leave no directories behind once released, and keep theirs while held', async () => {
  const root = join(home, 'project');
  await withManagedTunnelLock(root, async () => {
    expect(lockEntries()).toHaveLength(1);
    await withManagedRemoteWorktreeLock(root, async () => {
      expect(lockEntries()).toHaveLength(2);
    });
  });
  await withManagedTunnelRemovalLock(root, async () => {});
  await withManagedRemoteWorktreeRemovalLock(root, async () => {});
  expect(lockEntries()).toEqual(['worktrees']);
  expect(readdirSync(join(home, 'process-locks', 'worktrees'))).toEqual([]);
});

test('pruning removes empty lock directories left by earlier versions and spares a held lock', async () => {
  const locks = join(home, 'process-locks');
  mkdirSync(join(locks, 'a'.repeat(64), '.stim'), { recursive: true });
  mkdirSync(join(locks, 'worktrees', 'b'.repeat(64)), { recursive: true });
  const root = join(home, 'project');
  await withManagedTunnelLock(root, async () => {
    expect(pruneEmptyProcessLockDirs()).toBe(3);
    expect(lockEntries()).toHaveLength(2);
  });
  expect(pruneEmptyProcessLockDirs()).toBe(0);
});
