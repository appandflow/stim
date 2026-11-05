import { readFileSync } from 'node:fs';
import {
  receiveStatus,
  workspaceEnumPaths,
  resultEnumCases,
  eventEnumCases,
  archivedLogsEnded,
  replaceReceivedField,
} from '../../../apps/mobile/mock-server/receive-fixtures.ts';
import type { StatusPayload } from '../phone-protocol.ts';
import { statusViews } from '../state/status-views.ts';
import { isRpcError, isRpcEvent, isRpcResult, rpcEventIssue, rpcResultIssue } from '../receive-protocol.ts';

const hello = { protocol: 1, server: { name: 'Mac', version: '1', stim: '1' }, capabilities: ['read'] };

test.each([
  { event: 'desktop-run-progress', subscription: 'private', stream: 'stderr', message: 'Building' },
  { event: 'desktop-run-ended', subscription: 'private', exitCode: 0, stdout: '{}', message: 'Finished' },
  { event: 'desktop-build-progress', subscription: 'private', stream: 'stderr', message: 'Building' },
  { event: 'desktop-build-ended', subscription: 'private', exitCode: 0, stdout: '{}', message: 'Finished' },
])('does not expose private Desktop platform events to the phone: $event', (event) => {
  expect(isRpcEvent(event)).toBe(false);
});

test('checks Android runtime fields in a captured workspace', () => {
  const { payload } = JSON.parse(
    readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
  );
  const environment = payload.environments.find((entry: { android?: unknown }) => entry.android);
  const event = { event: 'workspace', subscription: 's', seq: 0, environment };
  expect(isRpcEvent(event)).toBe(true);
  for (const state of ['detected', 'not-detected', 'missing', 'unknown']) {
    environment.android.state = state;
    expect(isRpcEvent(event)).toBe(true);
  }
  for (const state of [{}, 1]) {
    environment.android.state = state;
    expect(isRpcEvent(event)).toBe(false);
  }
  environment.android.state = 'detected';
  environment.android.owned = 'true';
  expect(isRpcEvent(event)).toBe(false);
});

test('accepts future device idle shutdown reasons without disconnecting the phone', () => {
  const payload = receiveStatus(captured);
  const environment = payload.environments.find((entry) => entry.ios);
  if (!environment?.ios) throw new Error('fixture needs an iOS device');
  const idleShutdown = { at: '2026-10-07T12:00:00Z', idleMinutes: 10 };
  for (const reason of [undefined, 'reclaimed for a waiting run', 'future-reason']) {
    environment.ios.idleShutdown = { ...idleShutdown, ...(reason ? { reason } : {}) };
    expect(isRpcEvent({ event: 'workspace', subscription: 's', seq: 0, environment })).toBe(true);
  }
  expect(
    isRpcEvent({
      event: 'workspace',
      subscription: 's',
      seq: 0,
      environment: replaceReceivedField(environment, 'ios.idleShutdown.reason', 1),
    }),
  ).toBe(false);
});

test('accepts future maintenance modes and nonzero outcomes without disconnecting the phone', () => {
  const payload = receiveStatus(captured);
  const maintenance = {
    mode: 'on',
    lastChecks: { pressure: 1, size: 1 },
    pressure: {
      disk: [],
      memory: { level: 'future-level', availableBytes: null, pressured: true },
      warningSince: null,
    },
    lastPass: {
      startedAt: 1,
      durationMs: 2,
      trigger: 'status',
      mode: 'on',
      freedBytes: 5,
      actions: 1,
      stopped: 1,
      blocked: [],
    },
    running: null,
    plan: [{ kind: 'future-action', target: '/cache', bytes: 5, reason: 'future policy' }],
    sizes: [{ name: 'future cache', dir: '/cache', bytes: 5, measuredAt: 1, category: 'future-category' }],
    recent: [
      {
        ts: 1,
        src: 'maintenance',
        level: 'future-level',
        msg: 'future record',
        event: 'future-event',
        pass: 'p',
        trigger: 'status',
        mode: 'on',
      },
    ],
  };
  const { machine } = statusViews(JSON.parse(JSON.stringify(payload)));
  const event = { event: 'machine', subscription: 's', seq: 0, machine: { ...machine, maintenance } };
  expect(isRpcEvent(event)).toBe(true);
  const { sizes: _sizes, recent: _recent, ...compact } = maintenance;
  expect(isRpcEvent({ ...event, machine: { ...machine, maintenance: compact } })).toBe(true);
  expect(
    isRpcEvent({
      ...event,
      machine: { ...machine, maintenance: { ...maintenance, lastPass: { ...maintenance.lastPass, freedBytes: '5' } } },
    }),
  ).toBe(false);
});

