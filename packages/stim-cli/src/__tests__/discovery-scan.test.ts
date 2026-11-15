import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { discoveryScanFile, parseDiscoveryScan, readDiscoveryScan } from '@stim-cli/core/state';
import { discoveryScanDue, mergeFound, runDiscoveryScanIfDue, scanForCheckouts } from '../workspace/discovery-scan.ts';
import { scanDescends } from '../workspace/scan-rules.ts';

const marked = (path: string) => existsSync(join(path, 'package.json'));

describe('scanDescends', () => {
  it('skips dependency and build folders everywhere, and the excluded folders of the home folder only', () => {
    for (const name of ['node_modules', 'Pods', 'build', 'target', 'Library'])
      expect(scanDescends(name, 3)).toBe(false);
    for (const name of ['Desktop', 'Downloads', 'Movies']) {
      expect(scanDescends(name, 1)).toBe(false);
      expect(scanDescends(name, 2)).toBe(true);
    }
    expect(scanDescends('Documents', 1)).toBe(true);
    expect(scanDescends('dev', 1)).toBe(true);
  });

  it('enters a dot-folder directly in the home folder, but not a Stim one, a cache, or a deeper one', () => {
    expect(scanDescends('.exact', 1)).toBe(true);
    expect(scanDescends('.stim-agent', 1)).toBe(false);
    expect(scanDescends('.npm', 1)).toBe(false);
    expect(scanDescends('.some-tool-cache', 1)).toBe(false);
    expect(scanDescends('.exact', 2)).toBe(false);
  });
});

