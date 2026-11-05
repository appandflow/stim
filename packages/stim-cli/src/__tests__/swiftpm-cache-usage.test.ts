import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;
let dir: string;
let du: ReturnType<typeof vi.fn<(file: string, args: string[]) => Promise<string>>>;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-swiftpm-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CACHE_HOME', join(home, '.cache'));
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  dir =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'org.swift.swiftpm')
      : join(home, '.cache', 'org.swift.swiftpm');
  du = vi.fn<(file: string, args: string[]) => Promise<string>>(
    async (_file: string, args: string[]) => `1536\t${args.at(-1)}\n`,
  );
  setExecutor({ runFileAsync: du });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test.skipIf(process.platform === 'darwin')(
  'XDG_CACHE_HOME overrides the home cache and changing it remeasures',
  async () => {
    mkdirSync(dir, { recursive: true });
    await getSwiftpmCacheUsage();
    const xdg = join(home, 'xdg');
    vi.stubEnv('XDG_CACHE_HOME', xdg);
    const other = join(xdg, 'org.swift.swiftpm');
    mkdirSync(other, { recursive: true });
    expect((await getSwiftpmCacheUsage()).dir).toBe(other);
    expect(du).toHaveBeenCalledTimes(2);
    vi.stubEnv('XDG_CACHE_HOME', '');
    expect((await getSwiftpmCacheUsage()).dir).toBe(dir);
    expect(du).toHaveBeenCalledTimes(3);
  },
);
