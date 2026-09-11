import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { clearFreeClaimSet, isClaimRefusal, type ClaimMode, tryAcquireClaim } from '../ownership-claim.ts';

const readOnly = vi.hoisted(() => ({ path: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  // A read-only APFS mount, reported the way macOS reports one: a recursive mkdir comes back ENOENT,
  // because node returns the errno of the stat it takes after the failed mkdir rather than the mkdir's
  // own, while a plain mkdir whose parent is present comes back EROFS. Measured on a read-only disk
  // image; creating one in the suite needs hdiutil.
  return {
    ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]);
      if (!readOnly.path || relative(readOnly.path, path).startsWith('..')) return fs.mkdirSync(...args);
      const options = args[1];
      const recursive = typeof options === 'object' && options !== null && options.recursive === true;
      if (recursive && fs.existsSync(path)) return undefined;
      const code = recursive ? 'ENOENT' : 'EROFS';
      const text = recursive ? 'no such file or directory' : 'read-only file system';
      throw Object.assign(new Error(`${code}: ${text}, mkdir '${path}'`), { code });
    },
  };
});

const modes: ClaimMode[] = ['exclusive', 'shared'];

function failure(fn: () => unknown): NodeJS.ErrnoException {
  try {
    fn();
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
  throw new Error('the claim was taken in a store that cannot be written');
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-claim-store-'));
});

afterEach(() => {
  readOnly.path = '';
  rmSync(home, { recursive: true, force: true });
});

describe('a claim store the filesystem will not accept writes to', () => {
  test('reports the errno the kernel gave, whether the store is there already or not', () => {
    const present = join(home, 'present.lock');
    mkdirSync(present, { recursive: true });
    readOnly.path = home;

    for (const root of [join(home, 'absent.lock'), present]) {
      for (const mode of modes) {
        const err = failure(() => tryAcquireClaim({ root, mode, label: 'ios build' }));
        expect(isClaimRefusal(err)).toBe(false);
        expect(err.code).toBe('EROFS');
        expect(err.message).toContain(root);
        expect(err.message).toMatch(/read-only file system/);
        expect(err.message).not.toMatch(/another process|remove/);
      }
    }
  });

  test('gc reports a store it cannot clear instead of throwing out of the sweep', () => {
    const root = join(home, 'build.lock');
    mkdirSync(root, { recursive: true });
    readOnly.path = home;

    expect(clearFreeClaimSet({ root, label: 'ios build' })).toEqual({
      status: 'failed',
      reason: expect.stringContaining('read-only file system'),
    });
  });

  test('a store whose writes can never succeed does not exhaust into a claim someone else holds', () => {
    symlinkSync(join(home, 'nowhere'), join(home, 'store'));
    const root = join(home, 'store', 'build.lock');

    for (const mode of modes) {
      const err = failure(() => tryAcquireClaim({ root, mode, label: 'ios build' }));
      expect(isClaimRefusal(err)).toBe(false);
      expect(err.code).toBe('ENOENT');
      expect(err.message).toContain(root);
      expect(err.message).not.toMatch(/another process|remove/);
    }
  });
});