describe('scanForCheckouts', () => {
  let home: string;
  const project = (...parts: string[]) => {
    mkdirSync(join(home, ...parts), { recursive: true });
    writeFileSync(join(home, ...parts, 'package.json'), '{}');
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-')));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds projects at depth, stops at one, and never reads pruned, dot, excluded or linked folders', async () => {
    project('Documents', 'a');
    project('dev', 'deep', 'er', 'b');
    project('dev', 'c');
    project('.exact', 'exact2');
    mkdirSync(join(home, 'dev', 'c', 'inner'));
    project('dev', 'c', 'inner');
    for (const skipped of [
      ['Desktop', 'x'],
      ['Downloads', 'x'],
      ['dev', 'node_modules', 'x'],
      ['dev', '.hidden', 'x'],
      ['.npm', 'x'],
      ['dev', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'too-deep'],
    ])
      project(...skipped);
    symlinkSync(join(home, 'Documents', 'a'), join(home, 'dev', 'linked'));
    const scan = await scanForCheckouts(home, marked);
    expect(scan.found.toSorted()).toEqual(
      [
        join(home, 'Documents', 'a'),
        join(home, 'dev', 'c'),
        join(home, 'dev', 'deep', 'er', 'b'),
        join(home, '.exact', 'exact2'),
      ].toSorted(),
    );
    expect(scan.truncated).toBe(false);
    expect(scan.unreadable).toEqual([]);
  });

  it('records a folder the system refuses as unreadable and goes on', async () => {
    project('dev', 'ok');
    mkdirSync(join(home, 'Documents'));
    mkdirSync(join(home, 'Documents', 'locked'), { mode: 0o000 });
    try {
      const scan = await scanForCheckouts(home, marked);
      expect(scan.found).toEqual([join(home, 'dev', 'ok')]);
      const refused = process.platform !== 'win32' && process.getuid?.() !== 0;
      expect(scan.unreadable).toEqual(refused ? [join(home, 'Documents', 'locked')] : []);
    } finally {
      chmodSync(join(home, 'Documents', 'locked'), 0o700);
    }
  });

  it('stops reading siblings at once when its budget is spent, as repeated timed-out stats spend it', async () => {
    for (let i = 0; i < 100; i++) project(`p${String(i).padStart(3, '0')}`);
    let stats = 0;
    const hung = async (path: string) => {
      if (path === home) return lstat(path);
      stats++;
      return new Promise<never>(() => {});
    };
    const pending = scanForCheckouts(home, marked, { budgetMs: 40, readTimeoutMs: 10, stat: hung });
    const state = { done: false };
    void pending.then(() => (state.done = true));
    while (!state.done) {
      if (stats > 0) await vi.advanceTimersByTimeAsync(10);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const scan = await pending;
    expect(scan.truncated).toBe(true);
    expect(stats).toBeLessThan(10);
  });

  it('stops at its time budget and says so', async () => {
    project('dev', 'one');
    const scan = await scanForCheckouts(home, marked, { budgetMs: -1 });
    expect(scan).toMatchObject({ found: [], truncated: true });
  });
});

describe('discoveryScanDue', () => {
  const now = Date.UTC(2026, 10, 14);
  const at = (ranAgo: number, completedAgo = ranAgo, lowAgo = 1e12) => ({
    ranAt: now - ranAgo,
    completedAt: now - completedAgo,
    lowScanAt: now - lowAgo,
  });
  const hour = 3_600_000;
  const day = 24 * hour;

  it('runs weekly from the last scan that did not fail, and when none or a future one is recorded', () => {
    expect(discoveryScanDue(null, now, false)).toBe(true);
    expect(discoveryScanDue(at(-1000), now, false)).toBe(true);
    expect(discoveryScanDue(at(6 * day), now, false)).toBe(false);
    expect(discoveryScanDue(at(7 * day), now, false)).toBe(true);
  });

  it('retries a failed scan after an hour, not after a week, and never twice within an hour', () => {
    expect(discoveryScanDue(at(30 * 60_000, 8 * day), now, false)).toBe(false);
    expect(discoveryScanDue(at(2 * hour, 8 * day), now, false)).toBe(true);
  });

  it('scans while the disk level is above normal when no scan ran during it for an hour, even right after the weekly one', () => {
    expect(discoveryScanDue(at(2 * hour), now, true)).toBe(true);
    expect(discoveryScanDue(at(2 * hour, 2 * hour, 3 * hour), now, true)).toBe(true);
    expect(discoveryScanDue(at(2 * hour, 2 * hour, 90 * 60_000), now, true)).toBe(true);
    expect(discoveryScanDue(at(30 * 60_000, 30 * 60_000, 30 * 60_000), now, true)).toBe(false);
  });
});

describe('mergeFound', () => {
  const outcome = (found: string[], unreadable: string[], truncated: boolean) => ({
    found,
    unreadable,
    truncated,
    visited: 1,
  });
  it('keeps the previous finds under an unreadable folder, drops the others, and keeps all of them when truncated', () => {
    const previous = ['/h/Documents/a', '/h/dev/b'];
    expect(mergeFound(previous, outcome(['/h/dev/c'], ['/h/Documents'], false))).toEqual([
      '/h/Documents/a',
      '/h/dev/c',
    ]);
    expect(mergeFound(previous, outcome(['/h/dev/c'], [], true))).toEqual(['/h/Documents/a', '/h/dev/b', '/h/dev/c']);
  });
});

describe('a scan file that is corrupt or in an older format', () => {
  it('is no result', () => {
    expect(
      parseDiscoveryScan({
        version: 1,
        ranAt: 1,
        durationMs: 1,
        trigger: 'weekly',
        visited: 1,
        found: [],
        unreadable: [],
        truncated: false,
      }),
    ).toBeNull();
    expect(parseDiscoveryScan({ version: 2, ranAt: 1 })).toBeNull();
    expect(parseDiscoveryScan('nope')).toBeNull();
  });
});

describe('runDiscoveryScanIfDue', () => {
  let base: string;
  const normal = [{ volume: '/', freeMb: 500_000 }];
  const low = [{ volume: '/', freeMb: 10_000 }];
  const tick = (disk = normal, env: NodeJS.ProcessEnv = {}, operation = testContext({ env })) => ({
    operation,
    measured: { measurement: { disk } },
  });
  const hour = 3_600_000;
  const t0 = Date.UTC(2026, 10, 14);
  const options = (now: number) => ({ home: join(base, 'home'), now, attempted: { at: 0 } });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-run-')));
    mkdirSync(join(base, 'home', 'dev', 'app'), { recursive: true });
    writeFileSync(join(base, 'home', 'dev', 'app', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    mkdirSync(join(base, 'machine'));
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'machine'));
    vi.stubEnv('USERPROFILE', join(base, 'machine'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('never scans for a command, only for a daemon tick', async () => {
    await runDiscoveryScanIfDue(undefined, options(t0));
    expect(readDiscoveryScan()).toBeNull();
  });

  it('never scans in a scoped home and writes nothing', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'state'));
    await runDiscoveryScanIfDue(tick(normal, { STIM_HOME: join(base, 'state') }), options(t0));
    expect(existsSync(join(base, 'state'))).toBe(false);
  });

  it('records finds under a home dot-folder apart from the others', async () => {
    mkdirSync(join(base, 'home', '.exact', 'exact2'), { recursive: true });
    writeFileSync(
      join(base, 'home', '.exact', 'exact2', 'package.json'),
      JSON.stringify({ dependencies: { expo: '*' } }),
    );
    await runDiscoveryScanIfDue(tick(), options(t0));
    expect(readDiscoveryScan()).toMatchObject({
      found: [join(base, 'home', 'dev', 'app')],
      dotFolderFound: [join(base, 'home', '.exact', 'exact2')],
    });
  });

  it('stores the result and its schedule under the Stim home, and not again until due', async () => {
    await runDiscoveryScanIfDue(tick(), options(t0));
    expect(readDiscoveryScan()).toMatchObject({
      trigger: 'weekly',
      ranAt: t0,
      completedAt: t0,
      lowScanAt: 0,
      found: [join(base, 'home', 'dev', 'app')],
      truncated: false,
    });
    expect(discoveryScanFile().startsWith(join(base, 'machine'))).toBe(true);
    const before = readFileSync(discoveryScanFile(), 'utf8');
    await runDiscoveryScanIfDue(tick(), options(t0 + 2 * hour));
    expect(readFileSync(discoveryScanFile(), 'utf8')).toBe(before);
  });

  it('scans again an hour or more after a scan when the disk level is above normal, whatever a worker remembers', async () => {
    await runDiscoveryScanIfDue(tick(), options(t0));
    await runDiscoveryScanIfDue(tick(low), options(t0 + 2 * hour));
    expect(readDiscoveryScan()).toMatchObject({
      trigger: 'low-disk',
      ranAt: t0 + 2 * hour,
      lowScanAt: t0 + 2 * hour,
      completedAt: t0 + 2 * hour,
    });
  });

  it('keeps the previous finds when a scan fails and records the attempt', async () => {
    await runDiscoveryScanIfDue(tick(), options(t0));
    rmSync(join(base, 'home'), { recursive: true });
    await runDiscoveryScanIfDue(tick(low), options(t0 + 2 * hour));
    expect(readDiscoveryScan()).toMatchObject({
      ranAt: t0 + 2 * hour,
      completedAt: t0,
      truncated: true,
      found: [join(base, 'home', 'dev', 'app')],
    });
  });

  it('lets an abort escape instead of returning normally, and stores nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDiscoveryScanIfDue(tick(normal, {}, testContext({ signal: controller.signal })), options(t0)),
    ).rejects.toThrow(/abort/i);
    expect(readDiscoveryScan()).toBeNull();
  });
});
