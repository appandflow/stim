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
    pending: false,
    finds,
  },
});

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

  it('leaves out a folder that maintenance.discoverRoots names since the daemon classified', () => {
    const result = report([find({ path: '/Users/me/dev/app1' }), find({ path: '/Users/me/work/app2' })], {
      value: ['~/dev'],
      error: null,
    });
    expect(result.groups.map(({ folder }) => folder)).toEqual(['/Users/me/work']);
    expect(result.groups[0]?.command).toContain(`'["~/dev","/Users/me/work"]'`);
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
    });
    expect(result.censusCurrent).toBe(false);
    expect(result.groups[0]).toMatchObject({ bytes: 0, measured: 0, notMeasuredYet: 1 });
    expect(lowDiskLine(result, home)).toBeNull();
  });

  it('shows the age of the oldest measurement, and leaves out a folder the setting names through a symlink', () => {
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
      expect(result.groups).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable, absent and unusable scan or census apart', () => {
    const base = { setting: noRoots, home };
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
      }),
      home,
    ).join('\n');
    expect(lines).toContain('last scanned the home folder on 2026-11-14');
    expect(lines).toContain('stopped early (time budget)');
    expect(lines).toContain('could not read ~/Documents/x');
    expect(lines).toContain('~/dev: 1 checkout, 2.0 GB of build output');
    expect(lines).toContain('~/.exact/exact2: 1 checkout, 80.0 GB of build output');
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
    expect(line).toBe(
      `Stim: checkouts it does not fully manage hold 82.0 GB of build output. Adding the largest folder, ~/dev (2.0 GB), lets Stim apply its full rules there, finished linked worktree removal included: stim settings set maintenance.discoverRoots '["/Users/me/dev"]' --scope machine; stim doctor lists the rest and what changes.`,
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
