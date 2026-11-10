import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServeRoute } from '@stim-cli/core/protocol';
import type { TailscaleSnapshot, TailscaleState } from '@stim-cli/transport-tailscale';
import type { Tailnet } from '../src/tailnet-helper.ts';

interface Fixture {
  options: { tailnet?: Tailnet }[];
  created: number;
  binary: string | null;
  state: TailscaleState;
  label: string | null;
  serve: { port: number; created: boolean } | null;
  watching: (() => void) | null;
}

const { fixture, fresh } = vi.hoisted(() => {
  const initial = (): Fixture => ({
    options: [],
    created: 0,
    binary: null,
    state: { state: 'unavailable', reason: 'fixture' },
    label: null,
    serve: null,
    watching: null,
  });
  return { fixture: initial(), fresh: initial };
});

vi.mock('../src/server.ts', () => ({
  startServer: async (options: { tailnet?: Tailnet }) => {
    fixture.options.push(options);
    return { addresses: [], close: async () => {} };
  },
}));
vi.mock('../src/environment.ts', () => ({
  bundledStim: () => ({ cli: 'unused', version: '1.0.0' }),
}));
vi.mock('@stim-cli/core/toolchain', () => ({
  discoverToolchain: (env: NodeJS.ProcessEnv) => ({ env: { ...env }, entries: [] }),
}));
vi.mock('../src/service-manager.ts', async (original) => ({
  ...(await original<typeof import('../src/service-manager.ts')>()),
  serviceManagerOrNull: () => ({
    name: 'launchd',
    runningLabel: () => fixture.label,
    read: async () => (fixture.serve ? { serve: fixture.serve } : null),
  }),
}));
vi.mock('../src/service.ts', async (original) => ({
  ...(await original<typeof import('../src/service.ts')>()),
  rewriteUnitToShim: async () => false,
}));
vi.mock('../src/registry.ts', async (original) => {
  const actual = await original<typeof import('../src/registry.ts')>();
  return {
    ...actual,
    watchClientRegistries: (changed: () => void, also?: string[]) => {
      fixture.watching?.();
      return actual.watchClientRegistries(changed, also);
    },
  };
});
vi.mock('@stim-cli/transport-tailscale', async (original) => {
  const actual = await original<typeof import('@stim-cli/transport-tailscale')>();
  const snapshot: TailscaleSnapshot = { binary: null, state: { state: 'unavailable', reason: 'fixture' } };
  return {
    ...actual,
    findTailscale: () => fixture.binary,
    readTailscaleStatus: async () => fixture.state,
    readRawTailscaleStatus: async () => null,
    serveRoute: async (): Promise<ServeRoute> => ({ state: 'missing', port: 7443 }),
    createTransport: async ({ env }: { env: NodeJS.ProcessEnv }) => {
      fixture.created++;
      return actual.tailscaleTransport({
        env,
        snapshot,
        monitor: { current: () => snapshot, stop: () => {}, onChange: () => () => {} },
      });
    },
  };
});

const RUNNING: TailscaleState = { state: 'running', ips: ['100.64.0.9'], dnsName: 'mac.tail.ts.net', hostName: 'mac' };

const record = (id: string, capabilities: string[]) => ({
  id,
  name: id,
  publicKey: Buffer.alloc(32, id.length).toString('base64url'),
  capabilities,
  pairedAt: '2026-11-01T00:00:00.000Z',
  lastSeenAt: null,
});

function writeRegistry(home: string, file: string, devices: unknown): void {
  mkdirSync(join(home, 'server'), { recursive: true });
  writeFileSync(join(home, 'server', file), JSON.stringify({ version: 2, devices }));
}

interface TriggerCase {
  before?: (home: string) => void;
  after?: (home: string) => Promise<unknown>;
  marked: boolean;
}

const cases: [string, TriggerCase][] = [
  ['a home with no record and no trigger', { marked: false }],
  [
    'a paired device at the first start, with no tailscale command yet',
    { before: (home) => writeRegistry(home, 'devices.json', [record('phone', ['read'])]), marked: true },
  ],
  [
    'a build client approved while the tailscale command is installed',
    {
      after: async (home) => {
        fixture.binary = '/fake/tailscale';
        writeRegistry(home, 'build-clients.json', [record('builder', ['build'])]);
      },
      marked: false,
    },
  ],
  [
    'a serve route the running service recorded',
    {
      before: () => {
        fixture.label = 'dev.stim.trigger';
        fixture.serve = { port: 7443, created: true };
      },
      marked: false,
    },
  ],
  [
    'the marker written between the start check and the watch',
    {
      before: (home) => {
        fixture.watching = () => writeFileSync(join(home, 'server', 'tailnet.json'), '{}');
      },
      marked: true,
    },
  ],
  [
    'the marker beside a registry this version cannot read',
    {
      before: (home) => {
        writeRegistry(home, 'devices.json', {});
        writeFileSync(join(home, 'server', 'tailnet.json'), '{}');
      },
      marked: true,
    },
  ],
  [
    'stim serve --tailnet',
    {
      after: async () =>
        expect(await (await import('../src/cli.ts')).rememberTailnet()).toMatch(/^Tailscale is unavailable/),
      marked: true,
    },
  ],
  [
    'stim pair while Tailscale runs',
    {
      after: async () => {
        fixture.binary = '/fake/tailscale';
        fixture.state = RUNNING;
        await (await import('../src/cli.ts')).pair(7787, true, false);
      },
      marked: true,
    },
  ],
  [
    "setup's route step",
    {
      after: async () => {
        fixture.binary = '/fake/tailscale';
        fixture.state = RUNNING;
        await (await import('../src/setup.ts')).defaultSetupDeps().prepareRoute(7787, null);
      },
      marked: true,
    },
  ],
];

describe('the net thread loads the Tailscale transport', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-server-trigger-'));
    process.env.STIM_HOME = home;
    Object.assign(fixture, fresh());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test.each(cases)('for %s', async (_name, { before, after, marked }) => {
    before?.(home);
    const { serve } = await import('../src/cli.ts');
    const thread = await serve(
      {
        port: 7787,
        extraEnv: [],
        pathPrepend: [],
        loopbackOnly: false,
        shareOnly: false,
        desktopKey: Buffer.alloc(32, 7).toString('base64url'),
        script: 'unused',
      },
      () => {},
    );
    try {
      const tailnet = fixture.options[0]?.tailnet;
      const loads = Boolean(before || after);
      await after?.(home);
      await new Promise((done) => setTimeout(done, loads ? 0 : 200));
      await vi.waitFor(() => expect(tailnet?.current() !== null).toBe(loads), { timeout: 5000 });
      expect(fixture.created).toBe(loads ? 1 : 0);
      expect(existsSync(join(home, 'server', 'tailnet.json'))).toBe(marked);
    } finally {
      await thread.close();
    }
  });
});
