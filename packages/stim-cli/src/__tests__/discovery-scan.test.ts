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
  it('skips dot-folders, dependency and build folders everywhere, and the excluded folders of the home folder only', () => {
    for (const name of ['.git', '.cache', 'node_modules', 'Pods', 'build', 'target', 'Library'])
      expect(scanDescends(name, 3)).toBe(false);
    for (const name of ['Desktop', 'Downloads', 'Movies']) {
      expect(scanDescends(name, 1)).toBe(false);
      expect(scanDescends(name, 2)).toBe(true);
    }
    expect(scanDescends('Documents', 1)).toBe(true);
    expect(scanDescends('dev', 1)).toBe(true);
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
    mkdirSync(join(home, 'dev', 'c', 'inner'));
    project('dev', 'c', 'inner');
    for (const skipped of [
      ['Desktop', 'x'],
      ['Downloads', 'x'],
      ['dev', 'node_modules', 'x'],
      ['dev', '.hidden', 'x'],
      ['dev', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'too-deep'],
    ])
      project(...skipped);
    symlinkSync(join(home, 'Documents', 'a'), join(home, 'dev', 'linked'));
    const scan = await scanForCheckouts(home, marked);
    expect(scan.found.toSorted()).toEqual([
      join(home, 'Documents', 'a'),
      join(home, 'dev', 'c'),
      join(home, 'dev', 'deep', 'er', 'b'),
    ]);
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
  it('runs weekly, hourly at low disk, and when no scan or a future one is recorded', () => {
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
  const tick = (env: NodeJS.ProcessEnv) => ({ operation: testContext({ env }) });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-run-')));
    mkdirSync(join(base, 'home', 'dev', 'app'), { recursive: true });
    writeFileSync(join(base, 'home', 'dev', 'app', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('never scans for a command, only for a daemon tick', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'machine'));
    mkdirSync(join(base, 'machine'));
    await runDiscoveryScanIfDue(undefined, null, join(base, 'home'));
    expect(readDiscoveryScan()).toBeNull();
  });

  it('never scans in a scoped home and writes nothing', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'state'));
    await runDiscoveryScanIfDue(tick({ STIM_HOME: join(base, 'state') }), null, join(base, 'home'));
    expect(existsSync(join(base, 'state'))).toBe(false);
  });

  it('stamps the result under the Stim home and does not scan again until it is due', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'machine'));
    mkdirSync(join(base, 'machine'));
    await runDiscoveryScanIfDue(tick({}), null, join(base, 'home'));
    const first = readDiscoveryScan();
    expect(first).toMatchObject({ trigger: 'weekly', found: [join(base, 'home', 'dev', 'app')], truncated: false });
    expect(discoveryScanFile().startsWith(join(base, 'machine'))).toBe(true);
    const before = readFileSync(discoveryScanFile(), 'utf8');
    await runDiscoveryScanIfDue(tick({}), null, join(base, 'home'));
    expect(readFileSync(discoveryScanFile(), 'utf8')).toBe(before);
  });
});
