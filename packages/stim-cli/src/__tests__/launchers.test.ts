import { launcherDirectories } from '../workspace/launcher-directories.ts';
import { scanForCheckouts } from '../workspace/discovery-scan.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherReader, launcherReason, launchersOf } from '../workspace/launchers.ts';
import { testContext } from './_context.ts';

vi.unmock('../workspace/launcher-directories.ts');

const missing = (code: string) => Object.assign(new Error(code), { code });

/** A fake of the directories on PATH: `listing` maps a directory to its entries, an Error, or nothing for absent. */
const io = (
  listing: Record<string, string[] | Error>,
  links: Record<string, string | Error> = {},
  unrunnable: readonly string[] = [],
  gone: Record<string, string> = {},
  opens: Record<string, string> = {},
) => ({
  readdir: async (path: string) => {
    const entry = listing[path];
    if (entry instanceof Error) throw entry;
    if (!entry) throw missing('ENOENT');
    return entry;
  },
  isSymlink: async (path: string) => path in links,
  realpath: async (path: string) => {
    const target = links[path];
    if (target instanceof Error) throw target;
    if (!target) throw missing('ENOENT');
    return target;
  },
  executable: async (path: string) => {
    if (gone[path]) throw missing(gone[path]);
    return !unrunnable.includes(path);
  },
  opened: async (path: string) => {
    const target = opens[path];
    if (!target) throw missing('ENOENT');
    return target;
  },
});

const scan = (directories: string[], fake: ReturnType<typeof io>) =>
  launcherReader(undefined, { directories, io: fake })();

describe('the PATH launcher scan', () => {
  it('finds a symlink that resolves into a checkout, and nothing for a checkout none points into', async () => {
    const result = await scan(['/bin1'], io({ '/bin1': ['tool'] }, { '/bin1/tool': '/work/app/target/release/tool' }));
    expect(result).toEqual({ targets: ['/work/app/target/release/tool'], incomplete: [] });
    expect(launcherReason('/work/app', result)).toContain('/work/app/target/release/tool');
    expect(launcherReason('/work/other', result)).toBeNull();
  });

  it('treats a missing directory, a dangling symlink and a file entry as no launcher, not as unknown', async () => {
    const result = await scan(
      ['/absent', '/bin1'],
      io({ '/bin1': ['dangling', 'plain'] }, { '/bin1/dangling': missing('ENOENT') }),
    );
    expect(result).toEqual({ targets: [], incomplete: [] });
    expect(launcherReason('/work/app', result)).toBeNull();
  });

  it('reports a directory or an entry that could not be inspected, and keeps no checkout for it', async () => {
    const unreadable = await scan(['/locked', '/bin1'], io({ '/locked': missing('EACCES'), '/bin1': [] }));
    expect(unreadable.incomplete).toEqual([{ kind: 'directory', path: '/locked', error: 'EACCES' }]);
    expect(launcherReason('/work/app', unreadable)).toBeNull();
    const unresolved = await scan(['/bin1'], io({ '/bin1': ['tool'] }, { '/bin1/tool': missing('EIO') }));
    expect(unresolved.incomplete).toEqual([{ kind: 'entry', path: '/bin1/tool', error: 'EIO' }]);
    expect(launcherReason('/work/app', unresolved)).toBeNull();
  });

  it('reads on past one entry that cannot be resolved, and still finds a launcher among the others', async () => {
    const result = await scan(
      ['/bin1'],
      io({ '/bin1': ['denied', 'tool'] }, { '/bin1/denied': missing('EPERM'), '/bin1/tool': '/work/app/bin/tool' }),
    );
    expect(result.targets).toEqual(['/work/app/bin/tool']);
    expect(result.incomplete).toEqual([{ kind: 'entry', path: '/bin1/denied', error: 'EPERM' }]);
  });

  it('passes over a symlink it may not resolve only when this user may not execute it either', async () => {
    const links = {
      '/usr/sbin/weakpass_edit': missing('EACCES'),
      '/usr/sbin/tool': '/work/app/.build/release/tool',
    };
    const entries = { '/usr/sbin': ['weakpass_edit', 'tool'] };
    const unrunnable = await scan(['/usr/sbin'], io(entries, links, ['/usr/sbin/weakpass_edit']));
    expect(unrunnable).toEqual({ targets: ['/work/app/.build/release/tool'], incomplete: [] });
    expect(launcherReason('/work/other', unrunnable)).toBeNull();
    const runnable = await scan(['/usr/sbin'], io(entries, links));
    expect(runnable.incomplete).toEqual([{ kind: 'entry', path: '/usr/sbin/weakpass_edit', error: 'EACCES' }]);
    const vanished = await scan(['/usr/sbin'], io(entries, links, [], { '/usr/sbin/weakpass_edit': 'ENOENT' }));
    expect(vanished).toEqual({ targets: ['/work/app/.build/release/tool'], incomplete: [] });
    const unchecked = await scan(['/usr/sbin'], io(entries, links, [], { '/usr/sbin/weakpass_edit': 'EIO' }));
    expect(unchecked.incomplete).toEqual([{ kind: 'entry', path: '/usr/sbin/weakpass_edit', error: 'EIO' }]);
  });

  it('resolves a link it may execute but not resolve through the file it opens to, keeping only that checkout', async () => {
    const entries = { '/usr/local/bin': ['1password-mcp'] };
    const links = { '/usr/local/bin/1password-mcp': missing('EACCES') };
    const outside = await scan(
      ['/usr/local/bin'],
      io(entries, links, [], {}, { '/usr/local/bin/1password-mcp': '/Applications/1Password.app/Contents/MacOS/mcp' }),
    );
    expect(outside).toEqual({ targets: ['/Applications/1Password.app/Contents/MacOS/mcp'], incomplete: [] });
    expect(launcherReason('/work/app', outside)).toBeNull();
    const inside = await scan(
      ['/usr/local/bin'],
      io(entries, links, [], {}, { '/usr/local/bin/1password-mcp': '/work/app/target/release/mcp' }),
    );
    expect(launcherReason('/work/app', inside)).toBe(
      'an executable on PATH runs from it (/work/app/target/release/mcp)',
    );
    expect(launcherReason('/work/other', inside)).toBeNull();
  });

  it('matches whole path segments, so a launcher into app-2 does not keep app', () => {
    const scanned = { targets: ['/work/app-2/bin/tool'], incomplete: [] };
    expect(launcherReason('/work/app', scanned)).toBeNull();
    expect(launcherReason('/work/app-2', scanned)).toContain('/work/app-2/bin/tool');
  });

  it('ends a reading at once as incomplete when a read does not answer, and starts no read while it is pending', async () => {
    let started = 0;
    let release: (names: string[]) => void = () => {};
    const stuck = {
      ...io({ '/bin1': ['tool'] }),
      readdir: (path: string) => {
        if (path !== '/hung') return Promise.resolve([]);
        started++;
        return new Promise<string[]>((resolve) => {
          release = resolve;
        });
      },
    };
    const reading = () => launcherReader(undefined, { directories: ['/hung', '/bin1'], io: stuck, timeoutMs: 10 })();

    const first = reading();
    await vi.advanceTimersByTimeAsync(10);
    const result = await first;
    expect(result.incomplete).toEqual([{ kind: 'pending', path: '/hung', error: 'timed out' }]);
    expect(launcherReason('/work/app', result)).toContain('/hung: timed out; Stim keeps every checkout');

    const pending = { kind: 'pending', path: '/hung', error: 'an earlier read of it has not answered' };
    const later = await Promise.all([reading(), reading(), reading()]);
    expect(later.map((entry) => entry.incomplete)).toEqual([[pending], [pending], [pending]]);
    expect(started).toBe(1);

    const outside = await launcherReader(undefined, { directories: ['/bin1'], io: stuck })();
    expect(outside.incomplete).toEqual([
      { kind: 'pending', path: '/hung', error: expect.stringContaining('outside the launcher directories') },
    ]);
    expect(launcherReason('/work/app', outside)).toContain('home scan');

    let scanReads = 0;
    const homeScan = await scanForCheckouts('/', () => false, {
      stat: async () => ({ dev: 1 }),
      entries: async () => {
        scanReads++;
        return [];
      },
    });
    expect(homeScan.truncated).toBe(true);
    expect(scanReads).toBe(0);

    release([]);
    await vi.advanceTimersByTimeAsync(0);
    const recovered = await launcherReader(undefined, { directories: ['/bin1'], io: stuck })();
    expect(recovered.incomplete).toEqual([]);
  });
});

