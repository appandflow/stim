import { readFileSync } from 'node:fs';
import { isRpcError, isRpcEvent, isRpcResult } from '../receive-protocol.ts';

const hello = { protocol: 1, server: { name: 'Mac', version: '1', stim: '1' }, capabilities: ['read'] };

test('accepts captured older status while checking Android runtime fields', () => {
  const { payload } = JSON.parse(
    readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
  );
  expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(true);
  const environment = payload.environments.find((entry: { android?: unknown }) => entry.android);
  for (const state of ['detected', 'not-detected', 'missing', 'unknown']) {
    environment.android.state = state;
    expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(true);
  }
  for (const state of [{}, 'invalid', 1]) {
    environment.android.state = state;
    expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(false);
  }
  environment.android.state = 'detected';
  environment.android.owned = 'true';
  expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(false);
});

test('accepts the original hello and unknown compatible fields but refuses malformed nested server data', () => {
  expect(isRpcResult('hello', hello)).toBe(true);
  expect(isRpcResult('hello', { ...hello, features: ['future-feature'], future: 1 })).toBe(true);
  expect(isRpcResult('hello', { ...hello, server: { ...hello.server, name: 1 } })).toBe(false);
  expect(isRpcResult('hello', { ...hello, capabilities: [1] })).toBe(false);
  expect(isRpcResult('hello', { subscription: 'wrong-method' })).toBe(false);
  expect(isRpcResult('status.subscribe', hello)).toBe(false);
  expect(isRpcResult('status.subscribe', { subscription: 's', future: true })).toBe(true);
});

test('validates nested log records and their stack while allowing structured metadata', () => {
  const record = {
    ts: 1,
    src: 'metro',
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
    return isRpcEvent({ event: 'status', subscription: 's', payload });
  };
  expect(status(web)).toBe(true);
  expect(status({ ...web, targetId: null })).toBe(true);
  expect(status({ ...web, targetId: 1 })).toBe(false);
});

test('accepts status without machine memory fields, null stack frames and extra fields on empty results', () => {
  const { payload } = JSON.parse(
    readFileSync(new URL('../../../apps/mobile/mock-server/fixtures/status.json', import.meta.url), 'utf8'),
  );
  delete payload.machine.memorySource;
  for (const owner of payload.machine.owners) delete owner.memoryMb;
  expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(true);

  const frame = { file: null, line: null, column: null, fn: null };
  const record = { ts: 1, src: 'web', level: 'error', msg: 'Error', stack: [frame] };
  expect(isRpcResult('logs.query', { records: [record] })).toBe(true);

  expect(isRpcResult('unsubscribe', { ok: true })).toBe(true);
  expect(isRpcResult('unsubscribe', [])).toBe(false);
});
