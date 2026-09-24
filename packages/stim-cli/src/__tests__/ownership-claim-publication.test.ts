import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { clearFreeClaimSet, readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { runGc } from '../commands/gc.ts';
import { saveConfig } from '../workspace/config.ts';

const faults = vi.hoisted(() => ({
  readOnly: '',
  beforeRename: null as null | ((from: string, to: string) => void | (() => void)),
  denied: new Map<string, () => void>(),
  denyReads: '',
  denyCreates: '',
}));

function accessDenied(syscall: string, path: string): never {
  throw Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), { code: 'EPERM', syscall });
}

function denyOnce(path: string, then: () => void): void {
  faults.denied.set(path, then);
}

function denied(syscall: string, path: string): void {
  const then = faults.denied.get(path);
  if (!then) return;
  faults.denied.delete(path);
  then();
  accessDenied(syscall, path);
}

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]);
      if (faults.denyCreates && path !== faults.denyCreates) accessDenied('mkdir', path);
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
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      denied('scandir', String(args[0]));
      return fs.readdirSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (faults.denyReads && String(args[0]) === faults.denyReads) accessDenied('open', faults.denyReads);
      denied('open', String(args[0]));
      return fs.readFileSync(...args);
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
  faults.denied.clear();
  faults.denyReads = '';
  faults.denyCreates = '';
  process.exitCode = undefined;
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
    expect(process.exitCode).toBe(1);
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

describe.skipIf(process.platform !== 'win32')(
  'Windows answers access denied for a name another process is removing',
  () => {
    test.each(['exclusive', 'shared'] as const)(
      'an empty claim directory whose removal is in flight reads as absent and a %s claim is taken',
      (mode) => {
        const exclusive = join(root, 'exclusive');
        mkdirSync(exclusive, { recursive: true });
        denyOnce(exclusive, () => rmSync(exclusive, { recursive: true }));
        const attempt = tryAcquireClaim({ root, mode });
        expect(attempt.acquired).toBeDefined();
        expect(releaseClaim(attempt.acquired)).toBe(true);
      },
    );

    test.each([
      ['answers at once', 0],
      ['is itself descheduled past the settle window', 2_100],
    ])('a claim record whose removal is in flight reads as absent when the read %s', (_, stalledMs) => {
      const exclusive = join(root, 'exclusive');
      const leaving = join(exclusive, 'leaving.claim');
      mkdirSync(exclusive, { recursive: true });
      writeFileSync(leaving, '{}');
      denyOnce(leaving, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stalledMs);
        rmSync(exclusive, { recursive: true });
      });
      const attempt = tryAcquireClaim({ root, mode: 'exclusive' });
      expect(attempt.acquired).toBeDefined();
      expect(releaseClaim(attempt.acquired)).toBe(true);
    });

    test.each(['exclusive', 'shared'] as const)(
      'a live claim whose record stays denied is refused by name, never joined by a %s claim',
      (mode) => {
        const holder = tryAcquireClaim({ root, mode: 'exclusive' });
        assert(holder.acquired);
        faults.denyReads = holder.acquired.path;
        expect(() => tryAcquireClaim({ root, mode })).toThrow(
          expect.objectContaining({
            code: 'STIM_CLAIM_REFUSED',
            claimPath: holder.acquired.path,
            reason: 'its record could not be read (EPERM)',
          }),
        );
        expect(readdirSync(join(root, 'exclusive'))).toEqual([`${holder.acquired.claimId}.claim`]);
        expect(existsSync(join(root, 'shared'))).toBe(false);
        faults.denyReads = '';
        expect(readClaimSet(root).live.map((live) => live.claimId)).toEqual([holder.acquired.claimId]);
        expect(releaseClaim(holder.acquired)).toBe(true);
      },
    );

    test.each(['exclusive', 'shared'] as const)(
      'a denial to create the staging entry that outlasts every attempt is a store Stim cannot write, not a %s claim it lost',
      (mode) => {
        faults.denyCreates = root;
        expect(() => tryAcquireClaim({ root, mode })).toThrow(
          expect.objectContaining({ code: 'STIM_CLAIM_UNAVAILABLE', remedy: expect.stringContaining(root) }),
        );
        expect(readClaimSet(root)).toEqual({ live: [], dead: [], unresolved: [], orphans: [] });
      },
    );
  },
);

test.skipIf(process.platform === 'win32')('an access denial on a claim directory stays a refusal off Windows', () => {
  const exclusive = join(root, 'exclusive');
  mkdirSync(exclusive, { recursive: true });
  denyOnce(exclusive, () => {});
  expect(() => tryAcquireClaim({ root, mode: 'exclusive' })).toThrow(
    expect.objectContaining({ code: 'STIM_CLAIM_REFUSED', claimPath: exclusive }),
  );
});
