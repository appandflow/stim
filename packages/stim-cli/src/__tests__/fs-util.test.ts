import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { daemonNdjsonFile } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  directorySize,
  volumeRootFor,
  isRealMount,
  isOnMountedVolume,
  listMountedVolumes,
  measureDirectoryAsync,
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

test('a size walk stopped by a signal, or that could not run, writes its reason', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
  vi.stubEnv('STIM_HOME', home);
  const failures: Record<string, object> = {
    [join(home, 'killed')]: Object.assign(new Error('killed'), { signal: 'SIGKILL' }),
    [join(home, 'denied')]: Object.assign(new Error('denied'), { code: 'EACCES' }),
  };
  setExecutor({
    ...getExecutor(),
    runFileAsync: async (_file, args) => {
      throw failures[args.at(-1) ?? ''];
    },
  });
  try {
    for (const dir of Object.keys(failures))
      expect(await measuredDirectorySizeAsync(dir, { timeoutMs: 10_000 })).toBeNull();
    const records = readFileSync(daemonNdjsonFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    expect(records).toEqual([
      expect.objectContaining({ path: join(home, 'killed'), reason: 'signal', signal: 'SIGKILL' }),
      expect.objectContaining({ path: join(home, 'denied'), reason: 'error', code: 'EACCES' }),
    ]);
  } finally {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

describe('a size walk that reports what it measured', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
    vi.stubEnv('STIM_HOME', home);
  });
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const folder = (entries: number): string => {
    const dir = join(home, 'target');
    for (let index = 0; index < entries; index++)
      mkdirSync(join(dir, `entry-${String(index).padStart(3, '0')}`), { recursive: true });
    return dir;
  };
  const timedOut = (stdout = '') => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout });

  test('a walk of a large folder cut off at its deadline reports the entries du printed as a partial size, and stays unknown to callers that decide', async () => {
    const dir = folder(101);
    const walks: string[][] = [];
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        walks.push([file, ...args]);
        throw timedOut(`100\t${join(dir, 'entry-000')}\n200\t${join(dir, 'entry-001')}\n7`);
      },
    });
    expect(await measureDirectoryAsync(dir, { timeoutMs: 10_000 })).toEqual({ bytes: 300 * 1024, partial: true });
    expect(await measuredDirectorySizeAsync(dir, { timeoutMs: 10_000 })).toBeNull();
    expect(walks[0]).toEqual(['du', '-k', '-d', '1', dir]);
  });

  test('a walk of a large folder that finishes reports the total du prints last', async () => {
    const dir = folder(101);
    setExecutor({
      ...getExecutor(),
      runFileAsync: async () => `100\t${join(dir, 'entry-000')}\n200\t${join(dir, 'entry-001')}\n350\t${dir}`,
    });
    expect(await measureDirectoryAsync(dir, { timeoutMs: 10_000 })).toEqual({ bytes: 350 * 1024 });
  });

  test('a walk of a small folder cut off at its deadline reports the entries that finished as a partial size', async () => {
    const dir = folder(3);
    const walks: string[] = [];
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (_file, args) => {
        walks.push(args.join(' '));
        if (args.at(-1) === join(dir, 'entry-001')) throw timedOut();
        return `40\t${args.at(-1)}`;
      },
    });
    expect(await measureDirectoryAsync(dir, { timeoutMs: 10_000 })).toEqual({ bytes: 40 * 1024, partial: true });
    expect(walks).toEqual([`-sk ${join(dir, 'entry-000')}`, `-sk ${join(dir, 'entry-001')}`]);
  });

  test('a walk of a small folder that finishes reports the sum of its entries', async () => {
    const dir = folder(3);
    const sizes: Record<string, number> = { 'entry-000': 40, 'entry-001': 8, 'entry-002': 300 };
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (_file, args) => `${sizes[basename(String(args.at(-1)))]}\t${args.at(-1)}`,
    });
    expect(await measureDirectoryAsync(dir, { timeoutMs: 10_000 })).toEqual({ bytes: 348 * 1024 });
  });
});

test.each(['darwin', 'linux'] as const)(
  'on %s a low-priority walk throttles no I/O unless its caller asks for it',
  async (platform) => {
    const actual = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    const walks: string[][] = [];
    setExecutor({
      findExecutable: (name) => (name === 'ionice' ? '/usr/bin/ionice' : null),
      runFileAsync: async (file, args) => {
        walks.push([file, ...args]);
        return `4\t${args.at(-1)}\n`;
      },
    });
    try {
      await measuredDirectorySizeAsync('/cargo/target', { timeoutMs: 10_000, lowPriority: true });
      expect(walks).toEqual([['nice', '-n', '19', 'du', '-sk', '/cargo/target']]);
    } finally {
      Object.defineProperty(process, 'platform', { value: actual });
      resetExecutor();
    }
  },
);