test('accepts a machine event with a maintenance status, as stim-server sends it with maintenance off', () => {
  const maintenance = {
    mode: 'off',
    lastChecks: { pressure: null, size: null, worktree: null, sweep: null },
    pressure: null,
    lastPass: null,
    running: null,
    plan: [],
    sizes: [],
    recent: [],
  };
  // The captured payload is phone-shaped; statusViews reads it as the server's own JSON.
  const { machine } = statusViews(JSON.parse(JSON.stringify({ ...captured, maintenance })));
  expect(machine.maintenance).not.toBeNull();
  expect(rpcEventIssue({ event: 'machine', subscription: 's', seq: 0, machine })).toBeNull();
});

test('names the failing field of a rejected event, not the first event type the union tried', () => {
  const lastChecks = { pressure: null, size: null, worktree: null, sweep: null };
  const maintenance = { mode: 'off', lastChecks, pressure: null, lastPass: null, running: null, plan: {} };
  const { machine } = statusViews(JSON.parse(JSON.stringify(captured)));
  const issue = rpcEventIssue({ event: 'machine', subscription: 's', seq: 0, machine: { ...machine, maintenance } });
  expect(issue).toMatchObject({ keyword: 'type', expectedType: 'array' });
  expect(issue?.schemaPath).toMatch(/\/plan\/type$/);
});

test('accepts the original hello and unknown compatible fields but refuses malformed nested server data', () => {
  expect(isRpcResult('hello', hello)).toBe(true);
  expect(isRpcResult('hello', { ...hello, features: ['future-feature'], future: 1 })).toBe(true);
  expect(isRpcResult('hello', { ...hello, actions: ['reload', 'future-action'] })).toBe(true);
  expect(isRpcResult('hello', { ...hello, server: { ...hello.server, name: 1 } })).toBe(false);
  expect(isRpcResult('hello', { ...hello, capabilities: [1] })).toBe(false);
  expect(isRpcResult('hello', { subscription: 'wrong-method' })).toBe(false);
  expect(isRpcResult('workspaces.subscribe', hello)).toBe(false);
  expect(isRpcResult('workspaces.subscribe', { subscription: 's', future: true })).toBe(true);
});

test.each(['metro', 'maintenance'])(
  'validates %s nested log records and their stack while allowing structured metadata',
  (src) => {
    const record = {
      ts: 1,
      src,
      ...(src === 'maintenance' ? { event: 'maintenance_failure', mode: 'report' } : {}),
      level: 'error',
      msg: 'Error',
      stack: [{ file: 'app.ts', line: 1 }],
      metadata: { key: 'value' },
    };
    expect(isRpcResult('logs.query', { records: [record] })).toBe(true);
    expect(isRpcResult('logs.query', { records: [{ ...record, msg: 1 }] })).toBe(false);
    expect(isRpcEvent({ event: 'logs', subscription: 's', records: [{ ...record, stack: [{ line: 'wrong' }] }] })).toBe(
      false,
    );
    expect(isRpcEvent({ event: 'logs', subscription: 's', records: [record] })).toBe(true);
  },
);

test('validates archive log completion and its subscription identifier', () => {
  expect(isRpcEvent(archivedLogsEnded)).toBe(true);
  expect(isRpcEvent({ event: 'logs-ended' })).toBe(false);
  expect(isRpcEvent({ event: 'logs-ended', subscription: 1 })).toBe(false);
});

test('validates notification targets, frame artwork and future error codes', () => {
  expect(isRpcError({ code: 'future-error', message: 'Unavailable' })).toBe(true);
  expect(isRpcError({ code: 1, message: 'Unavailable' })).toBe(false);
  expect(isRpcEvent({ event: 'device-frame', subscription: 's', artwork: null })).toBe(true);
  expect(isRpcEvent({ event: 'device-frame', subscription: 's', artwork: { width: 'wrong' } })).toBe(false);
  expect(
    isRpcEvent({ event: 'notification', log: 'l', notification: { target: { kind: 'workspace', path: 5 } } }),
  ).toBe(false);
});

