import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { clearFreeClaimSet, readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runGc } from '../commands/gc.ts';
import { saveConfig } from '../config.ts';

const faults = vi.hoisted(() => ({
  readOnly: '',
  beforeRename: null as null | ((from: string, to: string) => void | (() => void)),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]);
      if (!faults.readOnly || relative(faults.readOnly, path).startsWith('..')) return fs.mkdirSync(...args);
      const options = args[1];
      const recursive = typeof options === 'object' && options !== null && options.recursive === true;
      if (recursive && fs.existsSync(path)) return undefined;
      const code = recursive ? 'ENOENT' : 'EROFS';
      throw Object.assign(new Error(`${code}: mkdir '${path}'`), { code });
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const cleanup = faults.beforeRename?.(String(args[0]), String(args[1]));
      try {
        return fs.renameSync(...args);
      } finally {
        cleanup?.();
      }
    },
  };
});

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-claim-publication-'));
  root = join(home, 'build.lock');
  process.env.STIM_HOME = home;
});

afterEach(() => {
  faults.readOnly = '';
  faults.beforeRename = null;
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.each(['exclusive', 'shared'] as const)('a read-only store preserves EROFS for %s claims', (mode) => {
  const present = join(home, 'present.lock');
  mkdirSync(present);
  faults.readOnly = home;
  for (const path of [root, present]) {
    expect(() => tryAcquireClaim({ root: path, mode })).toThrow(expect.objectContaining({ code: 'EROFS' }));
  }
});

test('clearing a read-only claim store reports failure without throwing', () => {
  mkdirSync(root);
  faults.readOnly = root;
  expect(clearFreeClaimSet({ root })).toEqual({ status: 'failed', reason: expect.stringContaining('EROFS') });
});

test('gc reports a read-only build lock and still clears a later build slot', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  const blocked = join(home, 'build-locks', 'ios-readonly.lock');
  const writable = join(home, 'build-slots', 'slot-0');
  mkdirSync(blocked, { recursive: true });
  mkdirSync(writable, { recursive: true });
  faults.readOnly = blocked;
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
  try {
    await runGc({ delete: true }, { findProjectRoot: () => null });
    expect(existsSync(blocked)).toBe(true);
    expect(existsSync(writable)).toBe(false);
    expect(lines.join('\n')).toContain(`Failed to clear the build lock at ${blocked}: EROFS`);
    expect(lines.join('\n')).toContain('Cleared build slot 0');
    expect(lines.join('\n')).toContain('1 entry could not be deleted');
  } finally {
    log.mockRestore();
  }
});

test.each(['exclusive', 'shared'] as const)('an ENOENT publication race retries and acquires a %s claim', (mode) => {
  faults.beforeRename = () => {
    faults.beforeRename = null;
    rmSync(root, { recursive: true });
  };
  const attempt = tryAcquireClaim({ root, mode });
  expect(attempt.acquired).toBeDefined();
  expect(readClaimSet(root).live.map((holder) => holder.claimId)).toEqual([attempt.acquired!.claimId]);
  expect(releaseClaim(attempt.acquired)).toBe(true);
});

test.each(['exclusive', 'shared'] as const)('repeated ENOENT publication races refuse %s claims', (mode) => {
  faults.beforeRename = () => rmSync(root, { recursive: true });
  expect(() => tryAcquireClaim({ root, mode })).toThrow(expect.objectContaining({ code: 'STIM_CLAIM_REFUSED' }));
});

test('a rename colliding with a claim that releases before the next survey still refuses after repeated races', () => {
  faults.beforeRename = (_from, to) => {
    mkdirSync(to);
    writeFileSync(join(to, 'held.claim'), 'occupied');
    return () => rmSync(to, { recursive: true });
  };
  expect(() => tryAcquireClaim({ root, mode: 'exclusive' })).toThrow(
    expect.objectContaining({ code: 'STIM_CLAIM_REFUSED' }),
  );
  expect(existsSync(join(root, 'exclusive'))).toBe(false);
});
