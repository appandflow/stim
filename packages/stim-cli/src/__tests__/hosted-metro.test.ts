import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, type PathLike, type WatchListener } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { hostedMetroGateways } from '@stim-cli/core/state';
import { watchHostedMetro } from '../supervisor/hosted-metro.ts';
import { captureProcessToken } from '../process-identity.ts';
import { closeHostedMetro, requireHostedMetro } from '../device-host/metro-gateway.ts';
import { writeHostedIos } from '../device-host/ios-state.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const gateway = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  probe: vi.fn<() => Promise<{ state: 'ready' | 'stopped' }>>(),
  dropWatchEvents: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (
      file: PathLike,
      options: WatchListener<string> | { persistent?: boolean },
      listener?: WatchListener<string>,
    ) => {
      const changed = typeof options === 'function' ? options : listener;
      return fs.watch(file, (event, name) => {
        if (!gateway.dropWatchEvents) changed?.(event, name);
      });
    },
  };
});
vi.mock('../device-host/hosted-client.ts', () => ({ probeHostedSession: gateway.probe }));
vi.mock('@stim-cli/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stim-cli/core')>()),
  createMetroGateway: () => {
    const server = Object.assign(new EventEmitter(), {
      listen: (_port: number, _address: string, done: () => void) => done(),
      address: () => ({ port: 7443 }),
    });
    return { server, close: gateway.close };
  },
}));
let home: string;
let root: string;
const orphan = '23456789-1234-1234-1234-123456789abc';
const session = '12345678-1234-1234-1234-123456789abc';

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-metro-')));
  process.env.STIM_HOME = home;
  root = join(home, 'app');
  gateway.close.mockReset().mockResolvedValue(undefined);
  gateway.probe.mockReset();
  gateway.dropWatchEvents = false;
  writeWorkspaceState(root, {
    supervisor: { processToken: 'watcher' },
    hostedMetroRequests: {
      [session]: { id: 'request', machine: 'mini', address: '100.64.0.2', peer: '100.64.0.7', secret: 'a'.repeat(64) },
      [orphan]: { id: 'old', machine: 'mini', address: '100.64.0.2', peer: '100.64.0.7', secret: 'b'.repeat(64) },
    },
  });
  writeHostedIos(root, 'default', {
    machine: 'mini',
    selected: 'mini',
    session,
    appAttempt: 'attempt',
    device: null,
    agent: { driver: 'none', setting: 'hosting.agentDriver' },
  });
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('gateway close completes while host evidence is pending, and orphan requests cannot stay active', async () => {
  let release: ((result: { state: 'ready' }) => void) | undefined;
  gateway.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    await vi.waitFor(() => {
      expect(readWorkspaceState(root)?.hostedMetroGateways).toMatchObject({ [session]: { port: 7443 } });
      expect(readWorkspaceState(root)?.hostedMetroRequests).not.toHaveProperty(orphan);
      expect(gateway.probe).toHaveBeenCalled();
    });
    await closeHostedMetro(root, session);
    expect(readWorkspaceState(root)?.hostedMetroGateways).toEqual({});
    expect(gateway.close).toHaveBeenCalledOnce();
  } finally {
    await close();
    release?.({ state: 'ready' });
  }
});

test('a removed placement closes the gateway and discards its stale request', async () => {
  gateway.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    await vi.waitFor(() =>
      expect(readWorkspaceState(root)?.hostedMetroGateways).toMatchObject({ [session]: { port: 7443 } }),
    );
    writeWorkspaceState(root, { ios: {} });
    await vi.waitFor(() => {
      expect(readWorkspaceState(root)?.hostedMetroGateways).toEqual({});
      expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
    });
    expect(gateway.close).toHaveBeenCalledOnce();
  } finally {
    await close();
  }
});

test('atomic workspace replacements reconcile gateways without a periodic check', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  gateway.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    await setImmediate();
    expect(readWorkspaceState(root)?.hostedMetroGateways).toMatchObject({ [session]: { port: 7443 } });
    const request = readWorkspaceState(root)?.hostedMetroRequests;
    expect(request).toBeTruthy();
    writeWorkspaceState(root, { hostedMetroRequests: {} });
    const wait = async (ready: () => boolean) => {
      const until = Date.now() + 2000;
      while (!ready() && Date.now() < until) await delay(10);
      expect(ready()).toBe(true);
    };
    await wait(() => gateway.close.mock.calls.length === 1);
    writeWorkspaceState(root, { hostedMetroRequests: request });
    await wait(() => Boolean(hostedMetroGateways(readWorkspaceState(root))[session]));
    writeWorkspaceState(root, { hostedMetroRequests: {} });
    await wait(() => gateway.close.mock.calls.length === 2);
    expect(readWorkspaceState(root)?.hostedMetroGateways).toEqual({});
  } finally {
    await close();
    vi.useRealTimers();
  }
});

test('remote stopped evidence closes a gateway ten seconds after an offset initial probe', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  gateway.dropWatchEvents = true;
  gateway.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    vi.advanceTimersByTime(5000);
    await setImmediate();
    expect(gateway.probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(gateway.probe).toHaveBeenCalledOnce();
    gateway.probe.mockResolvedValue({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(gateway.probe).toHaveBeenCalledTimes(2);
    expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => {
      expect(gateway.close).toHaveBeenCalledOnce();
      expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
      expect(readWorkspaceState(root)?.hostedMetroGateways).toEqual({});
    });
  } finally {
    await close();
    vi.useRealTimers();
  }
});

test('a live supervisor must advertise its watcher before a hosted Debug run can reserve', async () => {
  const processToken = captureProcessToken(process.pid);
  expect(processToken).toBeTruthy();
  writeWorkspaceState(root, { supervisor: { pid: process.pid, processToken } });
  expect(() => requireHostedMetro(root)).toThrow(
    expect.objectContaining({
      code: 'STIM_HOSTING_REFUSED',
      message: expect.stringContaining('stim stop; stim start'),
    }),
  );
  gateway.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, processToken!);
  try {
    expect(() => requireHostedMetro(root)).not.toThrow();
  } finally {
    await close();
  }
});
