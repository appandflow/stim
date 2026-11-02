import { describe, expect, it } from 'vitest';
import {
  SAMPLE_COLUMNS,
  classifyStimProcesses,
  csvLine,
  parseCsv,
  parseLoad1,
  parsePs,
  parseSimctlDevices,
  parseSwapUsedMb,
  parseVmStat,
} from './platform.mjs';
import { parseDf, mismatchedVolumes } from './volumes.mjs';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5121.
Pages active:                                 640143.
Pages inactive:                               636792.
Pages wired down:                             481648.
Pages occupied by compressor:                1298566.
`;

describe('host measurements', () => {
  it('reads the page size from vm_stat instead of assuming one', () => {
    expect(parseVmStat(VM_STAT)).toEqual({
      pageBytes: 16384,
      free: 5121,
      active: 640143,
      wired: 481648,
      compressed: 1298566,
    });
  });

  it('reads swap in megabytes whichever unit macOS prints', () => {
    expect(parseSwapUsedMb('total = 27648.00M  used = 26671.56M  free = 976.44M  (encrypted)')).toBe(26672);
    expect(parseSwapUsedMb('total = 4.00G  used = 1.50G  free = 2.50G')).toBe(1536);
    expect(parseLoad1('{ 20.26 33.99 29.21 }')).toBe(20.26);
  });

  it('flattens simctl devices across runtimes', () => {
    const json = JSON.stringify({
      devices: {
        a: [{ udid: 'U1', name: 'one', state: 'Booted' }],
        b: [{ udid: 'U2', name: 'two', state: 'Shutdown' }],
      },
    });
    expect(parseSimctlDevices(json).map((d) => d.udid)).toEqual(['U1', 'U2']);
    expect(parseSimctlDevices('not json')).toBeNull();
  });

  it('round-trips a sample row through the CSV the report reads', () => {
    const row = {
      ts: '2026-11-02T00:00:00.000Z',
      epoch: 1,
      stage: 'idle-wait',
      load1: 3.5,
      pressure: 2,
      booted_ours: 4,
    };
    const [parsed] = parseCsv(`${SAMPLE_COLUMNS.join(',')}\n${csvLine(row)}\n`);
    expect(parsed).toMatchObject({ epoch: 1, stage: 'idle-wait', load1: 3.5, booted_ours: 4, home_free_mb: null });
  });
});

describe('stim process attribution', () => {
  const home = '/h/rme1-home';
  const worktreePrefix = '/w/rme1';
  const ps = parsePs(
    [
      '100 1 20480 stim-supervisor',
      '101 100 262144 node /w/rme1-01/node_modules/expo/bin/cli start',
      '200 1 20480 stim-supervisor',
      '201 200 262144 node /w/other-01/node_modules/expo/bin/cli start',
      '300 1 4096 xcodebuild -derivedDataPath /h/rme1-home/workspaces/x/derived-data build',
      '301 1 4096 xcodebuild -derivedDataPath /elsewhere/derived-data build',
      '400 1 2048 stim-collector',
    ].join('\n'),
  );

  it("counts only the run's own supervisors, Metro, xcodebuild and collectors", () => {
    const totals = classifyStimProcesses(ps, { ownPids: new Set([100, 400]), home, worktreePrefix });
    expect(totals.supervisor.n).toBe(1);
    expect(totals.metro.n).toBe(1);
    expect(totals.xcodebuild.n).toBe(1);
    expect(totals.collector.n).toBe(1);
    expect(totals.metro.rssMb).toBe(256);
  });
});

describe('volumes', () => {
  it('parses the mount point even when it contains spaces', () => {
    expect(
      parseDf(
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s1 1000 400 600 40% /Volumes/Fast SSD',
      ),
    ).toEqual({ device: '/dev/disk4s1', freeMb: 1, mount: '/Volumes/Fast SSD' });
  });

  it('names the volumes whose device differs from the first', () => {
    expect(mismatchedVolumes({ project: { dev: 1 }, home: { dev: 1 }, work: { dev: 2 }, ballast: { dev: 1 } })).toEqual(
      ['work'],
    );
  });
});