test('accepts results and web state from servers that predate cpu, buildMachines and targetId', () => {
  const usage = {
    volumes: [{ mount: '/', holds: ['Workspaces'], freeBytes: 1, totalBytes: 2 }],
    memory: { totalBytes: 2, usedBytes: 1, pressure: 'normal' },
    load: { avg1: 1, avg5: 1, avg15: 1, cpus: 8 },
    sampledAt: '2026-01-01T00:00:00.000Z',
  };
  expect(isRpcResult('machine.get', usage)).toBe(true);
  expect(isRpcResult('machine.get', { ...usage, cpu: { usage: null, cores: 8 } })).toBe(true);
  expect(isRpcResult('machine.get', { ...usage, cpu: { usage: 'high', cores: 8 } })).toBe(false);

  const details = { gc: null, stats: null, measuredAt: '2026-01-01T00:00:00.000Z' };
  expect(isRpcResult('machine.details', details)).toBe(true);
  expect(isRpcResult('machine.details', { ...details, buildMachines: null })).toBe(true);
  expect(isRpcResult('machine.details', { ...details, buildMachines: [{}] })).toBe(false);

  const { payload } = JSON.parse(
    readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
  );
  const web = {
    browser: 'chrome',
    version: null,
    running: false,
    pid: null,
    supervisorPid: null,
    url: 'http://localhost:8081',
    headless: false,
    viewport: 'desktop',
    profile: '/profile',
    cdpEndpoint: null,
  };
  const status = (value: unknown) => {
    payload.environments[0].web = value;
    return isRpcEvent({ event: 'workspace', subscription: 's', seq: 0, environment: payload.environments[0] });
  };
  expect(status(web)).toBe(true);
  expect(status({ ...web, targetId: null })).toBe(true);
  expect(status({ ...web, targetId: 1 })).toBe(false);
});

test('accepts machine memory omissions, null stack frames and extra fields on empty results', () => {
  const { payload } = JSON.parse(
    readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
  );
  delete payload.machine.memorySource;
  for (const owner of payload.machine.owners) delete owner.memoryMb;
  const { machine } = statusViews(payload);
  expect(isRpcEvent({ event: 'machine', subscription: 's', seq: 0, machine })).toBe(true);

  const frame = { file: null, line: null, column: null, fn: null };
  const record = { ts: 1, src: 'web', level: 'error', msg: 'Error', stack: [frame] };
  expect(isRpcResult('logs.query', { records: [record] })).toBe(true);

  expect(isRpcResult('unsubscribe', { ok: true })).toBe(true);
  expect(isRpcResult('unsubscribe', [])).toBe(false);
});

const captured = JSON.parse(
  readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
).payload as StatusPayload;
const workspaceFixture = {
  event: 'workspace',
  subscription: 's',
  seq: 0,
  environment: receiveStatus(captured).environments[0],
};

test('accepts a server clearing the provisional cache-miss flag while rejecting a non-boolean flag', () => {
  const path = 'environment.build.missProvisional';
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, false))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, 'future-kind'))).toBe(false);
});

test.each([
  ...workspaceEnumPaths.map((path) => [path, 'future-kind'] as const),
  ['build.missProvisional', false] as const,
  ['platforms', ['ios', 'future-platform']] as const,
])('a newer server does not invalidate a workspace at %s', (path, value) => {
  expect(isRpcEvent(workspaceFixture)).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, `environment.${path}`, value))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, `environment.${path}`, {}))).toBe(false);
});

test.each(resultEnumCases)('a newer server does not invalidate %s result at %s', (method, fixture, path, value) => {
  expect(isRpcResult(method, fixture)).toBe(true);
  expect(isRpcResult(method, replaceReceivedField(fixture, path, value))).toBe(true);
  expect(isRpcResult(method, replaceReceivedField(fixture, path, {}))).toBe(false);
});

test.each(eventEnumCases)('a newer server does not invalidate event %j at %s', (fixture, path) => {
  expect(isRpcEvent(fixture)).toBe(true);
  expect(isRpcEvent(replaceReceivedField(fixture, path, 'future-kind'))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(fixture, path, {}))).toBe(false);
});

test('unknown structural tags and malformed fields still reject', () => {
  expect(isRpcEvent({ ...workspaceFixture, event: 'future-event' })).toBe(false);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, 'environment.path', 1))).toBe(false);
  expect(
    isRpcEvent(replaceReceivedField(workspaceFixture, 'environment.worktree.gitChip.parts.0.count', 'wrong')),
  ).toBe(false);
});

