import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CensusFind, DiscoveryCensusFile, DiscoveryScan, DiscoveryScanFile } from '@stim-cli/core/state';
import {
  adoptCommand,
  discoveryLines,
  discoveryReport,
  lowDiskLine,
  type DiscoverRootsValue,
} from '../workspace/discovery-report.ts';

const home = '/Users/me';
const now = Date.UTC(2026, 10, 20);
const day = 24 * 60 * 60_000;
const GB = 1024 ** 3;

const scan: DiscoveryScan = {
  version: 2,
  ranAt: Date.UTC(2026, 10, 14),
  completedAt: Date.UTC(2026, 10, 14),
  lowScanAt: 0,
  durationMs: 1000,
  trigger: 'weekly',
  visited: 4200,
  found: [],
  dotFolderFound: [],
  unreadable: [],
  truncated: false,
  truncation: 'none',
};

function find(over: Partial<CensusFind> & Pick<CensusFind, 'path'>): CensusFind {
  return {
    kind: 'reduce-only',
    folder: over.path.slice(0, over.path.lastIndexOf('/')),
    adoptable: true,
    evaluatedAt: now,
    dirs: 1,
    measuredDirs: 1,
    failedDirs: 0,
    partialDirs: 0,
    bytes: GB,
    unreadable: false,
    gitActivityAt: null,
    ...over,
  };
}

const census = (finds: CensusFind[]): DiscoveryCensusFile => ({
  status: 'read',
  census: {
    version: 1,
    at: now,
    scanRanAt: scan.ranAt,
    roots: [],
    canonicalRoots: [],
    pending: false,
    finds,
  },
});

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const same = (path: string) => path;
const noRoots: DiscoverRootsValue = { value: [], error: null };

function report(
  finds: CensusFind[],
  setting: DiscoverRootsValue = noRoots,
  scanFile: DiscoveryScanFile = { status: 'read', scan },
) {
  return discoveryReport({
    scan: scanFile,
    census: census(finds),
    setting,
    home,
    canonical: realpathOrSelf,
  });
}

describe('adoptCommand', () => {
  it('builds the pasteable command from the current value, quoting a path with a single quote for the shell', () => {
    expect(adoptCommand({ value: ['/a'], error: null }, "/Users/me/it's here")).toBe(
      `stim settings set maintenance.discoverRoots '["/a","/Users/me/it'\\''s here"]' --scope machine`,
    );
  });

  it('offers none when the current value does not read', () => {
    expect(adoptCommand({ value: undefined, error: 'maintenance is not an object' }, '/a')).toBeNull();
    expect(adoptCommand({ value: 'x', error: null }, '/a')).toBeNull();
  });
});

