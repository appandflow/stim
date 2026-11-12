import type { BuildLedgerRecord } from '@stim-cli/core/state';
import { DEFAULT_BUILD_GB, estimateBuildBytes, headroomShortfall } from '../engine/build-headroom.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function record(overrides: Partial<BuildLedgerRecord> & { gb?: number }): BuildLedgerRecord {
  const { gb, ...rest } = overrides;
  return {
    ts: NOW - DAY,
    src: 'builds',
    level: 'info',
    msg: '',
    event: 'build',
    id: `id-${Math.random()}`,
    startedAt: NOW - DAY,
    project: '/work/app',
    projectKey: '/repo/app',
    workspace: 'app',
    branch: null,
    platform: 'ios',
    configuration: 'Debug',
    placement: { where: 'local' },
    cache: { result: 'miss', key: null, fingerprint: null },
    durationMs: 1,
    phases: {},
    outcome: 'succeeded',
    stimVersion: '1',
    ...(gb === undefined ? {} : { bytesWritten: gb * GB }),
    ...rest,
  };
}

const ask = (records: BuildLedgerRecord[]) =>
  estimateBuildBytes({ records, projectKey: '/repo/app', platform: 'ios', type: 'expo', now: NOW });

describe('estimateBuildBytes', () => {
  it('takes the largest figure of the same project and platform, ignoring hits, failures, other platforms and old builds', () => {
    const estimate = ask([
      record({ gb: 3 }),
      record({ gb: 9 }),
      record({ gb: 40, cache: { result: 'hit', key: null, fingerprint: null } }),
      record({ gb: 40, outcome: 'failed' }),
      record({ gb: 40, platform: 'android' }),
      record({ gb: 40, projectKey: '/repo/other' }),
      record({ gb: 40, ts: NOW - 31 * DAY }),
    ]);
    expect(estimate).toEqual({ bytes: 9 * GB, source: 'history' });
  });

  it('uses the default of the project type when the project has no measured build', () => {
    expect(ask([record({})])).toEqual({ bytes: (DEFAULT_BUILD_GB.expo.ios ?? 0) * GB, source: 'default' });
  });
});

describe('headroomShortfall', () => {
  it('is the bytes missing for the estimate plus the critical floor, and zero when the volume has room', () => {
    expect(headroomShortfall({ freeBytes: 20 * GB, estimateBytes: 18 * GB, criticalBytes: 6 * GB })).toBe(4 * GB);
    expect(headroomShortfall({ freeBytes: 30 * GB, estimateBytes: 18 * GB, criticalBytes: 6 * GB })).toBe(0);
  });
});
