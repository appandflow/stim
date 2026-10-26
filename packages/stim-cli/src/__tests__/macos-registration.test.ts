import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacosAppRecord } from '@stim-cli/core/state';
import { captureProcessToken } from '../process-identity.ts';
import { waitForMacosRegistration } from '../macos/registration.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;
let root: string;
let previousHome: string | undefined;
let child: ChildProcess;
let record: MacosAppRecord;

beforeEach(() => {
  previousHome = process.env.STIM_HOME;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-macos-registration-')));
  root = join(dir, 'app');
  mkdirSync(root);
  process.env.STIM_HOME = join(dir, 'home');
  const processToken = captureProcessToken(process.pid);
  if (!processToken) throw new Error('The test process identity is unavailable.');
  const owner = { pid: process.pid, processToken, startedAtMicros: 1 };
  record = {
    launchId: 'expected-launch',
    arguments: [],
    product: 'Sample',
    bundle: join(root, 'Sample.app'),
    bundleId: 'dev.stim.registration.test',
    executable: join(root, 'Sample.app', 'Contents', 'MacOS', 'Sample'),
    build: { state: 'ok', startedAt: new Date().toISOString() },
    app: owner,
    supervisor: owner,
  };
  writeWorkspaceState(root, { macos: { ...record, app: undefined } });
  child = makeChildProcess({ connected: true });
  child.disconnect = vi.fn<() => void>(() => {
    Object.assign(child, { connected: false });
    child.emit('disconnect');
  });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

test('a supervisor hint completes registration without a polling tick and detaches IPC', async () => {
  let registered: MacosAppRecord | null | undefined;
  const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000).then((value) => {
    registered = value;
    return value;
  });
  try {
    writeWorkspaceState(root, { macos: record });
    child.emit('message', 'macos-registered');
    await vi.advanceTimersByTimeAsync(0);
    expect(registered).toEqual(record);
    expect(child.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('disconnect')).toBe(0);
  } finally {
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
  }
});

test.each(['launch', 'app', 'supervisor', 'app identity', 'supervisor identity'])(
  'a hint cannot accept a mismatched %s',
  async (invalid) => {
    const bad = { ...record };
    if (invalid === 'launch') bad.launchId = 'previous-launch';
    if (invalid === 'app') delete bad.app;
    if (invalid === 'supervisor') delete bad.supervisor;
    if (invalid === 'app identity') bad.app = { pid: process.pid, processToken: 'invalid', startedAtMicros: 1 };
    if (invalid === 'supervisor identity')
      bad.supervisor = { pid: process.pid, processToken: 'invalid', startedAtMicros: 1 };
    let registered: MacosAppRecord | null | undefined;
    const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000).then((value) => {
      registered = value;
      return value;
    });
    try {
      writeWorkspaceState(root, { macos: bad });
      child.emit('message', 'macos-registered');
      await vi.advanceTimersByTimeAsync(0);
      expect(registered).toBeUndefined();
      writeWorkspaceState(root, { macos: record });
      child.emit('message', 'macos-registered');
      await vi.advanceTimersByTimeAsync(0);
      expect(registered).toEqual(record);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
    }
  },
);

test('an already published registration needs no later notification', async () => {
  writeWorkspaceState(root, { macos: record });
  expect(await waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000)).toEqual(record);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.connected).toBe(false);
});

test.each(['missing message', 'disconnected channel'])(
  'registration repairs a %s without changing its deadline',
  async (failure) => {
    let registered: MacosAppRecord | null | undefined;
    const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000).then((value) => {
      registered = value;
      return value;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      if (failure === 'disconnected channel') child.disconnect();
      writeWorkspaceState(root, { macos: record });
      await vi.advanceTimersByTimeAsync(1000);
      expect(registered).toEqual(record);
      expect(child.connected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
    }
  },
);

test('an unrelated child message does not complete the registration wait', async () => {
  let registered: MacosAppRecord | null | undefined;
  const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000).then((value) => {
    registered = value;
    return value;
  });
  try {
    writeWorkspaceState(root, { macos: record });
    child.emit('message', 'other-message');
    await vi.advanceTimersByTimeAsync(0);
    expect(registered).toBeUndefined();
    child.emit('message', 'macos-registered');
    await vi.advanceTimersByTimeAsync(0);
    expect(registered).toEqual(record);
  } finally {
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
  }
});

test('an invalid registration ends at the existing deadline and releases IPC and listeners', async () => {
  const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toBeNull();
  expect(child.connected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('disconnect')).toBe(0);
});

test('supervisor exit ends an unregistered launch before its deadline', async () => {
  const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000);
  Object.assign(child, { exitCode: 1 });
  child.emit('exit', 1, null);
  expect(await pending).toBeNull();
  expect(child.connected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('a spawn error rejects registration and releases IPC', async () => {
  const pending = waitForMacosRegistration(root, record.launchId, child, Date.now() + 20_000);
  queueMicrotask(() => child.emit('error', new Error('spawn denied')));
  await expect(pending).rejects.toThrow('spawn denied');
  expect(child.connected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('disconnect')).toBe(0);
});
