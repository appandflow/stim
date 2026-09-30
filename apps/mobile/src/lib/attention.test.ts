import fixture from '../../mock-server/fixtures/status.json';

import { homeAttention, type AttentionMachine } from '@/lib/attention';
import type { ConnectionState } from '@/lib/connection';
import type { EnvironmentState, MachineUsage, StatusPayload } from '@/protocol/types';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const OPEN: ConnectionState = {
  kind: 'open',
  protocol: 1,
  server: { name: 'm', version: '1', stim: '1' },
  actions: null,
  capabilities: [],
  features: [],
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

const summary = (machines: AttentionMachine[]) =>
  homeAttention(machines, NOW, 15).map((i) => `${i.severity} ${i.title}: ${i.detail} -> ${i.target.kind}`);

const failedBuild = (errorCode: string) => ({
  platform: 'ios' as const,
  status: 'failed' as const,
  cacheHit: false as const,
  cacheSkipped: false,
  durationMs: 1000,
  fingerprint: null,
  startedAt: new Date(NOW - 60_000).toISOString(),
  finishedAt: new Date(NOW - 60_000).toISOString(),
  errorCode,
});

describe('homeAttention', () => {
  it('leaves out what agents handle: log errors and a single failed build', () => {
    expect(
      summary([
        mac([
          env('broken', { lastBuilds: { ios: failedBuild('STIM_BUILD_FAILED') } }),
          env('bundle', { live: true, logs: { dir: '/l', errorsSinceMarker: 2 } }),
        ]),
      ]),
    ).toEqual([]);
  });

  it("titles a workspace item by its workspace and a machine item by the Mac, with the Mac's home as ~", () => {
    const issue = {
      code: 'port-not-ours' as const,
      severity: 'warning' as const,
      message: 'port 8082 is in use by pid 1 in /u/other',
      remedy: 'stim stop',
      workspace: '/u/app/.worktrees/held',
    };
    expect(summary([mac([env('held', { live: true, issues: [issue] })], { usage: usage(3.2) })])).toEqual([
      "error MacBook Pro: 3.2 GB free, below Stim's floor -> machine",
      'warning held: port 8082 is in use by pid 1 in ~/other -> workspace',
    ]);
  });

  it('shows only the offline item for a disconnected machine, since its status is stale', () => {
    const stale = mac([env('sign', { lastBuilds: { ios: failedBuild('STIM_CODESIGN_FAILED') } })], {
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

  it('ranks errors first, then machine problems, then live workspaces before idle ones, across Macs', () => {
    const lease = (expiresAt: string) => [
      {
        platform: 'android' as const,
        slot: 'default',
        id: 'X',
        name: 'Pixel',
        model: null,
        owned: false as const,
        physical: true as const,
        connection: 'connected' as const,
        lease: { holder: 'h', kind: 'declared' as const, grantedAt: null, expiresAt },
      },
    ];
    const expired = new Date(NOW - 60_000).toISOString();
    const titles = homeAttention(
      [
        mac(
          [
            env('idle-error', { lastBuilds: { ios: failedBuild('STIM_NO_PROFILE') } }),
            env('live-warning', { live: true, physicalDevices: lease(expired) }),
            env('live-error', { live: true, lastBuilds: { ios: failedBuild('STIM_CODESIGN_FAILED') } }),
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
      15,
    ).map((i) => i.title);
    expect(titles).toEqual(['MacBook Pro', 'live-error', 'idle-error', 'Mac mini', 'live-warning']);
  });
});
