import fixture from '../../mock-server/fixtures/status.json';

import { homeAttention, type AttentionMachine } from '@/lib/attention';
import type { ConnectionState } from '@/lib/connection';
import type { BuildReport, EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const OPEN: ConnectionState = {
  kind: 'open',
  server: { name: 'm', version: '1', stim: '1' },
  actions: null,
  capabilities: [],
  deviceId: null,
};
const payload = fixture.payload as StatusPayload;

const env = (name: string, extra: Partial<EnvironmentState> = {}): EnvironmentState => ({
  path: `/u/app/.worktrees/${name}`,
  live: false,
  memoryMb: 0,
  warnings: [],
  issues: [],
  ...extra,
});

const usage = (freeGb: number): MachineUsage => ({
  volumes: [{ mount: '/', holds: [], freeBytes: freeGb * 1e9, totalBytes: 1e12 }],
  memory: { totalBytes: 1, usedBytes: null, pressure: null },
  load: { avg1: 0, avg5: 0, avg15: 0, cpus: 1 },
  sampledAt: '',
});

const mac = (environments: EnvironmentState[], extra: Partial<AttentionMachine> = {}): AttentionMachine => ({
  id: 'a',
  name: 'MacBook Pro',
  state: OPEN,
  missing: false,
  status: { ...payload, environments, unprovisionedWorktrees: [] },
  usage: usage(200),
  home: '/u',
  disconnectedAt: null,
  seenAt: null,
  ...extra,
});

const running = (startedMsAgo: number, expectedMs: number | null): BuildReport => ({
  platform: 'ios',
  slot: 'default',
  state: 'running',
  phase: 'compile',
  startedAt: new Date(NOW - startedMsAgo).toISOString(),
  phaseStartedAt: new Date(NOW - startedMsAgo).toISOString(),
  outcome: 'cold',
  expectedMs,
  expectedPhaseMs: null,
  basis: 4,
});

const summary = (machines: AttentionMachine[]) =>
  homeAttention(machines, NOW).map((i) => `${i.severity} ${i.title}: ${i.detail} -> ${i.target.kind}`);

const booted = (state: 'running' | 'stopped' | 'unknown') => ({
  name: 'stim-x (iPhone 18 Pro 27.0)',
  udid: 'U',
  owned: true,
  state: 'Booted',
  app: { id: 'com.app', state },
});

describe('homeAttention', () => {
  it('is empty when nothing is wrong', () => {
    expect(summary([mac([env('fine', { live: true, ios: booted('running') })])])).toEqual([]);
  });

  const failedBuild = (msAgo: number) => ({
    ios: {
      platform: 'ios' as const,
      status: 'failed' as const,
      cacheHit: false as const,
      cacheSkipped: false,
      durationMs: 1000,
      fingerprint: null,
      startedAt: new Date(NOW - msAgo).toISOString(),
      finishedAt: new Date(NOW - msAgo).toISOString(),
      errorCode: 'STIM_BUILD_FAILED',
    },
  });

  it('lists failed builds and log errors, linking errors to the logs', () => {
    expect(
      summary([
        mac([
          env('broken', { lastBuilds: failedBuild(3_600_000) }),
          env('bundle', { live: true, logs: { dir: '/l', errorsSinceMarker: 2 } }),
        ]),
      ]),
    ).toEqual([
      'error bundle: 2 errors in the logs -> logs',
      'error broken: iOS build failed (STIM_BUILD_FAILED) \u00B7 1h ago -> workspace',
    ]);
  });

  it('leaves out log errors and day-old failed builds of idle workspaces', () => {
    expect(
      summary([
        mac([env('abandoned', { lastBuilds: failedBuild(2 * 86_400_000), logs: { dir: '/l', errorsSinceMarker: 3 } })]),
      ]),
    ).toEqual([]);
    expect(
      summary([
        mac([
          env('building', {
            build: running(10_000, null),
            lastBuilds: { android: { ...failedBuild(2 * 86_400_000).ios, platform: 'android' } },
          }),
        ]),
      ]),
    ).toEqual(['error building: Android build failed (STIM_BUILD_FAILED) \u00B7 2d ago -> workspace']);
  });

  it('drops a failed build while the same platform builds again', () => {
    const failed = {
      platform: 'ios' as const,
      status: 'failed' as const,
      cacheHit: false as const,
      cacheSkipped: false,
      durationMs: null,
      fingerprint: null,
      startedAt: new Date(NOW).toISOString(),
      finishedAt: null,
    };
    expect(summary([mac([env('retry', { build: running(60_000, null), lastBuilds: { ios: failed } })])])).toEqual([]);
  });

  it('keeps error issues from idle workspaces but their warnings only from active ones', () => {
    const issue = (severity: 'error' | 'warning', message: string, workspace: string) => ({
      code: 'port-not-ours',
      severity,
      message,
      remedy: 'stim start',
      workspace,
    });
    expect(
      summary([
        mac([
          env('idle', {
            issues: [
              issue('error', 'port 8082: pid 1 runs from /u/other', '/u/app/.worktrees/idle'),
              issue('warning', 'recorded sim X no longer exists', '/u/app/.worktrees/idle'),
            ],
          }),
          env('live', { live: true, issues: [issue('warning', 'simulator is booted with no Metro', '/x')] }),
        ]),
      ]),
    ).toEqual([
      'error idle: port 8082: pid 1 runs from ~/other -> workspace',
      'warning live: simulator is booted with no Metro -> workspace',
    ]);
  });

  it('flags a build at more than twice its median, not one merely over it', () => {
    expect(summary([mac([env('slow', { build: running(7 * 60_000, 3 * 60_000) })])])).toEqual([
      'warning slow: iOS build at 7:00, usually ~3:00 -> workspace',
    ]);
    expect(summary([mac([env('late', { build: running(5 * 60_000, 3 * 60_000) })])])).toEqual([]);
    expect(summary([mac([env('unknown', { build: running(60 * 60_000, null) })])])).toEqual([]);
  });

  it('flags a live device whose app stopped, except while a build installs it', () => {
    expect(summary([mac([env('crashed', { live: true, ios: booted('stopped') })])])).toEqual([
      'warning crashed: App not running on iPhone 18 Pro 27.0 -> workspace',
    ]);
    expect(
      summary([mac([env('installing', { live: true, ios: booted('stopped'), build: running(10_000, null) })])]),
    ).toEqual([]);
    expect(summary([mac([env('unsure', { live: true, ios: booted('unknown') })])])).toEqual([]);
  });

  it('flags disk below the critical floor on the machine', () => {
    expect(summary([mac([], { usage: usage(3.2) })])).toEqual([
      "error MacBook Pro: 3.2 GB free, below Stim's floor -> machine",
    ]);
    expect(summary([mac([], { usage: usage(12) })])).toEqual([]);
  });

  it('shows only the offline item for a disconnected machine, since its status is stale', () => {
    const stale = mac([env('bundle', { live: true, logs: { dir: '/l', errorsSinceMarker: 2 } })], {
      state: { kind: 'waiting', retryInMs: 30_000, reason: 'Closed.' },
      disconnectedAt: NOW - 5 * 60_000,
      usage: usage(1),
    });
    expect(summary([stale])).toEqual(['warning MacBook Pro: Offline \u00B7 last seen 5m ago -> machine']);
    expect(summary([{ ...stale, state: { kind: 'connecting' } }])).toHaveLength(1);
    expect(summary([{ ...stale, state: { kind: 'connecting' }, disconnectedAt: null, status: null }])).toEqual([]);
    expect(summary([{ ...stale, state: { kind: 'refused', code: 'unauthorized', reason: 'No.' } }])).toEqual([
      'error MacBook Pro: Refused the connection: pair again -> machine',
    ]);
    expect(summary([{ ...stale, state: { kind: 'refused', code: 'protocol-unsupported', reason: 'No.' } }])).toEqual([
      'error MacBook Pro: Refused the connection: needs an update -> machine',
    ]);
    expect(summary([{ ...stale, missing: true, state: { kind: 'closed' }, status: null }])).toEqual([
      'error MacBook Pro: Not paired: pair again -> machine',
    ]);
  });

  it('ranks errors first, then machine problems, then active workspaces before idle ones', () => {
    const errors = { dir: '/l', errorsSinceMarker: 1 };
    const titles = homeAttention(
      [
        mac(
          [
            env('idle-error', { lastBuilds: failedBuild(60_000) }),
            env('live-warning', { live: true, ios: booted('stopped') }),
            env('live-error', { live: true, logs: errors }),
          ],
          { usage: usage(2) },
        ),
        {
          ...mac([]),
          id: 'b',
          name: 'Mac mini',
          state: { kind: 'waiting', retryInMs: 1000, reason: 'Closed.' },
          disconnectedAt: NOW,
        },
      ],
      NOW,
    ).map((i) => i.title);
    expect(titles).toEqual(['MacBook Pro', 'live-error', 'idle-error', 'Mac mini', 'live-warning']);
  });
});