describe('the launcher directories', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lists the PATH of the process when no environment is given, and of the given environment otherwise', () => {
    vi.stubEnv('PATH', '/from/process:/also/process');
    expect(launcherDirectories()).toEqual(expect.arrayContaining(['/from/process', '/also/process']));
    expect(launcherDirectories({ PATH: '/given' })).toContain('/given');
    expect(launcherDirectories({ PATH: '/given' })).not.toContain('/from/process');
  });

  it('lists the common install folders beside PATH, and the default reader of an operation reads them', async () => {
    expect(launcherDirectories({ PATH: '' })).toEqual(
      expect.arrayContaining(['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.cargo', 'bin')]),
    );
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-launchers-')));
    try {
      mkdirSync(join(base, 'bin'));
      writeFileSync(join(base, 'real'), 'x');
      symlinkSync(join(base, 'real'), join(base, 'bin', 'tool'));
      const found = await launchersOf(testContext({ env: { PATH: join(base, 'bin') } }), undefined, false)();
      expect(found.targets).toContain(join(base, 'real'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('keeps the planning reading of reduce-only checkouts apart from the one every other checkout shares', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-launchers-')));
    try {
      mkdirSync(join(base, 'bin'));
      writeFileSync(join(base, 'real'), 'x');
      const operation = testContext({ env: { PATH: join(base, 'bin') } });
      expect((await launchersOf(operation, undefined, false)()).targets).not.toContain(join(base, 'real'));
      symlinkSync(join(base, 'real'), join(base, 'bin', 'tool'));
      expect((await launchersOf(operation, undefined, false)()).targets).not.toContain(join(base, 'real'));
      expect((await launchersOf(operation, undefined, true)()).targets).toContain(join(base, 'real'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
