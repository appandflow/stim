import type { StatusPayload as ServerStatus } from '@stim-cli/core/state';
import { homeAttention, type AttentionMachine } from '../../../apps/mobile/src/lib/attention.ts';
import { localNotifications, PUSH_EVENTS, type NotifyState } from '../../../apps/mobile/src/lib/notifications.ts';
import fixture from '../../../apps/mobile/mock-server/fixtures/status.json' with { type: 'json' };
import type { StatusPayload as PhoneStatus } from '../../../apps/mobile/src/protocol/types.ts';
import { attentionCandidates } from '../src/attention.ts';
import { diffAttention, type NotifyEntries } from '../src/notify.ts';
import type { MachineVolume } from '../src/protocol.ts';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const NAME = 'MacBook Pro';
const base = fixture.payload as unknown as PhoneStatus;

type Env = PhoneStatus['environments'][number];

const failed = (platform: 'ios' | 'android', at: number) => ({
  platform,
  status: 'failed' as const,
  cacheHit: false as const,
  cacheSkipped: false,
  durationMs: 1000,
  fingerprint: null,
  startedAt: new Date(at).toISOString(),
  finishedAt: new Date(at).toISOString(),
  errorCode: 'STIM_BUILD_FAILED',
});

/** Changes every fixture workspace in turn: failures, log errors, stopped apps, long builds, a driven device. */
function step(index: number, now: number): PhoneStatus {
  const environments = base.environments.map((env, i): Env => {
    const phase = (index + i) % 6;
    const next: Env = { ...env };
    if (phase === 1) next.lastBuilds = { ...env.lastBuilds, ios: failed('ios', now - 1000) };
    if (phase === 2) next.logs = { dir: '/l', errorsSinceMarker: index + i };
    if (phase === 3 && env.ios) next.ios = { ...env.ios, state: 'Booted', app: { id: 'a', state: 'stopped' } };
    if (phase === 4) {
      next.build = {
        platform: 'android',
        slot: 'default',
        state: 'running',
        phase: 'compile',
        startedAt: new Date(now - 600_000).toISOString(),
        phaseStartedAt: new Date(now - 600_000).toISOString(),
        outcome: 'cold',
        expectedMs: 120_000,
        expectedPhaseMs: null,
        basis: 3,
      };
    }
    if (phase === 5 && env.ios) next.ios = { ...env.ios, activity: { state: 'driven', basis: [] } };
    return next;
  });
  return { ...base, environments };
}

const volumes = (index: number): MachineVolume[] => [
  { mount: '/', holds: [], freeBytes: (index % 4 === 3 ? 3 : 200) * 1e9, totalBytes: 1e12 },
];

function phone(status: PhoneStatus, index: number): AttentionMachine {
  return {
    id: 'mac',
    name: NAME,
    state: {
      kind: 'open',
      server: { name: NAME, version: '1', stim: '1' },
      actions: null,
      capabilities: [],
      deviceId: null,
    },
    missing: false,
    status,
    usage: {
      volumes: volumes(index),
      memory: { totalBytes: 1, usedBytes: null, pressure: null },
      load: { avg1: 0, avg5: 0, avg15: 0, cpus: 1 },
      sampledAt: '',
    },
    home: '/Users/dev',
    disconnectedAt: null,
    seenAt: null,
  };
}

describe("the server's copy of the phone's attention rules", () => {
  it('finds the same items as the phone for every status of a changing sequence', () => {
    for (let index = 0; index < 12; index++) {
      const now = T0 + index * 60_000;
      const status = step(index, now);
      const server = attentionCandidates(status as unknown as ServerStatus, volumes(index), NAME, now).map((c) => ({
        key: c.key,
        event: c.event,
        occurrence: c.occurrence,
        title: c.title,
        reason: c.reason,
        target: c.target.kind === 'machine' ? 'machine' : `${c.target.kind} ${c.target.path}`,
        driven: c.driven,
        count: c.count,
      }));
      const app = homeAttention([phone(status, index)], now)
        .filter((item) => item.event !== null && (PUSH_EVENTS as readonly string[]).includes(item.event))
        .map((item) => ({
          key: item.key.slice('mac\n'.length),
          event: item.event,
          occurrence: item.occurrence,
          title: item.title,
          reason: item.reason,
          target: item.target.kind === 'machine' ? 'machine' : `${item.target.kind} ${item.target.path}`,
          driven: item.driven,
          count: item.count,
        }));
      const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
      expect(server.toSorted(byKey)).toEqual(app.toSorted(byKey));
      expect(server.length).toBeGreaterThan(0);
    }
  });

  it('notifies the same problems at the same times as the phone', () => {
    const events = [...PUSH_EVENTS];
    let notified = 0;
    const withDevice = base.environments.filter((env) => env.ios);
    let entries: NotifyEntries | null = null;
    let state: NotifyState = {};
    for (let index = 0; index < 80; index++) {
      const now = T0 + index * 30_000 - (index % 2) * 15_000;
      const [rising, flapping, failing, slow] = withDevice.map((env) => {
        const copy = structuredClone(env);
        copy.live = true;
        return copy;
      });
      rising!.logs = { dir: '/l', errorsSinceMarker: index % 40 < 30 ? Math.floor(index / 2) * 3 : 0 };
      if (index % 7 === 0 || index % 5 === 0)
        flapping!.ios = { ...flapping!.ios!, state: 'Booted', app: { id: 'a', state: 'stopped' } };
      failing!.lastBuilds = { ios: failed('ios', T0 + Math.floor(index / 9) * 270_000) };
      if (index >= 10 && index < 20) {
        slow!.build = {
          platform: 'ios',
          slot: 'default',
          state: 'running',
          phase: 'compile',
          startedAt: new Date(T0 + 300_000).toISOString(),
          phaseStartedAt: new Date(T0 + 300_000).toISOString(),
          outcome: 'cold',
          expectedMs: 60_000,
          expectedPhaseMs: null,
          basis: 3,
        };
      }
      const status: PhoneStatus = { ...base, environments: [rising!, flapping!, failing!, slow!] };
      const disk = [
        { mount: '/', holds: [], freeBytes: (index % 11 === 3 || index % 11 === 4 ? 3 : 200) * 1e9, totalBytes: 1e12 },
      ];
      const agentOnly = index > 60;
      const server = diffAttention(
        entries,
        attentionCandidates(status as unknown as ServerStatus, disk, NAME, now),
        { events, agentOnly },
        now,
      );
      entries = server.entries;
      const machine = phone(status, 0);
      const app = localNotifications(
        state,
        homeAttention([{ ...machine, usage: { ...machine.usage!, volumes: disk } }], now),
        [{ id: 'mac', live: true, pushed: false }],
        { enabled: true, events, agentOnly },
        now,
        0,
      );
      state = app.state;
      const pushed =
        server.notify.length > 3
          ? [`${server.notify.length} problems`]
          : server.notify.map((c) => `${c.title}: ${c.reason}`);
      const shown =
        app.notifications[0]?.data.target === 'home'
          ? [app.notifications[0].body.replace(' need attention', '')]
          : app.notifications.map((n) => `${n.title}: ${n.body}`);
      expect(pushed).toEqual(shown);
      notified += pushed.length;
    }
    expect(notified).toBeGreaterThan(10);
  });
});
