import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { closeHostedMetro, requestHostedMetro } from '../device-host/metro-gateway.ts';
import { hostedMetroRequests, type DeviceHostMachineCredential } from '@stim-cli/core/state';
import { captureProcessToken } from '../process-identity.ts';
import { workspaceStateFile } from '../workspace/paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const watches = vi.hoisted(() => ({ callbacks: new Map<string, () => void>(), opened: 0, closed: 0 }));
vi.mock('../offload/tailnet.ts', () => ({
  tailscaleStatusAsync: async () => ({
    Self: { TailscaleIPs: ['100.64.0.2'] },
    Peer: { mini: { ID: 'nMini', DNSName: 'mini.tail.ts.net.', TailscaleIPs: ['100.64.0.7'] } },
  }),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: (file: string, _options: unknown, changed: () => void) => {
    watches.opened++;
    watches.callbacks.set(file, changed);
    return new (class extends EventEmitter {
      private closed = false;
      close() {
        if (this.closed) return;
        this.closed = true;
        if (watches.callbacks.get(file) === changed) watches.callbacks.delete(file);
        watches.closed++;
        this.emit('close');
      }
    })();
  },
}));

let home: string;
let root: string;
let abort: AbortController;
const session = '12345678-1234-1234-1234-123456789abc';
const credential: DeviceHostMachineCredential = {
  machine: 'mini',
  transport: 'tailscale',
  address: 'mini.tail.ts.net',
  serverKey: 'fixture',
  deviceId: 'client',
  state: 'approved',
  requestedAt: '2026-10-17T00:00:00Z',
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gateway-ack-')));
  process.env.STIM_HOME = join(home, 'stim');
  root = join(home, 'app');
  watches.callbacks.clear();
  watches.opened = watches.closed = 0;
  abort = new AbortController();
  const processToken = captureProcessToken(process.pid);
  assert(processToken);
  writeWorkspaceState(root, {
    supervisor: { pid: process.pid, processToken, hostedMetro: true },
    hostedMetroRequests: {
      [session]: { id: 'request', machine: 'mini', address: '100.64.0.2', peer: '100.64.0.7', secret: 'a'.repeat(64) },
    },
  });
  writeWorkspaceState(root, {
    hostedMetroGateways: {
      [session]: { id: 'request', processToken, port: 7443 },
    },
  });
  vi.useFakeTimers();
});

afterEach(async () => {
  abort.abort();
  await setImmediate();
  vi.useRealTimers();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function closing() {
  let settled = false;
  const pending = closeHostedMetro(root, session, abort.signal).then(
    () => {
      settled = true;
      return true;
    },
    () => false,
  );
  await vi.waitFor(() => expect(readWorkspaceState(root)?.hostedMetroRequests).not.toHaveProperty(session), {
    interval: 1,
  });
  await vi.advanceTimersByTimeAsync(1);
  return { pending, settled: () => settled };
}

test('a matching close acknowledgement wakes before the old 100ms scan', async () => {
  const state = await closing();
  writeWorkspaceState(root, { hostedMetroGateways: {} });
  watches.callbacks.get(workspaceStateFile(root))?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.settled()).toBe(true);
  expect(await state.pending).toBe(true);
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stale request or supervisor token cannot acknowledge a new gateway', async () => {
  writeWorkspaceState(root, { hostedMetroRequests: {}, hostedMetroGateways: {} });
  let result: unknown;
  const pending = requestHostedMetro(root, session, credential, abort.signal).then(
    (value) => {
      result = value;
      return value;
    },
    () => null,
  );
  await vi.waitFor(() => expect(readWorkspaceState(root)?.hostedMetroRequests).toHaveProperty(session), {
    interval: 1,
  });
  await vi.advanceTimersByTimeAsync(1);
  const state = readWorkspaceState(root);
  assert(state?.supervisor?.processToken);
  const request = hostedMetroRequests(state)[session];
  assert(request);
  const token = state.supervisor.processToken;
  for (const gateway of [
    { id: 'stale', processToken: token, port: 7443 },
    { id: request.id, processToken: 'stale', port: 7443 },
  ]) {
    writeWorkspaceState(root, { hostedMetroGateways: { [session]: gateway } });
    watches.callbacks.get(workspaceStateFile(root))?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeUndefined();
  }
  writeWorkspaceState(root, {
    hostedMetroGateways: { [session]: { id: request.id, processToken: token, port: 7444 } },
  });
  watches.callbacks.get(workspaceStateFile(root))?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ gatewayPort: 7444, secret: request.secret });
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test('a dropped close hint is repaired and all observers are released', async () => {
  const state = await closing();
  await vi.advanceTimersByTimeAsync(600);
  writeWorkspaceState(root, { hostedMetroGateways: {} });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await state.pending).toBe(true);
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test('abort cancels the wait without waiting for a state hint or repair', async () => {
  const state = await closing();
  abort.abort();
  expect(await state.pending).toBe(false);
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test('close refuses after its original five-second budget with the gateway still recorded', async () => {
  const state = await closing();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await state.pending).toBe(false);
  expect(readWorkspaceState(root)?.hostedMetroGateways).toHaveProperty(session);
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['error', 'timeout'])('open preserves the %s refusal and releases observation', async (outcome) => {
  writeWorkspaceState(root, { hostedMetroRequests: {}, hostedMetroGateways: {} });
  const pending = requestHostedMetro(root, session, credential, abort.signal).catch((error: unknown) => error);
  await vi.waitFor(() => expect(readWorkspaceState(root)?.hostedMetroRequests).toHaveProperty(session), {
    interval: 1,
  });
  await vi.advanceTimersByTimeAsync(1);
  if (outcome === 'error') {
    const state = readWorkspaceState(root);
    assert(state?.supervisor?.processToken);
    const request = hostedMetroRequests(state)[session];
    assert(request);
    writeWorkspaceState(root, {
      hostedMetroGateways: {
        [session]: { id: request.id, processToken: state.supervisor.processToken, error: 'bind refused' },
      },
    });
    watches.callbacks.get(workspaceStateFile(root))?.();
  }
  await vi.advanceTimersByTimeAsync(outcome === 'error' ? 1 : 15_000);
  expect(await pending).toMatchObject({
    message: expect.stringContaining(outcome === 'error' ? 'bind refused' : 'did not open a private gateway'),
  });
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});
