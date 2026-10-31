import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { closeHostedMetro, requestHostedMetro } from '../device-host/metro-request.ts';
import { hostedMetroRequests, type DeviceHostMachineCredential } from '@stim-cli/core/state';
import { captureProcessToken } from '../process-identity.ts';
import { workspaceStateFile } from '../workspace/paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const watches = vi.hoisted(() => ({ callbacks: new Map<string, () => void>(), opened: 0, closed: 0 }));
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
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-ack-')));
  process.env.STIM_HOME = join(home, 'stim');
  root = join(home, 'app');
  watches.callbacks.clear();
  watches.opened = watches.closed = 0;
  abort = new AbortController();
  const processToken = captureProcessToken(process.pid);
  assert(processToken);
  writeWorkspaceState(root, {
    supervisor: { pid: process.pid, processToken, hostedMetroLinks: true },
    hostedMetroRequests: {
      [session]: { id: 'request', machine: 'mini' },
    },
  });
  writeWorkspaceState(root, {
    hostedMetroLinks: {
      [session]: { id: 'request', processToken, ready: true },
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

test('a stale request or supervisor token cannot acknowledge new links', async () => {
  writeWorkspaceState(root, { hostedMetroRequests: {}, hostedMetroLinks: {} });
  let linked = false;
  const pending = requestHostedMetro(root, session, credential, abort.signal).then(() => (linked = true));
  await vi.waitFor(() => expect(readWorkspaceState(root)?.hostedMetroRequests).toHaveProperty(session), {
    interval: 1,
  });
  await vi.advanceTimersByTimeAsync(1);
  const state = readWorkspaceState(root);
  assert(state?.supervisor?.processToken);
  const request = hostedMetroRequests(state)[session];
  assert(request);
  const token = state.supervisor.processToken;
  for (const links of [
    { id: 'stale', processToken: token, ready: true },
    { id: request.id, processToken: 'stale', ready: true },
  ]) {
    writeWorkspaceState(root, { hostedMetroLinks: { [session]: links } });
    watches.callbacks.get(workspaceStateFile(root))?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(linked).toBe(false);
  }
  writeWorkspaceState(root, {
    hostedMetroLinks: { [session]: { id: request.id, processToken: token, ready: true } },
  });
  watches.callbacks.get(workspaceStateFile(root))?.();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(linked).toBe(true);
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

test('close refuses after its original five-second budget with the links still recorded', async () => {
  const state = await closing();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await state.pending).toBe(false);
  expect(readWorkspaceState(root)?.hostedMetroLinks).toHaveProperty(session);
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['timeout'])('open preserves the %s refusal and releases observation', async (outcome) => {
  writeWorkspaceState(root, { hostedMetroRequests: {}, hostedMetroLinks: {} });
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
      hostedMetroLinks: {
        [session]: { id: request.id, processToken: state.supervisor.processToken, error: 'link refused' },
      },
    });
    watches.callbacks.get(workspaceStateFile(root))?.();
  }
  await vi.advanceTimersByTimeAsync(outcome === 'error' ? 1 : 15_000);
  expect(await pending).toMatchObject({
    message: expect.stringContaining(outcome === 'error' ? 'link refused' : 'did not link Metro'),
  });
  expect(watches.closed).toBe(watches.opened);
  expect(vi.getTimerCount()).toBe(0);
});
