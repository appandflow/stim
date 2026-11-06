import { filterRecords, shiftTimestamps, usageHistory } from './payloads.mjs';

/** @typedef {{ result: unknown } | { error: [string, string] } | { deferred: true }} Outcome */

const ACTIONS = ['reload', 'stop'];
const GB = 1e9;
const HISTORY_INTERVAL_MS = 5000;

/**
 * Shared phone RPCs for the captured mock and App Review demo. The machine supplies its data and policy;
 * the connection owns transport, subscription lifetimes and scheduling of initial events.
 * @returns {Record<string, (params: Record<string, unknown>, id?: unknown) => Outcome> & { hello: () => Outcome }}
 */
export function createFakeHandlers(machine, connection) {
  const { fixtures } = machine;
  const { send, every, later, active, stop } = connection;
  const location = machine.kind === 'mock' ? 'this machine' : 'this Mac';
  const stream = (method, event) => {
    let seq = 0;
    const tick = (subscription) => {
      const payload = machine.status();
      send({ subscription, ...event(machine.statusViews(payload), seq++, payload) });
    };
    const subscription = every(method, 5000, tick);
    later(() => active(subscription) && tick(subscription));
    return { result: { subscription } };
  };
  return {
    hello() {
      const { server, hostCapabilities, features, device } = machine.hello;
      return {
        result: {
          protocol: 2,
          phoneApi: 2,
          host: { owner: 'service', capabilities: hostCapabilities, app: null },
          server,
          capabilities: machine.readOnly ? ['read'] : ['read', 'control'],
          features,
          actions: machine.readOnly ? [] : ACTIONS,
          device,
        },
      };
    },
    'workspaces.subscribe'() {
      return stream('workspaces.subscribe', (views, seq) => ({
        event: 'workspaces',
        seq,
        snapshot: { workspaces: views.workspaces, worktrees: views.worktrees, archived: views.archived },
      }));
    },
    'workspace.subscribe'(params) {
      if (!fixtures.status.environments.some((env) => env.path === params.workspace))
        return { error: ['unknown-workspace', `${params.workspace} is not a Stim workspace on ${location}.`] };
      return stream('workspace.subscribe', (views, seq) => ({
        event: 'workspace',
        seq,
        environment: views.details.get(params.workspace) ?? null,
      }));
    },
    'machine.subscribe'() {
      return stream('machine.subscribe', (views, seq, payload) => ({
        event: 'machine',
        seq,
        machine: views.machine,
        usage: usageHistory(payload.machine?.owners ?? [], Date.now()),
      }));
    },
    'archived.list'() {
      const payload = machine.status();
      const archived = payload.archived ?? [];
      const usage = payload.archivedUsage ?? {
        count: archived.length,
        bytes: archived.reduce((sum, archive) => sum + archive.bytes.total, 0),
        byKind: Object.fromEntries(
          ['logs', 'recordings', 'agentActions', 'record'].map((kind) => [
            kind,
            archived.reduce((sum, archive) => sum + archive.bytes[kind], 0),
          ]),
        ),
      };
      return { result: { archived, usage, next: null } };
    },
    'logs.query'(params) {
      return { result: { records: filterRecords(machine.logsFor(params), params) } };
    },
    'logs.subscribe'(params) {
      const logs = machine.logsFor(params);
      let cursor = 0;
      const subscription = every('logs.subscribe', 2000, (id) => {
        if (!logs.length) return;
        const record = { ...logs[cursor++ % logs.length], ts: Date.now() };
        const records = filterRecords([record], { ...params, tail: undefined });
        if (records.length > 0) send({ event: 'logs', subscription: id, records });
      });
      later(
        () =>
          (machine.kind === 'mock' || active(subscription)) &&
          send({ event: 'logs', subscription, records: filterRecords(logs, params) }),
      );
      return { result: { subscription } };
    },
    'workspace.files'(params) {
      return { result: { files: machine.changedFiles(params.group), truncated: false } };
    },
    'workspace.diff'(params) {
      return { result: { path: params.path, patches: machine.diffPatches(params.path) } };
    },
    'stats.get'() {
      return { error: ['not-implemented', `The ${machine.kind} server does not serve stats.`] };
    },
    'build.plan'(params) {
      const plan = fixtures.plans[params.platform];
      if (!plan)
        return {
          error: [
            'stim-failed',
            `The ${machine.kind} server has no ${params.platform} ${machine.kind === 'mock' ? 'plan fixture' : 'build plan'}.`,
          ],
        };
      return { result: { ...plan, ...(params.slot && params.slot !== 'default' ? { slot: params.slot } : {}) } };
    },
    'settings.get'() {
      return {
        result: {
          project: null,
          files: {},
          settings: [{ key: 'recording.enabled', value: machine.recordingEnabled, origin: 'machine', layers: {} }],
          unknown: [],
        },
      };
    },
    'frames.keyframe'() {
      return { result: {} };
    },
    'recording.set'(params) {
      if (machine.readOnly)
        return { error: ['forbidden', 'This device can only read (mock server started with --read).'] };
      machine.recordingEnabled = params.enabled === true;
      return { result: { enabled: machine.recordingEnabled, recordingsDeleted: [] } };
    },
    action(params, id) {
      if (machine.readOnly)
        return { error: ['forbidden', 'This device can only read (mock server started with --read).'] };
      if (!ACTIONS.includes(params.action)) return { error: ['unknown-action', `Unknown action ${params.action}.`] };
      const platformOk =
        params.platform === undefined ||
        (params.action === 'reload' && ['ios', 'android', 'web'].includes(params.platform));
      if (!platformOk) return { error: ['bad-request', 'platform must be ios, android or web, and only for reload.'] };
      const env = fixtures.status.environments.find((candidate) => candidate.path === params.workspace);
      if (!env) return { error: ['unknown-workspace', `${params.workspace} is not a Stim workspace on ${location}.`] };
      const slots = [env, ...(env.slots ?? [])];
      const both =
        slots.some((slot) => slot.ios?.state === 'Booted') && slots.some((slot) => slot.android?.state === 'detected');
      if (params.action === 'reload' && params.platform === undefined && both) {
        return {
          error: [
            'action-failed',
            'STIM_RELOAD_AMBIGUOUS: Both the iOS and Android apps are running. Choose one with `stim reload ios` or `stim reload android`.',
          ],
        };
      }
      if (machine.busy.has(params.workspace))
        return { error: ['action-busy', `An action is already running in ${params.workspace}.`] };
      machine.busy.add(params.workspace);
      machine.onAction?.(params);
      setTimeout(() => {
        machine.busy.delete(params.workspace);
        send({ id, result: { action: params.action, workspace: params.workspace, output: { [machine.kind]: true } } });
      }, 800);
      return { deferred: true };
    },
    'machine.get'() {
      return {
        result: {
          volumes: [
            {
              mount: '/',
              holds: ['Workspaces', 'Stim home', 'Simulators'],
              freeBytes: machine.freeGb() * GB,
              totalBytes: 994.66 * GB,
            },
          ],
          memory: {
            totalBytes: fixtures.status.capacity.totalMemoryMb * 1024 * 1024,
            usedBytes: 31.4 * 2 ** 30,
            pressure: 'normal',
          },
          load: { avg1: 6.2, avg5: 5.4, avg15: 4.9, cpus: 14 },
          cpu: { usage: 0.34, cores: 14 },
          sampledAt: new Date().toISOString(),
        },
      };
    },
    'machine.details'() {
      return { result: shiftTimestamps(fixtures.machineDetails, machine.shiftMs) };
    },
    'machine.history'(params) {
      const sinceMs = typeof params.sinceMs === 'number' ? params.sinceMs : -Infinity;
      const end = Math.floor(Date.now() / HISTORY_INTERVAL_MS) * HISTORY_INTERVAL_MS;
      const samples = [];
      for (let at = end - 719 * HISTORY_INTERVAL_MS; at <= end; at += HISTORY_INTERVAL_MS) {
        if (at <= sinceMs) continue;
        const phase = at / 600_000;
        samples.push({
          at,
          cpu: 0.3 + 0.25 * Math.sin(phase * 2 * Math.PI) ** 2,
          memoryUsedBytes: (29 + 3 * Math.sin(phase)) * 2 ** 30,
          memoryPressure: 0,
          diskFreeBytes: machine.historyFreeGb * GB,
        });
      }
      return { result: { intervalMs: HISTORY_INTERVAL_MS, samples } };
    },
    'notifications.list'(params) {
      machine.onNotifications?.(send);
      const since = params.since ?? 0;
      return {
        result: {
          log: machine.notificationLog,
          cursor: machine.notifications[0]?.seq,
          notifications: machine.notifications.filter((entry) => entry.seq > since),
        },
      };
    },
    unsubscribe(params) {
      stop(params.subscription);
      return { result: {} };
    },
  };
}
