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
  provenOurs,
  recordIdentities,
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
    expect(parseVmStat(VM_STAT)).toMatchObject({
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

const RECORDED = Date.parse('Mon Nov  2 15:00:30 2026');
const recordedAt = (pids) => new Map(pids.map((pid) => [pid, RECORDED]));
const row = (pid, ppid, rss, lstart, cmd) => `${pid} ${ppid} ${rss} ${lstart} ${cmd}`;

describe('stim process attribution', () => {
  const home = '/h/rme1-home';
  const scope = { home, worktreePrefix: '/w/rme1' };
  const START = 'Mon Nov  2 15:00:00 2026';
  const LATER = 'Mon Nov  2 16:30:00 2026';
  const sinceMs = Date.parse('Mon Nov  2 14:59:00 2026');
  const ps = parsePs(
    [
      row(100, 1, 20480, START, 'stimd    '),
      row(101, 100, 262144, START, 'node /w/rme1-01/node_modules/expo/bin/cli start'),
      row(200, 1, 20480, START, 'stimd    '),
      row(201, 200, 262144, START, 'node /w/other-01/node_modules/expo/bin/cli start'),
      row(300, 1, 4096, START, 'xcodebuild -derivedDataPath /h/rme1-home/workspaces/x/derived-data build'),
      row(301, 1, 4096, START, 'xcodebuild -derivedDataPath /elsewhere/derived-data build'),
    ].join('\n'),
  );

  it("counts only the run's own stimd, Metro and xcodebuild", () => {
    const identities = new Map();
    recordIdentities(identities, ps, recordedAt([100]), scope, sinceMs);
    const totals = classifyStimProcesses(ps, { identities, ...scope });
    expect(totals.stimd.n).toBe(1);
    expect(totals.metro.n).toBe(1);
    expect(totals.xcodebuild.n).toBe(1);
    expect(totals.metro.rssMb).toBe(256);
  });

  it("does not treat a recorded pid as the run's once another process holds it", () => {
    const identities = new Map([[100, START]]);
    const reused = parsePs(
      [
        row(100, 1, 20480, LATER, 'stimd'),
        row(101, 100, 9000, LATER, 'xcodebuild -project Other.xcodeproj build'),
      ].join('\n'),
    );
    expect(provenOurs(reused, identities, scope)).toEqual([]);
    const totals = classifyStimProcesses(reused, { identities, ...scope });
    expect(totals.stimd.n + totals.xcodebuild.n).toBe(0);
  });

  it('does not record a pid that is not a stim process of the run, or that started before the run', () => {
    const rows = parsePs(
      [row(500, 1, 2048, START, '/bin/zsh -l'), row(600, 1, 2048, 'Mon Nov  2 09:00:00 2026', 'stimd')].join('\n'),
    );
    const identities = new Map();
    recordIdentities(identities, rows, recordedAt([500, 600]), scope, sinceMs);
    expect(identities.size).toBe(0);
  });

  it('does not adopt a process that started after the pid was recorded', () => {
    const adopted = parsePs(row(700, 1, 20480, LATER, 'stimd'));
    const identities = new Map();
    recordIdentities(identities, adopted, recordedAt([700]), scope, sinceMs);
    expect(identities.size).toBe(0);
    expect(provenOurs(adopted, identities, scope)).toEqual([]);
  });

  it('reads process start times independent of the machine locale only when ps prints them in the C format', () => {
    expect(parsePs(row(7, 1, 1024, START, 'stimd'))[0]).toMatchObject({
      pid: 7,
      lstart: START,
    });
    expect(parsePs('8 1 1024 lun.  2 nov. 16:52:03 2026 stimd')[0].lstart).toBeNull();
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
