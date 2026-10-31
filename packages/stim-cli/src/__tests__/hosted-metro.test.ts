import { mkdtempSync, realpathSync, rmSync, type PathLike, type WatchListener } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { hostedMetroLinks } from '@stim-cli/core/state';
import { watchHostedMetro } from '../supervisor/hosted-metro.ts';
import { captureProcessToken } from '../process-identity.ts';
import { closeHostedMetro, hostedAgentPort, requireHostedMetro } from '../device-host/metro-request.ts';
import { writeHostedNative } from '../device-host/ios-state.ts';
import type { HostedIosPlacement } from '@stim-cli/core/state';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const writeHostedIos = (root: string, slot: string, host: HostedIosPlacement | null): void =>
  writeHostedNative(root, slot, host, 'ios');

const links = vi.hoisted(() => ({
  close: vi.fn<() => void>(),
  relayClose: vi.fn<() => void>(),
  relayPort: vi.fn<(port: number | undefined) => void>(),
  lost: vi.fn<() => void>(),
  probe: vi.fn<() => Promise<{ state: 'ready' | 'stopped' }>>(),
  dropWatchEvents: false,
  failLinkWrites: 0,
}));
vi.mock('../workspace/workspace-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/workspace-state.ts')>();
  return {
    ...actual,
    updateWorkspaceState: (root: string, update: Parameters<typeof actual.updateWorkspaceState>[1]) =>
      actual.updateWorkspaceState(root, (state) => {
        const next = update(state);
        if (
          links.failLinkWrites > 0 &&
          JSON.stringify(next.hostedMetroLinks) !== JSON.stringify(state.hostedMetroLinks)
        ) {
          links.failLinkWrites--;
          throw new Error('ENOSPC: no space left on device');
        }
        return next;
      }),
  };
});
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
        if (!links.dropWatchEvents) changed?.(event, name);
      });
    },
  };
});
vi.mock('../device-host/hosted-client.ts', () => ({ probeHostedSession: links.probe }));
vi.mock('../supervisor/metro-links.ts', () => ({
  openMetroLinks: ({ onReady, onLost }: { onReady: () => void; onLost: () => void }) => {
    links.lost.mockImplementation(onLost);
    queueMicrotask(onReady);
    return { close: links.close };
  },
}));
vi.mock('../supervisor/agent-relay.ts', () => ({
  openAgentRelay: ({ port }: { port?: number }) => {
    links.relayPort(port);
    return { port: Promise.resolve(51234), close: links.relayClose };
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
  links.close.mockReset();
  links.relayClose.mockReset();
  links.relayPort.mockReset();
  links.lost.mockReset();
  links.probe.mockReset();
  links.dropWatchEvents = false;
  links.failLinkWrites = 0;
  writeWorkspaceState(root, {
    supervisor: { processToken: 'watcher' },
    hostedMetroRequests: {
      [session]: { id: 'request', machine: 'mini' },
      [orphan]: { id: 'old', machine: 'mini' },
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

test('a session on a local network machine publishes its agent relay port with readiness and closes the relay with its links', async () => {
  links.probe.mockResolvedValue({ state: 'ready' });
  writeWorkspaceState(root, {
    hostedMetroRequests: { [session]: { id: 'request', machine: 'local:10.0.0.92' } },
    hostedMetroLinks: { [session]: { id: 'earlier', processToken: 'gone', agentPort: 51234 } },
  });
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    await vi.waitFor(() =>
      expect(readWorkspaceState(root)?.hostedMetroLinks).toMatchObject({
        [session]: { id: 'request', processToken: 'watcher', ready: true, agentPort: 51234 },
      }),
    );
    expect(links.relayPort).toHaveBeenCalledWith(51234);
    expect(hostedAgentPort(root, session)).toBe(51234);
    links.lost();
    expect(hostedMetroLinks(readWorkspaceState(root))[session]).toEqual({
      id: 'request',
      processToken: 'watcher',
      agentPort: 51234,
    });
    expect(hostedAgentPort(root, session)).toBeNull();
    await closeHostedMetro(root, session);
    await vi.waitFor(() => expect(links.relayClose).toHaveBeenCalledOnce());
  } finally {
    await close();
  }
});

test('a link state write that fails once is written again, for readiness and for closing', async () => {
  links.probe.mockResolvedValue({ state: 'ready' });
  links.failLinkWrites = 1;
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    await vi.waitFor(
      () => expect(readWorkspaceState(root)?.hostedMetroLinks).toMatchObject({ [session]: { ready: true } }),
      { timeout: 3000 },
    );
    expect(links.failLinkWrites).toBe(0);
    links.failLinkWrites = 1;
    await closeHostedMetro(root, session);
    expect(readWorkspaceState(root)?.hostedMetroLinks).toEqual({});
    expect(links.failLinkWrites).toBe(0);
  } finally {
    await close();
  }
});

test('remote stopped evidence closes links ten seconds after an offset initial probe', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  links.dropWatchEvents = true;
  links.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, 'watcher');
  try {
    vi.advanceTimersByTime(5000);
    await setImmediate();
    expect(links.probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(links.probe).toHaveBeenCalledOnce();
    links.probe.mockResolvedValue({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(links.probe).toHaveBeenCalledTimes(2);
    expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => {
      expect(links.close).toHaveBeenCalledOnce();
      expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
      expect(readWorkspaceState(root)?.hostedMetroLinks).toEqual({});
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
  links.probe.mockResolvedValue({ state: 'ready' });
  const close = watchHostedMetro(root, 8082, processToken!);
  try {
    expect(() => requireHostedMetro(root)).not.toThrow();
  } finally {
    await close();
  }
});
