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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { discoveryScanFile, readDiscoveryScan } from '@stim-cli/core/state';
import {
  discoveryScanDue,
  runDiscoveryScanIfDue,
  scanDescends,
  scanForCheckouts,
} from '../workspace/discovery-scan.ts';

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

  it('enters a dot-folder of the home folder unless it is a tool home or cache, and no deeper dot-folder', () => {
    expect(scanDescends('.exact', 1)).toBe(true);
    for (const name of ['.git', '.npm', '.gradle', '.cache', '.stim', '.codex', '.member-app-metro-cache'])
      expect(scanDescends(name, 1)).toBe(false);
    for (const name of ['.worktrees', '.exact', '.claude']) expect(scanDescends(name, 2)).toBe(false);
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

  it('stops at its time budget and says so', async () => {
    project('dev', 'one');
    const scan = await scanForCheckouts(home, marked, { budgetMs: -1 });
    expect(scan).toMatchObject({ found: [], truncated: true });
  });
});

describe('discoveryScanDue', () => {
  const now = Date.UTC(2026, 10, 14);
  const ago = (ms: number) => ({ ranAt: now - ms });
  it('runs weekly, an hour after a rise in the disk level, and when no scan or a future one is recorded', () => {
    expect(discoveryScanDue(null, now, false)).toBe(true);
    expect(discoveryScanDue(ago(-1000), now, false)).toBe(true);
    expect(discoveryScanDue(ago(6 * 86_400_000), now, false)).toBe(false);
    expect(discoveryScanDue(ago(7 * 86_400_000), now, false)).toBe(true);
    expect(discoveryScanDue(ago(30 * 60_000), now, true)).toBe(false);
    expect(discoveryScanDue(ago(61 * 60_000), now, true)).toBe(true);
  });
});

describe('runDiscoveryScanIfDue', () => {
  let base: string;
  const normal = [{ volume: '/', freeMb: 500_000 }];
  const low = [{ volume: '/', freeMb: 10_000 }];
  const tick = (disk = normal, env: NodeJS.ProcessEnv = {}) => ({
    operation: testContext({ env }),
    measured: { measurement: { disk } },
  });
  const memory = () => ({ attemptedAt: 0, wasLow: false });
  const scanned = () => readDiscoveryScan()?.trigger;

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
    await runDiscoveryScanIfDue(undefined, { home: join(base, 'home'), memory: memory() });
    expect(readDiscoveryScan()).toBeNull();
  });

  it('never scans in a scoped home and writes nothing', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'state'));
    await runDiscoveryScanIfDue(tick(normal, { STIM_HOME: join(base, 'state') }), {
      home: join(base, 'home'),
      memory: memory(),
    });
    expect(existsSync(join(base, 'state'))).toBe(false);
  });

  it('stamps the result under the Stim home and does not scan again until it is due', async () => {
    const options = { home: join(base, 'home'), memory: memory() };
    await runDiscoveryScanIfDue(tick(), options);
    expect(readDiscoveryScan()).toMatchObject({
      trigger: 'weekly',
      found: [join(base, 'home', 'dev', 'app')],
      truncated: false,
    });
    expect(discoveryScanFile().startsWith(join(base, 'machine'))).toBe(true);
    const before = readFileSync(discoveryScanFile(), 'utf8');
    await runDiscoveryScanIfDue(tick(), options);
    expect(readFileSync(discoveryScanFile(), 'utf8')).toBe(before);
  });

  it('scans once the disk level rises above normal an hour after the last scan, not again while it stays low', async () => {
    const options = { home: join(base, 'home'), memory: memory() };
    const backdate = () => {
      writeFileSync(discoveryScanFile(), JSON.stringify({ ...readDiscoveryScan(), ranAt: Date.now() - 2 * 3_600_000 }));
      options.memory.attemptedAt = 0;
    };
    await runDiscoveryScanIfDue(tick(), options);
    backdate();
    await runDiscoveryScanIfDue(tick(low), options);
    expect(scanned()).toBe('low-disk');
    backdate();
    await runDiscoveryScanIfDue(tick(low), options);
    expect(Date.now() - (readDiscoveryScan()?.ranAt ?? 0)).toBeGreaterThan(3_600_000);
  });

  it('does not walk again within the interval when the result cannot be stored, and does not throw', async () => {
    writeFileSync(join(base, 'machine', '.stim'), 'a file where the Stim home folder belongs');
    const options = { home: join(base, 'home'), memory: memory() };
    await expect(runDiscoveryScanIfDue(tick(), options)).resolves.toBeUndefined();
    expect(options.memory.attemptedAt).toBeGreaterThan(0);
    const attempted = options.memory.attemptedAt;
    await runDiscoveryScanIfDue(tick(), options);
    expect(options.memory.attemptedAt).toBe(attempted);
  });
});
