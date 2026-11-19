import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { daemonNdjsonFile } from '@stim-cli/core/state';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directorySize,
  volumeRootFor,
  isRealMount,
  isOnMountedVolume,
  listMountedVolumes,
  measuredDirectorySizeAsync,
} from '../fs-util.ts';

test('isRealMount treats a matching st_dev (symlink to boot volume) as not a real mount', () => {
  expect(isRealMount(16777234, 16777234)).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'isOnMountedVolume resolves a symlinked ancestor instead of classifying the raw path text (macOS /Volumes; skipped on win32)',
  () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
    try {
      const symlinkedAncestor = join(homeDir, 'Developer');
      symlinkSync('/Volumes/UnmountedTestVolume/Developer', symlinkedAncestor);
      const projectPath = join(symlinkedAncestor, 'app');

      expect(volumeRootFor(projectPath)).not.toBe('/Volumes/UnmountedTestVolume');
      expect(isOnMountedVolume(projectPath, ['/'])).toBe(false);
      expect(isOnMountedVolume(projectPath, ['/', '/Volumes/UnmountedTestVolume'])).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  },
);

describe.skipIf(process.platform !== 'win32')('the Windows volume model', () => {
  test('a drive path and a UNC path each report their own root', () => {
    expect(volumeRootFor('C:\\Users\\j\\Developer\\app')).toBe('C:\\');
    expect(volumeRootFor('c:/Users/j/Developer/app')).toBe('C:\\');
    expect(volumeRootFor('\\\\server\\share\\Developer\\app')).toBe('\\\\server\\share\\');
  });

  test('listMountedVolumes keeps only the drive roots that are present', () => {
    const present = new Set(['C:\\', 'Z:\\']);
    const statFn = ((target: string) => {
      if (!present.has(String(target))) throw new Error('not present');
      return { dev: 1 };
    }) as unknown as typeof import('node:fs').statSync;
    expect(listMountedVolumes({ statFn })).toEqual(['C:\\', 'Z:\\']);
  });

  test('a path on a drive that is gone, or on no drive at all, is not on a mounted volume', () => {
    expect(isOnMountedVolume('Z:\\Developer\\app', ['C:\\'])).toBe(false);
    expect(isOnMountedVolume('\\Users\\j\\Developer\\app', ['C:\\'])).toBe(false);
  });

  test('a path on a UNC share outside the drive list is on a mounted volume only while the share is reachable', () => {
    const path = '\\\\localhost\\C$\\stim-unc-probe\\app';
    const share = volumeRootFor(path);
    const statFor = (reachable: boolean) =>
      ((target: string) => {
        if (!reachable || String(target) !== share) throw new Error('unreachable');
        return { isDirectory: () => true };
      }) as unknown as typeof import('node:fs').statSync;
    expect(isOnMountedVolume(path, ['C:\\'], { statFn: statFor(true) })).toBe(true);
    expect(isOnMountedVolume(path, ['C:\\'], { statFn: statFor(false) })).toBe(false);
  });
});

test('isOnMountedVolume returns false for a path it cannot resolve', () => {
  expect(isOnMountedVolume('relative/path/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('~/Developer/app', ['/'])).toBe(false);
  expect(isOnMountedVolume('/Volumes/StimTestVolumeThatDoesNotExist/app', ['/'])).toBe(false);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a size walk that is aborted, or whose du exits non-zero on a folder that exists, writes a size_failed record with its reason',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
    vi.stubEnv('STIM_HOME', home);
    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        measuredDirectorySizeAsync(join(home, 'cache'), { timeoutMs: 10_000, signal: aborted.signal }),
      ).rejects.toThrow(/abort/i);
      expect(directorySize(join(home, 'missing'), { timeoutMs: 10_000 })).toBe(0);
      const locked = join(home, 'locked');
      mkdirSync(join(locked, 'inner'), { recursive: true });
      chmodSync(join(locked, 'inner'), 0o000);
      directorySize(locked, { timeoutMs: 10_000 });
      chmodSync(join(locked, 'inner'), 0o755);
      const records = readFileSync(daemonNdjsonFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      expect(records).toEqual([
        expect.objectContaining({ event: 'size_failed', path: join(home, 'cache'), reason: 'aborted' }),
        expect.objectContaining({ event: 'size_failed', path: locked, reason: 'exit', status: 1 }),
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