test('future device usage kinds do not reject a machine event', () => {
  const event = {
    event: 'machine',
    subscription: 's',
    seq: 0,
    machine: statusViews(JSON.parse(JSON.stringify(receiveStatus(captured)))).machine,
    usage: {
      intervalMs: 1000,
      endAt: 1,
      environments: [],
      devices: [{ kind: 'future-kind', id: 'device', workspace: '/app', cpuPercent: [10], memoryMb: [100] }],
    },
  };
  expect(isRpcEvent(event)).toBe(true);
  expect(isRpcEvent(replaceReceivedField(event, 'usage.devices.0.kind', {}))).toBe(false);
});

test('opening display enums preserves validation of nested app, agent and ownership data', () => {
  for (const path of [
    'environment.macos.product',
    'environment.macos.build.startedAt',
    'environment.agents.0.cwd',
    'environment.endedAgents.0.openUrl',
  ]) {
    expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, 1))).toBe(false);
  }
  for (const [path, value] of [
    ['environment.physicalDevices.0.owned', true],
    ['environment.physicalDevices.0.physical', false],
    ['environment.macos.host.agent.command', 1],
    ['environment.build.placement', { host: 1 }],
  ]) {
    expect(isRpcEvent(replaceReceivedField(workspaceFixture, path as string, value))).toBe(false);
  }
});

test('accepts new display kinds without requiring the known kind details', () => {
  const payload = replaceReceivedField(workspaceFixture, 'environment.worktree.gitChip.parts', [
    { kind: 'future-kind' },
  ]);
  expect(isRpcEvent(payload)).toBe(true);
  const [fixture] = eventEnumCases.find(([, path]) => path === 'notification.target.kind')!;
  expect(isRpcEvent(replaceReceivedField(fixture, 'notification.target', { kind: 'future-target' }))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(fixture, 'notification.target', { kind: 'future-target', path: 1 }))).toBe(
    false,
  );
});

test('archive lists accept future enum strings and reject malformed byte counts', () => {
  const archive = {
    id: 'app--1',
    projectRoot: '/app',
    project: 'app',
    workspace: 'app',
    worktree: {
      repository: null,
      branch: null,
      head: null,
      subject: null,
      merged: null,
      pullRequest: { number: 1, state: 'future-state', title: 'PR', url: 'https://example.test/pr' },
    },
    removedAt: '2026-01-01T00:00:00Z',
    removedBy: 'future-remover',
    lastUsedAt: null,
    builds: { count: 0, last: null, lastErrorCount: 0 },
    agents: [{ tool: 'future-agent', sessionId: 's', cwd: '/app', endedAt: '2026-01-01T00:00:00Z' }],
    bytes: { logs: 1, recordings: 2, agentActions: 3, record: 4, total: 10 },
    expires: { logs: null, recordings: null, agentActions: null, record: null },
    version: 1,
  };
  const updated = {
    next: null,
    archived: [archive],
    usage: { count: 1, bytes: 10, byKind: { logs: 1, recordings: 2, agentActions: 3, record: 4 } },
  };
  expect(isRpcResult('archived.list', updated)).toBe(true);
  expect(
    isRpcResult('archived.list', { ...updated, archived: [{ ...archive, bytes: { ...archive.bytes, logs: 'bad' } }] }),
  ).toBe(false);
});

test('slot waits are additive for older phone status and accept future kinds while checking their shape', () => {
  const path = 'environment.build.waitingFor';
  const waitingFor = { kind: 'device-slot', inUse: 2, max: 2, since: '2026-10-01T00:00:00.000Z' };
  expect(isRpcEvent(workspaceFixture)).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, waitingFor))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, { ...waitingFor, kind: 'future-slot' }))).toBe(true);
  expect(isRpcEvent(replaceReceivedField(workspaceFixture, path, { ...waitingFor, inUse: '2' }))).toBe(false);
});

test('names the schema location of a rejected value and nothing from the value', () => {
  expect(rpcResultIssue('hello', hello)).toBeNull();
  const missing = rpcResultIssue('hello', { ...hello, protocol: undefined, extra: 'tail1a2b3.ts.net' });
  expect(missing).toEqual({ keyword: 'required', schemaPath: '#/required', missingProperty: 'protocol' });
  const wrongType = rpcResultIssue('hello', { ...hello, protocol: 'secret-value' });
  expect(wrongType).toEqual({
    keyword: 'type',
    schemaPath: '#/properties/protocol/type',
    expectedType: 'number',
  });
  expect(JSON.stringify([missing, wrongType])).not.toMatch(/secret-value|tail1a2b3/);
  expect(
    rpcEventIssue({ event: 'workspace', subscription: 's', seq: 0, environment: { path: 1 } })?.keyword,
  ).toBeTruthy();
});
