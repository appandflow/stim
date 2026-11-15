import { launcherDirectories } from '../workspace/launcher-directories.ts';
import { scanForCheckouts } from '../workspace/discovery-scan.ts';
import { launcherReader, launcherReason } from '../workspace/launchers.ts';

const missing = (code: string) => Object.assign(new Error(code), { code });

/** A fake of the directories on PATH: `listing` maps a directory to its entries, an Error, or nothing for absent. */
const io = (listing: Record<string, string[] | Error>, links: Record<string, string | Error> = {}) => ({
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

  it('keeps every checkout when a directory or an entry could not be inspected, naming the directory', async () => {
    const unreadable = await scan(['/locked', '/bin1'], io({ '/locked': missing('EACCES'), '/bin1': [] }));
    expect(unreadable.incomplete).toEqual(['/locked']);
    expect(launcherReason('/work/app', unreadable)).toContain('/locked');
    const unresolved = await scan(['/bin1'], io({ '/bin1': ['tool'] }, { '/bin1/tool': missing('EIO') }));
    expect(unresolved.incomplete).toEqual(['/bin1']);
    expect(launcherReason('/work/app', unresolved)).toContain('cannot be ruled out');
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
    expect(result.incomplete).toEqual(['/hung']);
    expect(launcherReason('/work/app', result)).toContain('permissions');

    const later = await Promise.all([reading(), reading(), reading()]);
    expect(later.map((entry) => entry.incomplete)).toEqual([['/hung'], ['/hung'], ['/hung']]);
    expect(started).toBe(1);

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
});