describe('discoveryReport', () => {
  it('groups by containing folder, reduce-only first, each with its own sum and adopt command', () => {
    const result = report([
      find({
        path: '/Users/me/.exact/exact2/a',
        kind: 'dot-folder',
        folder: '/Users/me/.exact/exact2',
        bytes: 80 * GB,
      }),
      find({ path: '/Users/me/dev/app1', bytes: 2 * GB }),
      find({ path: '/Users/me/dev/app2', bytes: 3 * GB }),
    ]);
    expect(result.groups.map(({ folder, kind, checkouts, bytes }) => ({ folder, kind, checkouts, bytes }))).toEqual([
      { folder: '/Users/me/dev', kind: 'reduce-only', checkouts: 2, bytes: 5 * GB },
      { folder: '/Users/me/.exact/exact2', kind: 'dot-folder', checkouts: 1, bytes: 80 * GB },
    ]);
    expect(result.groups[1]?.command).toBe(
      `stim settings set maintenance.discoverRoots '["/Users/me/.exact/exact2"]' --scope machine`,
    );
  });

  it('shows a folder that maintenance.discoverRoots names since the daemon classified, with no command and the reason', () => {
    const result = report([find({ path: '/Users/me/dev/app1' }), find({ path: '/Users/me/work/app2' })], {
      value: ['~/dev'],
      error: null,
    });
    const byFolder = Object.fromEntries(result.groups.map((group) => [group.folder, group]));
    expect(byFolder['/Users/me/dev']).toMatchObject({ command: null, commandProblem: 'already-named' });
    expect(byFolder['/Users/me/work']?.command).toContain(`'["~/dev","/Users/me/work"]'`);
  });

  it('offers no command for the home folder, and none when the setting does not read, and says which', () => {
    const [direct] = report([
      find({ path: '/Users/me/.mytool', kind: 'dot-folder', folder: '/Users/me', adoptable: false }),
    ]).groups;
    expect(direct).toMatchObject({ command: null, commandProblem: 'too-broad' });
    const [broken] = report([find({ path: '/Users/me/dev/a' })], { value: undefined, error: 'bad' }).groups;
    expect(broken).toMatchObject({ command: null, commandProblem: 'setting-unreadable' });
  });

  it('counts a checkout that failed and one not measured yet apart from the measured, never as zero bytes', () => {
    const [group] = report([
      find({ path: '/Users/me/dev/a', bytes: GB }),
      find({ path: '/Users/me/dev/b', bytes: 0, measuredDirs: 0, failedDirs: 1 }),
      find({ path: '/Users/me/dev/c', bytes: 0, measuredDirs: 0, failedDirs: 0, evaluatedAt: 0, dirs: 0 }),
    ]).groups;
    expect(group).toMatchObject({ measured: 1, failed: 1, notMeasuredYet: 1, bytes: GB });
    expect(
      discoveryLines(report([find({ path: '/Users/me/dev/b', bytes: 0, measuredDirs: 0, failedDirs: 1 })]), home).join(
        '\n',
      ),
    ).toContain('build output not measured');
  });

  it('counts a checkout whose layout could not be read as could not be measured, never as a measured zero', () => {
    const [group] = report([
      find({ path: '/Users/me/dev/a', bytes: 0, dirs: 0, measuredDirs: 0, unreadable: true }),
    ]).groups;
    expect(group).toMatchObject({ measured: 0, failed: 1, notMeasuredYet: 0 });
  });

  it('shows no measurement of a census made from an older scan than the scan file holds', () => {
    const older = { ...scan, ranAt: scan.ranAt + 1 };
    const result = discoveryReport({
      scan: { status: 'read', scan: older },
      census: census([find({ path: '/Users/me/dev/a', bytes: 5 * GB })]),
      setting: noRoots,
      home,
      canonical: same,
    });
    expect(result.censusCurrent).toBe(false);
    expect(result.groups[0]).toMatchObject({ bytes: 0, measured: 0, notMeasuredYet: 1 });
    expect(lowDiskLine(result, home)).toBeNull();
  });

  it('shows the age of the oldest measurement, and a folder the setting names through a symlink as already named', () => {
    const [group] = report([
      find({ path: '/Users/me/dev/a', evaluatedAt: now - 5 * day }),
      find({ path: '/Users/me/dev/b' }),
    ]).groups;
    expect(group?.oldestMeasuredAt).toBe(now - 5 * day);
    const dir = mkdtempSync(join(tmpdir(), 'stim-report-'));
    try {
      const real = realpathSync(dir);
      mkdirSync(join(real, 'target'));
      symlinkSync(join(real, 'target'), join(real, 'link'));
      const result = report([find({ path: `${real}/target/app`, folder: join(real, 'target') })], {
        value: [join(real, 'link')],
        error: null,
      });
      expect(result.groups).toMatchObject([{ command: null, commandProblem: 'already-named' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable, absent and unusable scan or census apart', () => {
    const base = { setting: noRoots, home, canonical: same };
    const missing: DiscoveryCensusFile = { status: 'absent' };
    expect(discoveryReport({ ...base, scan: { status: 'absent' }, census: missing }).scan).toEqual({
      status: 'absent',
    });
    expect(discoveryReport({ ...base, scan: { status: 'unreadable' }, census: missing }).scan).toEqual({
      status: 'unreadable',
    });
    expect(discoveryReport({ ...base, scan: { status: 'read', scan: null }, census: missing }).scan).toEqual({
      status: 'unusable',
    });
    const scanFile: DiscoveryScanFile = { status: 'read', scan };
    const withScan = { ...base, scan: scanFile };
    expect(discoveryReport({ ...withScan, census: missing }).census).toBe('absent');
    expect(discoveryReport({ ...withScan, census: { status: 'unreadable' } }).census).toBe('unreadable');
    expect(discoveryReport({ ...withScan, census: { status: 'read', census: null } }).census).toBe('unusable');
  });
});

describe('sizes', () => {
  it('prints a group measured with no build output as zero, not as a megabyte', () => {
    const text = discoveryLines(report([find({ path: '/Users/me/dev/a', bytes: 0 })]), home).join('\n');
    expect(text).toContain('0 B of build output');
  });

  it('reads a checkout whose du was partial as at least, never as exact', () => {
    const result = report([find({ path: '/Users/me/dev/a', partialDirs: 1 })]);
    expect(result.groups[0]).toMatchObject({ measured: 1, partial: 1 });
    expect(discoveryLines(result, home).join('\n')).toContain('at least 1.0 GB');
    expect(lowDiskLine(result, home)).toContain('at least');
  });
});

describe('the largest folder on the low-disk line', () => {
  it('reads as at least when that folder holds a partial, failed or not yet measured checkout, and exact otherwise', () => {
    const exact = lowDiskLine(report([find({ path: '/Users/me/dev/a', bytes: 2 * GB })]), home);
    expect(exact).toContain('(2.0 GB)');
    for (const over of [{ partialDirs: 1 }, { failedDirs: 1, measuredDirs: 0 }, { evaluatedAt: 0 }]) {
      const line = lowDiskLine(report([find({ path: '/Users/me/dev/a', bytes: 2 * GB, ...over })]), home);
      expect(line).toContain('(at least 2.0 GB)');
    }
  });

  it('lists a group below a configured root with its own command, and the root itself as already named', () => {
    const below = find({ path: '/Users/me/.exact/exact2/a', folder: '/Users/me/.exact/exact2', kind: 'dot-folder' });
    const direct = find({ path: '/Users/me/.exact/b', folder: '/Users/me/.exact', kind: 'dot-folder' });
    const result = report([below, direct], { value: ['/Users/me/.exact'], error: null });
    const byFolder = Object.fromEntries(result.groups.map((group) => [group.folder, group]));
    expect(byFolder['/Users/me/.exact/exact2']?.command).toContain('/Users/me/.exact/exact2');
    expect(byFolder['/Users/me/.exact']).toMatchObject({ command: null, commandProblem: 'already-named' });
  });
});

describe('completeness', () => {
  const finished = (over: Partial<DiscoveryScan> = {}) => ({ status: 'read', scan: { ...scan, ...over } }) as const;

  it('is one value that the totals, the figures and the all-managed sentence follow: a truncated scan with measured finds reads at least', () => {
    const complete = report([find({ path: '/Users/me/dev/a', bytes: GB })]);
    expect(complete.complete).toBe(true);
    expect(lowDiskLine(complete, home)).toContain('hold 1.0 GB');
    for (const over of [
      { truncated: true, truncation: 'budget' as const },
      { truncated: true, truncation: 'failed' as const },
      { unreadable: ['/Users/me/Documents/x'] },
    ]) {
      const result = report([find({ path: '/Users/me/dev/a', bytes: GB })], noRoots, finished(over));
      expect(result.complete).toBe(false);
      expect(lowDiskLine(result, home)).toContain('hold at least 1.0 GB');
      expect(discoveryLines(result, home).join('\n')).toContain('at least 1.0 GB');
    }
  });

  it('is false for a pending census or one made from another scan, and true only when nothing is unknown', () => {
    const pending: DiscoveryCensusFile = {
      status: 'read',
      census: { version: 1, at: now, scanRanAt: scan.ranAt, roots: [], canonicalRoots: [], pending: true, finds: [] },
    };
    const input = { scan: finished(), setting: noRoots, home, canonical: same };
    expect(discoveryReport({ ...input, census: pending }).complete).toBe(false);
    expect(discoveryReport({ ...input, census: census([]) }).complete).toBe(true);
    expect(discoveryReport({ ...input, scan: finished({ ranAt: scan.ranAt + 1 }), census: census([]) }).complete).toBe(
      false,
    );
  });

  it('lists a find under a broad configured root with the home-folder wording, and the line follows', () => {
    const file: DiscoveryCensusFile = {
      status: 'read',
      census: {
        version: 1,
        at: now,
        scanRanAt: scan.ranAt,
        roots: ['/Users/me'],
        canonicalRoots: [],
        pending: false,
        finds: [find({ path: '/Users/me/app', folder: '/Users/me', adoptable: false })],
      },
    };
    const result = discoveryReport({
      scan: finished(),
      census: file,
      setting: { value: ['~'], error: null },
      home,
      canonical: same,
    });
    expect(result.groups).toMatchObject([{ folder: '/Users/me', command: null, commandProblem: 'too-broad' }]);
    expect(result.complete).toBe(true);
    expect(lowDiskLine(result, home)).toContain('hold 1.0 GB');
  });

  it('lists an unchecked direct child of a configured root with no adopt command', () => {
    const result = report([find({ path: '/Users/me/dev/a', kind: 'unchecked' })], {
      value: ['/Users/me/dev'],
      error: null,
    });
    expect(result.groups).toMatchObject([{ kind: 'unchecked', command: null }]);
    expect(result.complete).toBe(false);
  });
});

describe('what the listing may claim', () => {
  it('says every checkout is managed only for a finished scan, a census made from it and no unchecked find', () => {
    const lines = (scanOver: Partial<DiscoveryScan>, finds: CensusFind[] = []) =>
      discoveryLines(report(finds, noRoots, { status: 'read', scan: { ...scan, ...scanOver } }), home);
    expect(lines({}).join('\n')).toContain('Every checkout it found is managed.');
    expect(lines({ truncated: true, truncation: 'budget' }).join('\n')).not.toContain(
      'Every checkout it found is managed.',
    );
    expect(lines({ unreadable: ['/Users/me/Documents/x'] }).join('\n')).not.toContain(
      'Every checkout it found is managed.',
    );
    expect(lines({ ranAt: scan.ranAt + 1 }).join('\n')).not.toContain('Every checkout it found is managed.');
  });

  it('lists a find that could not be checked as its own group, with no command, never as managed', () => {
    const result = report([
      find({ path: '/Users/me/dev/a', kind: 'unchecked', evaluatedAt: now - 3 * day, gitActivityAt: now - 9 * day }),
    ]);
    expect(result.groups).toMatchObject([
      { kind: 'unchecked', checkouts: 1, command: null, commandProblem: 'unchecked', oldestMeasuredAt: now - 3 * day },
    ]);
    expect(lowDiskLine(result, home)).toContain('at least');
  });

  it('makes no filesystem call without a canonicaliser: it names a folder by the recorded roots, and says the setting changed', () => {
    const recorded = (roots: string[]): DiscoveryCensusFile => ({
      status: 'read',
      census: {
        version: 1,
        at: now,
        scanRanAt: scan.ranAt,
        roots,
        canonicalRoots: ['/real/dev'],
        pending: false,
        finds: [find({ path: '/real/dev/a', folder: '/real/dev' })],
      },
    });
    const through = (file: DiscoveryCensusFile, value: string[]) =>
      discoveryReport({
        scan: { status: 'read', scan },
        census: file,
        setting: { value, error: null },
        home,
        canonical: null,
      });
    expect(through(recorded(['/Users/me/link']), ['/Users/me/link']).groups).toMatchObject([
      { folder: '/real/dev', commandProblem: 'already-named' },
    ]);
    const changed = through(recorded(['/Users/me/link']), ['/Users/me/other']);
    expect(changed.rootsChangedSinceCensus).toBe(true);
    expect(changed.groups).toHaveLength(1);
    expect(changed.complete).toBe(false);
    expect(lowDiskLine(changed, home)).toBeNull();
  });
});

describe('members', () => {
  it('lists the checkouts oldest git activity first, unknown last, as ISO times or null', () => {
    const [group] = report([
      find({ path: '/Users/me/dev/unknown' }),
      find({ path: '/Users/me/dev/new', gitActivityAt: now - day }),
      find({ path: '/Users/me/dev/old', gitActivityAt: now - 40 * day }),
    ]).groups;
    expect(group?.members).toEqual([
      { path: '/Users/me/dev/old', gitActivityAt: new Date(now - 40 * day).toISOString() },
      { path: '/Users/me/dev/new', gitActivityAt: new Date(now - day).toISOString() },
      { path: '/Users/me/dev/unknown', gitActivityAt: null },
    ]);
  });

  it('prints the date or unknown for each, and shows no date for a census made from an older scan', () => {
    const finds = [
      find({ path: '/Users/me/dev/old', gitActivityAt: now - 40 * day }),
      find({ path: '/Users/me/dev/x' }),
    ];
    const text = discoveryLines(report(finds), home).join('\n');
    expect(text).toContain('~/dev/old: last git activity 2026-10-11');
    expect(text).toContain('~/dev/x: last git activity unknown');
    const stale = discoveryReport({
      scan: { status: 'read', scan: { ...scan, ranAt: scan.ranAt + 1 } },
      census: census(finds),
      setting: noRoots,
      home,
      canonical: same,
    });
    expect(stale.groups[0]?.members.every(({ gitActivityAt }) => gitActivityAt === null)).toBe(true);
  });
});

describe('discoveryLines', () => {
  it('words the two kinds differently, shows the command, when the scan ran and what it could not read', () => {
    const lines = discoveryLines(
      discoveryReport({
        scan: {
          status: 'read',
          scan: { ...scan, truncated: true, truncation: 'budget', unreadable: ['/Users/me/Documents/x'] },
        },
        census: census([
          find({
            path: '/Users/me/.exact/exact2/a',
            kind: 'dot-folder',
            folder: '/Users/me/.exact/exact2',
            bytes: 80 * GB,
          }),
          find({ path: '/Users/me/dev/old', bytes: 2 * GB }),
        ]),
        setting: noRoots,
        home,
        canonical: same,
      }),
      home,
    ).join('\n');
    expect(lines).toContain('last scanned the home folder on 2026-11-14');
    expect(lines).toContain('stopped early (time budget)');
    expect(lines).toContain('could not read ~/Documents/x');
    expect(lines).toContain('~/dev: 1 checkout, at least 2.0 GB of build output');
    expect(lines).toContain('~/.exact/exact2: 1 checkout, at least 80.0 GB of build output');
    expect(lines).toContain('Stim reduces their build output when idle and never removes them');
    expect(lines).toContain('Stim cannot tell a checkout from an installed tool, so it does nothing with them');
    expect(lines).toContain(`'["/Users/me/.exact/exact2"]'`);
    expect(lines).toContain('Stim has not checked whether they are in use or hold uncommitted or unpushed work');
  });
});

describe('lowDiskLine', () => {
  it('names the total and the largest reduce-only folder, though a dot-folder group is larger', () => {
    const line = lowDiskLine(
      report([
        find({
          path: '/Users/me/.exact/exact2/a',
          kind: 'dot-folder',
          folder: '/Users/me/.exact/exact2',
          bytes: 80 * GB,
        }),
        find({ path: '/Users/me/dev/app1', bytes: 2 * GB }),
      ]),
      home,
    );
    expect(line).toContain('hold 82.0 GB');
    expect(line?.endsWith(`stim settings set maintenance.discoverRoots '["/Users/me/dev"]' --scope machine`)).toBe(
      true,
    );
  });

  it('says at least when some output is unmeasured, and adds no command when only a dot-folder holds output', () => {
    const line = lowDiskLine(
      report([
        find({ path: '/Users/me/.t/a', kind: 'dot-folder', folder: '/Users/me/.t', bytes: 5 * GB }),
        find({
          path: '/Users/me/.t/b',
          kind: 'dot-folder',
          folder: '/Users/me/.t',
          bytes: 0,
          measuredDirs: 0,
          failedDirs: 1,
        }),
      ]),
      home,
    );
    expect(line).toBe(
      'Stim: checkouts it does not fully manage hold at least 5.0 GB of build output; stim doctor lists them.',
    );
  });

  it('adds nothing when nothing is measured or nothing is unmanaged', () => {
    expect(lowDiskLine(report([]), home)).toBeNull();
    expect(
      lowDiskLine(
        report([find({ path: '/Users/me/dev/a', bytes: 0, measuredDirs: 0, evaluatedAt: 0, dirs: 0 })]),
        home,
      ),
    ).toBeNull();
  });
});

describe('a list older than the state it is read against', () => {
  const lines = (file: DiscoveryCensusFile, value: string[]) =>
    discoveryLines(
      discoveryReport({
        scan: { status: 'read', scan },
        census: file,
        setting: { value, error: null },
        home,
        canonical: same,
      }),
      home,
    );
  const recorded = (roots: string[], at = now, finds = [find({ path: '/Users/me/dev/a' })]): DiscoveryCensusFile => ({
    status: 'read',
    census: { version: 1, at, scanRanAt: scan.ranAt, roots, canonicalRoots: [], pending: false, finds },
  });

  it('says the list predates the setting before the group, and offers no command or reason the old state decides', () => {
    const changed = lines(recorded([]), ['/Users/me/dev']);
    const unchanged = lines(recorded(['/Users/me/dev']), ['/Users/me/dev']);
    const group = changed.findIndex((line) => line.startsWith('~/dev:'));
    expect(changed.findIndex((line) => line.includes('maintenance.discoverRoots'))).toBeLessThan(group);
    expect(changed.slice(group + 1).some((line) => line.includes('maintenance.discoverRoots'))).toBe(false);
    expect(changed.some((line) => line.includes('stim settings set'))).toBe(false);
    expect(unchanged.some((line) => line.includes('discovery did not select'))).toBe(true);
    expect(changed.some((line) => line.includes('discovery did not select'))).toBe(false);
  });

  it('never reads a measurement older than a day when the census was made as a current exact figure', () => {
    const old = recorded([], now, [find({ path: '/Users/me/dev/a', evaluatedAt: now - 3 * day })]);
    const result = discoveryReport({
      scan: { status: 'read', scan },
      census: old,
      setting: noRoots,
      home,
      canonical: same,
    });
    expect(result.complete).toBe(false);
    const text = discoveryLines(result, home).join('\n');
    expect(text).toContain('at least 1.0 GB');
    expect(text).toContain('oldest measurement 2026-11-17');
    expect(lowDiskLine(result, home)).toContain('at least');
  });
});
