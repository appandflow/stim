import type { DaemonStatus, DiskPacerVolume } from '@stim-cli/core/state';
import { diskPacerFindings } from '../diagnostics/doctor-gc-pacer.ts';

function current() {
  const now = Date.now();
  const episode = {
    since: now - 60 * 60_000,
    targetFreeMb: 6000,
    lastAttemptAt: now - 60_000,
    checkedAt: now,
    freeMb: 5000,
  };
  const volume: DiskPacerVolume = {
    device: 1,
    volume: '/builds',
    observedAt: now,
    freeMb: 5000,
    fillMbPerSecond: 1,
    firstFreeMs: 1000,
    predictive: episode,
  };
  const status: DaemonStatus = {
    mode: 'on',
    running: { pid: process.pid, since: new Date(now - 2 * 60 * 60_000).toISOString() },
    lastTickAt: new Date(now).toISOString(),
    intervalMs: 60_000,
    diskPacer: [volume],
  };
  return { now, status, volume, episode };
}

test('doctor identifies an hour of admitted predictive cleanup with current uncleared-target evidence', () => {
  const { now, status } = current();
  const findings = diskPacerFindings(status, now);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ level: 'cost', detail: expect.stringContaining('4.9 GB free') });
  expect(findings[0]?.title).toContain('/builds');
});

test.each([
  'before hour',
  'target cleared',
  'rate alone',
  'stopped',
  'report mode',
  'stale proof',
  'future proof',
  'flat rate',
] as const)('doctor does not infer a stalled predictive episode from %s', (reason) => {
  const { now, status, volume, episode } = current();
  if (reason === 'before hour') episode.since++;
  else if (reason === 'target cleared') episode.freeMb = episode.targetFreeMb;
  else if (reason === 'rate alone') delete volume.predictive;
  else if (reason === 'stopped') status.running = null;
  else if (reason === 'report mode') status.mode = 'report';
  else if (reason === 'stale proof') episode.checkedAt -= 120_001;
  else if (reason === 'future proof') episode.checkedAt++;
  else volume.fillMbPerSecond = 0;
  expect(diskPacerFindings(status, now)).toEqual([]);
});
