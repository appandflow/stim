import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchHostedMetro } from '../supervisor/hosted-metro.ts';
import { captureProcessToken } from '../process-identity.ts';
import { closeHostedMetro, requireHostedMetro } from '../device-host/metro-gateway.ts';
import { writeHostedIos } from '../device-host/ios-state.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

const gateway = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  probe: vi.fn<() => Promise<{ state: 'ready' }>>(),
}));
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
