import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSecret } from '@stim-cli/core/noise-session';
import { buildMachinesFile, deviceHostMachinesFile, readBuildMachines } from '@stim-cli/core/state';
import { resetExecutor, setExecutor } from '../exec.ts';
import { inspectBuildMachines, resolveEndpoint, type Endpoint } from '../offload/build-machines.ts';
import { findPeer, parseMachine, realIo, type HelloReply, type MachineAuth } from '../offload/tailnet.ts';
import { startProtocol1Server } from './_noise-server.ts';
import { createServer, type Server } from 'node:http';
import type { PeerStartup } from '../offload/diagnosis.ts';
import { getConfigPath } from '../workspace/config.ts';

function listenPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening');
  return address.port;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-machines-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const SERVER_KEY = 'S'.repeat(42) + 'A';
const OTHER_KEY = 'O'.repeat(42) + 'A';
const DESKTOP_TICKET = 'd'.repeat(42) + 'A';

function status(os = 'macOS', dnsName = 'mini.tail1.ts.net.') {
  return {
    BackendState: 'Running',
    Self: { ID: 'nLaptop', HostName: 'lap‍top', DNSName: 'laptop.tail1.ts.net.' },
    Peer: {
      key1: { ID: 'nMini', DNSName: dnsName, TailscaleIPs: ['fd7a::1', '100.64.0.7'], OS: os },
      key2: { ID: 'nFunnel', DNSName: '' },
      key3: { ID: 'nOther', DNSName: 'minimal.tail1.ts.net.', TailscaleIPs: ['100.64.0.8'] },
    },
  };
}

function fakeIo(replies: HelloReply[], os = 'macOS') {
  const calls: { endpoint: Endpoint; auth: MachineAuth }[] = [];
  const io = {
    status: () => status(os),
    hello: (endpoint: Endpoint, auth: MachineAuth) => {
      calls.push({
        endpoint,
        auth: 'ticket' in auth ? { access: auth.access, ticket: auth.ticket, name: auth.name } : auth,
      });
      return Promise.resolve(replies.shift() ?? { failed: 'no reply scripted' });
    },
  };
  return { io, calls };
}

const notYet: HelloReply = { error: { code: 'unknown-secret', message: 'The machine does not know this ticket yet.' } };
const approved = (host?: { name: string; screenRecording: boolean; accessibility: boolean }): HelloReply => ({
  result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' }, ...(host ? { host } : {}) },
  serverKey: SERVER_KEY,
});
const refused: HelloReply = { error: { code: 'unauthorized', message: 'Pair again.' } };

/** Asks with --fix while the worker has not run setup, leaving a pending credential with a generated ticket. */
async function askedPending() {
  return inspectBuildMachines({ fix: true, version: '9.9.9' }, fakeIo([notYet]).io, ['mini']);
}

async function approvedCredential() {
  await askedPending();
  await inspectBuildMachines({ fix: false }, fakeIo([approved()]).io, ['mini']);
}

test('resolveEndpoint reads tailscale status without blocking the event loop, falling back to the Mac app binary', async () => {
  const asked: string[] = [];
  setExecutor({
    runFile: () => {
      throw new Error('runFile must not be used');
    },
    runFileQuiet: () => {
      throw new Error('runFileQuiet blocks the event loop');
    },
    runFileAsync: async (file: string) => {
      asked.push(file);
      if (file === 'tailscale') throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(status());
    },
  });
  expect(await resolveEndpoint({ machine: 'mini' })).toEqual({
    url: 'wss://100.64.0.7:7443',
    servername: 'mini.tail1.ts.net',
    host: 'mini.tail1.ts.net:7443',
  });
  expect(asked).toEqual(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
});

describe('findPeer', () => {
  it('matches a MagicDNS name or its first label, and only one peer', () => {
    const mini = { nodeId: 'nMini', dnsName: 'mini.tail1.ts.net', address: '100.64.0.7', os: 'macOS' };
    expect(findPeer(status(), 'mini')).toEqual(mini);
    expect(findPeer(status(), 'mini.tail1.ts.net')).toEqual(mini);
    expect(findPeer(status(), 'nope')).toBe('missing');
    expect(findPeer(status('macOS', 'minimal.tail1.ts.net.'), 'minimal')).toBe('ambiguous');
    expect(parseMachine('Mini:7444')).toEqual({ name: 'mini', port: 7444 });
    expect(parseMachine('mini;rm')).toBeNull();
  });
});

describe('inspectBuildMachines', () => {
  it('--fix makes a setup ticket, tries it, and prints the setup command while the worker has not approved', async () => {
    const { io, calls } = fakeIo([notYet]);
    const { findings, machines } = await inspectBuildMachines({ fix: true, version: '9.9.9' }, io, ['mini']);
    const [credential] = readBuildMachines();
    expect(credential).toMatchObject({ machine: 'mini', state: 'pending', address: 'mini.tail1.ts.net' });
    expect(decodeSecret(credential!.ticket!)).toHaveLength(32);
    expect(Date.parse(credential!.expiresAt!) - Date.now()).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(calls).toEqual([
      {
        endpoint: { url: 'wss://100.64.0.7:7443', servername: 'mini.tail1.ts.net', host: 'mini.tail1.ts.net:7443' },
        auth: { access: 'build', ticket: credential!.ticket, name: 'laptop' },
      },
    ]);
    expect(machines).toEqual([
      expect.objectContaining({ machine: 'mini', state: 'pending', expiresAt: credential!.expiresAt }),
    ]);
    expect(findings[0]!.fix).toContain(
      `STIM_SETUP_TICKET=${credential!.ticket} STIM_SETUP_ORIGIN=doctor npx --yes --package @stim-cli/server@9.9.9 stim-server setup --expires ${credential!.expiresAt} --build --device-host`,
    );
  });

  it('asks a machine that cannot host for builds only', async () => {
    const { findings } = await inspectBuildMachines({ fix: true }, fakeIo([notYet], 'linux').io, ['mini']);
    expect(findings[0]?.fix).toContain('--build');
    expect(findings[0]?.fix).not.toContain('--device-host');
  });

  it('plain doctor never asks a machine it holds no credential for', async () => {
    const { io, calls } = fakeIo([]);
    const { machines } = await inspectBuildMachines({ fix: false }, io, ['mini', 'nope', 'bad;name']);
    expect(machines).toEqual([
      { machine: 'mini', state: 'not-asked', dnsName: 'mini.tail1.ts.net' },
      { machine: 'nope', state: 'not-on-tailnet', diagnosis: expect.objectContaining({ code: 'peer-not-found' }) },
      { machine: 'bad;name', state: 'invalid' },
    ]);
    expect(calls).toEqual([]);
  });

  it('pins the server key once setup approved the ticket, and drops the ticket', async () => {
    await askedPending();
    const ticket = readBuildMachines()[0]!.ticket;
    const { io, calls } = fakeIo([approved()]);
    expect(await inspectBuildMachines({ fix: false }, io, ['mini'])).toEqual({
      findings: [],
      machines: [expect.objectContaining({ machine: 'mini', state: 'approved', deviceId: 'ab12' })],
    });
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', ticket, name: 'laptop' }]);
    const [credential] = readBuildMachines();
    expect(credential).toMatchObject({ state: 'approved', serverKey: SERVER_KEY, deviceId: 'ab12' });
    expect(credential).not.toHaveProperty('ticket');
    expect(readFileSync(buildMachinesFile(), 'utf8')).not.toContain(ticket!);
  });

  it('saves the server key the ticket authenticated before hello, and resumes with it after a lost reply', async () => {
    await askedPending();
    const ticket = readBuildMachines()[0]!.ticket!;
    const lost = fakeIo([]);
    lost.io.hello = async (_endpoint, auth) => {
      if ('onServerKey' in auth) await auth.onServerKey?.(SERVER_KEY);
      return { failed: 'the connection closed before a hello result' };
    };
    expect((await inspectBuildMachines({ fix: false }, lost.io, ['mini'])).machines[0]!.state).toBe('unreachable');
    expect(readBuildMachines()[0]).toMatchObject({ state: 'pending', ticket, serverKey: SERVER_KEY });
    const { io, calls } = fakeIo([approved()]);
    expect((await inspectBuildMachines({ fix: false }, io, ['mini'])).machines[0]!.state).toBe('approved');
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
  });

  it('connects an approved machine only with its pinned key, and keeps the pin when another key answers', async () => {
    await approvedCredential();
    const { io, calls } = fakeIo([{ error: { code: 'server-key-mismatch', message: 'another key' } }]);
    const { findings, machines } = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
    expect(machines).toEqual([expect.objectContaining({ state: 'key-changed' })]);
    expect(findings[0]!.title).toBe('Remote machine mini answered with a different server key');
    expect(readBuildMachines()[0]!.serverKey).toBe(SERVER_KEY);
  });

  describe('a worker that still runs a protocol 1 stim-server', () => {
    let old: Awaited<ReturnType<typeof startProtocol1Server>>;
    beforeEach(async () => {
      old = await startProtocol1Server();
    });
    afterEach(() => old.close());
    const io = () => ({
      status: () => status(),
      hello: (_endpoint: Endpoint, auth: MachineAuth) =>
        realIo.hello({ url: `ws://127.0.0.1:${old.port}`, servername: 'mini', host: `127.0.0.1:${old.port}` }, auth),
    });

    it('--fix reports it outdated with the update and setup commands, and keeps the ticket for after the update', async () => {
      const { findings, machines } = await inspectBuildMachines({ fix: true, version: '9.9.9' }, io(), ['mini']);
      const [credential] = readBuildMachines();
      expect(credential).toMatchObject({ state: 'pending' });
      expect(machines).toEqual([expect.objectContaining({ state: 'outdated' })]);
      expect(findings).toEqual([
        expect.objectContaining({
          title: 'Remote machine mini runs an older stim-server',
          fix: expect.stringMatching(
            /^On mini, run `stim-server service update --release 9\.9\.9` \(.*\), then run this there to approve this machine: STIM_SETUP_TICKET=\S+ STIM_SETUP_ORIGIN=doctor npx --yes --package @stim-cli\/server@9\.9\.9 stim-server setup /,
          ),
        }),
      ]);
      expect(findings[0]?.fix).toContain(`STIM_SETUP_TICKET=${credential?.ticket} `);
      const { io: updated, calls } = fakeIo([notYet]);
      const after = await inspectBuildMachines({ fix: true, version: '9.9.9' }, updated, ['mini']);
      expect(after.machines).toEqual([expect.objectContaining({ state: 'pending' })]);
      expect(calls).toEqual([
        expect.objectContaining({ auth: expect.objectContaining({ ticket: credential?.ticket }) }),
      ]);
    });

    it('reports an approved machine outdated without a setup command, and keeps its pinned key', async () => {
      await approvedCredential();
      const before = readBuildMachines();
      const { findings, machines } = await inspectBuildMachines({ fix: true, version: '9.9.9' }, io(), ['mini']);
      expect(machines).toEqual([expect.objectContaining({ state: 'outdated' })]);
      expect(findings).toEqual([
        expect.objectContaining({
          fix: expect.stringMatching(
            /^On mini, run `stim-server service update --release 9\.9\.9` \(add `--label <name>` for a custom service label; .*\), then run `stim doctor --fix` here\.$/,
          ),
        }),
      ]);
      expect(readBuildMachines()).toEqual(before);
    });

    it('still reports a machine that does not answer as unreachable', async () => {
      await approvedCredential();
      await old.close();
      const { machines } = await inspectBuildMachines({ fix: false }, io(), ['mini']);
      expect(machines).toEqual([expect.objectContaining({ state: 'unreachable' })]);
    });
  });

  describe('naming the layer an unreachable machine stopped at', () => {
    let upstream: Server;
    let upstreamPort: number;
    let upstreamStatus = 502;
    beforeEach(async () => {
      upstream = createServer((_request, response) => response.writeHead(426).end());
      upstream.on('upgrade', (_request, socket) => {
        socket.end(`HTTP/1.1 ${upstreamStatus} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      });
      await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
      upstreamPort = listenPort(upstream);
    });
    afterEach(() => new Promise<void>((done) => upstream.close(() => done())));

    const realConnection = (extra: Record<string, unknown> = {}) => ({
      status: () => status(),
      hello: (_endpoint: Endpoint, auth: MachineAuth) =>
        realIo.hello(
          { url: `ws://127.0.0.1:${upstreamPort}`, servername: 'mini', host: `127.0.0.1:${upstreamPort}` },
          auth,
        ),
      ...extra,
    });

    it('says stim-server is not running when the serve route answers 502', async () => {
      await approvedCredential();
      upstreamStatus = 502;
      const { findings, machines } = await inspectBuildMachines({ fix: false }, realConnection(), ['mini']);
      expect(machines).toEqual([
        expect.objectContaining({
          state: 'unreachable',
          diagnosis: expect.objectContaining({ layer: 'server', code: 'server-not-running' }),
        }),
      ]);
      expect(findings).toHaveLength(1);
    });

    it('says stim-server is not ready, with the cause its /health gives, on a 503', async () => {
      await approvedCredential();
      upstreamStatus = 503;
      const startup = async (): Promise<PeerStartup | null> => ({ state: 'degraded', cause: 'home-unreadable' });
      const withCause = await inspectBuildMachines({ fix: false }, realConnection({ startup }), ['mini']);
      const without = await inspectBuildMachines({ fix: false }, realConnection({ startup: async () => null }), [
        'mini',
      ]);
      const [reported] = withCause.machines;
      expect(reported).toMatchObject({
        state: 'unreachable',
        diagnosis: { layer: 'server', code: 'server-not-ready' },
      });
      expect(reported?.diagnosis?.message).not.toBe(without.machines[0]?.diagnosis?.message);
    });

    it('still names a 503 from a stim-server whose /health says nothing', async () => {
      await approvedCredential();
      upstreamStatus = 503;
      const { machines } = await inspectBuildMachines({ fix: false }, realConnection({ startup: async () => null }), [
        'mini',
      ]);
      expect(machines).toEqual([
        expect.objectContaining({ diagnosis: expect.objectContaining({ code: 'server-not-ready' }) }),
      ]);
    });

    it('says the route is missing when nothing accepts connections on the port', async () => {
      await approvedCredential();
      await new Promise<void>((done) => upstream.close(() => done()));
      upstream = createServer();
      const { machines } = await inspectBuildMachines({ fix: false }, realConnection(), ['mini']);
      expect(machines).toEqual([
        expect.objectContaining({ diagnosis: expect.objectContaining({ layer: 'route', code: 'route-missing' }) }),
      ]);
    });

    it('names an offline peer, with when it was last seen, before the connection', async () => {
      await approvedCredential();
      const offline = status();
      Object.assign(offline.Peer.key1, { Online: false, LastSeen: new Date(Date.now() - 3 * 3_600_000).toISOString() });
      const { machines } = await inspectBuildMachines(
        { fix: false },
        { ...fakeIo([{ failed: 'no reply in time', transport: { kind: 'silent' } }]).io, status: () => offline },
        ['mini'],
      );
      expect(machines).toEqual([
        expect.objectContaining({
          diagnosis: expect.objectContaining({
            layer: 'peer',
            code: 'peer-offline',
            message: expect.stringContaining('3 h ago'),
          }),
        }),
      ]);
    });

    it('names a silent route behind a Mac that answers tailscale ping as stim-server not answering', async () => {
      await approvedCredential();
      const { machines } = await inspectBuildMachines(
        { fix: false },
        {
          ...fakeIo([{ failed: 'no reply in time', transport: { kind: 'silent' } }]).io,
          ping: async () => true,
        },
        ['mini'],
      );
      expect(machines).toEqual([
        expect.objectContaining({ diagnosis: expect.objectContaining({ code: 'server-no-answer' }) }),
      ]);
    });

    it('names an online peer that does not answer', async () => {
      await approvedCredential();
      const online = status();
      Object.assign(online.Peer.key1, { Online: true });
      const { machines } = await inspectBuildMachines(
        { fix: false },
        { ...fakeIo([{ failed: 'no reply in time', transport: { kind: 'silent' } }]).io, status: () => online },
        ['mini'],
      );
      expect(machines).toEqual([
        expect.objectContaining({
          diagnosis: expect.objectContaining({ code: 'peer-no-answer' }),
        }),
      ]);
    });

    it.each([
      ['NeedsLogin', 'tailscale-logged-out'],
      ['Stopped', 'tailscale-stopped'],
      [null, 'tailscale-unavailable'],
    ])('tells Tailscale %s apart from the peer and the server', async (backendState, code) => {
      const { findings, machines } = await inspectBuildMachines(
        { fix: false },
        {
          ...fakeIo([]).io,
          status: () => null,
          rawStatus: () => (backendState === null ? null : { BackendState: backendState }),
        },
        ['mini'],
      );
      expect(machines).toEqual([
        { machine: 'mini', state: 'tailscale-off', diagnosis: expect.objectContaining({ layer: 'tailscale', code }) },
      ]);
      expect(findings).toHaveLength(1);
    });
  });

  it('reports a revoked machine, and --fix makes a new ticket for it', async () => {
    await approvedCredential();
    const revoked = await inspectBuildMachines({ fix: false }, fakeIo([refused]).io, ['mini']);
    expect(revoked.machines).toEqual([expect.objectContaining({ state: 'revoked', deviceId: 'ab12' })]);
    expect(readBuildMachines()[0]!.state).toBe('approved');
    const { io, calls } = fakeIo([refused, notYet]);
    const asked = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(asked.machines).toEqual([expect.objectContaining({ state: 'pending' })]);
    expect(calls[1]!.auth).toMatchObject({ access: 'build', ticket: readBuildMachines()[0]!.ticket });
  });

  it('reports a generated ticket past its expiry as lapsed without contacting the machine, and --fix makes a new one', async () => {
    await askedPending();
    const file = buildMachinesFile();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { machines: Record<string, unknown>[] };
    const old = stored.machines[0]!.ticket;
    stored.machines[0]!.expiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(file, JSON.stringify(stored));
    const { io, calls } = fakeIo([]);
    const { machines, findings } = await inspectBuildMachines({ fix: false }, io, ['mini']);
    expect(machines).toEqual([expect.objectContaining({ state: 'lapsed' })]);
    expect(findings[0]!.fix).toContain('stim doctor --fix');
    expect(calls).toEqual([]);
    await inspectBuildMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
    expect(readBuildMachines()[0]!.ticket).not.toBe(old);
  });

  it("uses Stim Desktop's ticket from STIM_ACCESS_TICKET, without printing a command for it", async () => {
    vi.stubEnv('STIM_ACCESS_TICKET', `  ${DESKTOP_TICKET}  `);
    const { io, calls } = fakeIo([notYet]);
    const { findings } = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls[0]!.auth).toEqual({ access: 'build', ticket: DESKTOP_TICKET, name: 'laptop' });
    expect(readBuildMachines()[0]).toMatchObject({ state: 'pending', ticket: DESKTOP_TICKET });
    expect(readBuildMachines()[0]).not.toHaveProperty('expiresAt');
    expect(findings[0]!.fix).not.toContain(DESKTOP_TICKET);
  });

  it.each([
    ['--fix with another Desktop ticket replaces the pending one', true, 'e'.repeat(42) + 'A', 'e'.repeat(42) + 'A'],
    ['plain doctor keeps the pending ticket', false, 'e'.repeat(42) + 'A', DESKTOP_TICKET],
    ['--fix without a Desktop ticket keeps the pending one', true, undefined, DESKTOP_TICKET],
  ])('%s', async (_name, fix, current, sent) => {
    vi.stubEnv('STIM_ACCESS_TICKET', DESKTOP_TICKET);
    await inspectBuildMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
    vi.stubEnv('STIM_ACCESS_TICKET', current);
    const { io, calls } = fakeIo([notYet]);
    await inspectBuildMachines({ fix }, io, ['mini']);
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', ticket: sent, name: 'laptop' }]);
    expect(readBuildMachines()[0]!.ticket).toBe(sent);
  });

  it('an approved credential ignores a new Desktop ticket', async () => {
    await approvedCredential();
    vi.stubEnv('STIM_ACCESS_TICKET', DESKTOP_TICKET);
    const { io, calls } = fakeIo([approved()]);
    await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls.map((call) => call.auth)).toEqual([{ access: 'build', serverKey: SERVER_KEY }]);
  });

  it("falls back to the device-host approval's pinned key when the shared ticket was already spent", async () => {
    await askedPending();
    writeFileSync(
      deviceHostMachinesFile(),
      JSON.stringify({
        version: 2,
        machines: [
          {
            machine: 'mini',
            transport: 'tailscale',
            address: 'mini.tail1.ts.net',
            state: 'approved',
            requestedAt: '2026-10-13T00:00:00.000Z',
            serverKey: OTHER_KEY,
            deviceId: 'cd34',
          },
        ],
      }),
    );
    const { io, calls } = fakeIo([notYet, { ...approved(), serverKey: OTHER_KEY } as HelloReply]);
    const { machines } = await inspectBuildMachines({ fix: false }, io, ['mini']);
    expect(calls[1]!.auth).toEqual({ access: 'build', serverKey: OTHER_KEY });
    expect(machines).toEqual([expect.objectContaining({ state: 'approved' })]);
    expect(readBuildMachines()[0]).toMatchObject({ state: 'approved', serverKey: OTHER_KEY, deviceId: 'ab12' });
  });

  it('reports every reason an approved machine would not take the build, with a remedy for each', async () => {
    await approvedCredential();
    const host = { name: 'Stim Host', screenRecording: true, accessibility: false };
    const checked: (string | undefined)[] = [];
    const { findings, machines } = await inspectBuildMachines(
      {
        fix: false,
        check: (credential) => {
          checked.push(credential.serverKey);
          return Promise.resolve({
            capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
            problems: [
              { code: 'stim-build', reason: 'Stim build 6bbe there, e774 here' },
              { code: 'busy', reason: 'busy (load at or above 2/core; load 8.2/core, 2 builds)' },
            ],
          });
        },
      },
      fakeIo([approved(host)]).io,
      ['mini'],
    );
    expect(checked).toEqual([SERVER_KEY]);
    expect(machines).toEqual([
      expect.objectContaining({
        state: 'approved',
        host,
        offloadable: false,
        reasons: ['Stim build 6bbe there, e774 here', 'busy (load at or above 2/core; load 8.2/core, 2 builds)'],
        capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
      }),
    ]);
    expect(findings.map(({ code, level }) => ({ code, level }))).toEqual([
      { code: 'build-machine-stim-build', level: 'cost' },
      { code: 'build-machine-busy', level: 'note' },
    ]);
    expect(findings[0]!.fix).toContain('run `stim-server service update --release <version>`');
  });

  it('says what remote-only does with a machine that cannot take the build, where other placements fall back to this machine', async () => {
    await approvedCredential();
    const detail = async () => {
      const { findings } = await inspectBuildMachines(
        {
          fix: false,
          check: () =>
            Promise.resolve({ capacity: null, problems: [{ code: 'stim-build', reason: 'Stim build 6bbe there' }] }),
        },
        fakeIo([approved()]).io,
        ['mini'],
      );
      return findings[0]?.detail;
    };
    expect(await detail()).toContain('Builds fall back to this machine');
    writeFileSync(getConfigPath(), JSON.stringify({ remote: { build: 'remote-only', machines: ['mini'] } }));
    const remoteOnly = await detail();
    expect(remoteOnly).toContain('remote-only');
    expect(remoteOnly).toContain('refuse');
    expect(remoteOnly).not.toContain('fall back');
  });

  it('reports a package Gradle downloads as a note that does not stop the build, and a blocker with commands otherwise', async () => {
    await approvedCredential();
    const note = {
      code: 'ndk' as const,
      reason: 'NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)',
    };
    const blocker = {
      code: 'build-tools' as const,
      reason: 'no build-tools 37.0.0 there, and its SDK licenses are not accepted',
      lead: 'accept the SDK licenses so Gradle downloads the package, or install it',
      commands: [
        '/sdk/cmdline-tools/latest/bin/sdkmanager --licenses',
        '/sdk/cmdline-tools/latest/bin/sdkmanager "build-tools;37.0.0"',
      ],
    };
    const run = (problems: (typeof blocker)[], notes: (typeof note)[]) =>
      inspectBuildMachines(
        { fix: false, check: () => Promise.resolve({ capacity: null, problems, notes }) },
        fakeIo([approved()]).io,
        ['mini'],
      );
    const taken = await run([], [note]);
    expect(taken.machines).toEqual([expect.objectContaining({ offloadable: true, reasons: [], notes: [note] })]);
    expect(taken.findings).toEqual([
      expect.objectContaining({
        code: 'build-machine-ndk',
        level: 'note',
        detail: `The build goes there anyway: ${note.reason}.`,
        fix: null,
      }),
    ]);
    const blocked = await run([blocker], []);
    expect(blocked.machines).toEqual([expect.objectContaining({ offloadable: false, reasons: [blocker.reason] })]);
    expect(blocked.findings).toEqual([
      expect.objectContaining({
        code: 'build-machine-build-tools',
        level: 'cost',
        fix: [
          'On mini, accept the SDK licenses so Gradle downloads the package, or install it:',
          ...blocker.commands,
        ].join('\n'),
      }),
    ]);
  });

  it('fixes a JDK mismatch with an install command, and a stim-server that lists no JDKs with the JAVA_HOME restart', async () => {
    await approvedCredential();
    const run = (problem: { code: 'jdk'; reason: string; commands?: string[]; lead?: string }) =>
      inspectBuildMachines(
        { fix: false, check: () => Promise.resolve({ capacity: null, problems: [problem] }) },
        fakeIo([approved()]).io,
        ['mini'],
      );
    const listed = await run({
      code: 'jdk',
      reason: 'JDK 25 there, 17 here',
      commands: ['brew install --cask zulu@17'],
      lead: 'install JDK 17; Stim uses it automatically, no restart needed',
    });
    expect(listed.findings[0]?.fix).toBe(
      'On mini, install JDK 17; Stim uses it automatically, no restart needed:\nbrew install --cask zulu@17',
    );
    const old = await run({ code: 'jdk', reason: 'JDK 25 there, 17 here' });
    expect(old.findings[0]?.fix).toBe(
      "Start stim-server on mini with JAVA_HOME at a JDK of the same major version as this machine's.",
    );
  });

  it('gives the install command of a missing CocoaPods as the fix', async () => {
    await approvedCredential();
    const { findings } = await inspectBuildMachines(
      {
        fix: false,
        check: () =>
          Promise.resolve({
            capacity: null,
            problems: [
              {
                code: 'cocoapods',
                reason: 'no CocoaPods there, CocoaPods 1.16.2 here',
                commands: ['brew install cocoapods'],
                lead: 'install CocoaPods',
              },
            ],
          }),
      },
      fakeIo([approved()]).io,
      ['mini'],
    );
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'build-machine-cocoapods',
        fix: 'On mini, install CocoaPods:\nbrew install cocoapods',
      }),
    ]);
  });

  it('fixes a deselected Xcode with the exact command, and a runtime that follows from it with a pointer', async () => {
    await approvedCredential();
    const { findings } = await inspectBuildMachines(
      {
        fix: false,
        check: () =>
          Promise.resolve({
            capacity: null,
            problems: [
              {
                code: 'xcode',
                reason: 'no Xcode there: xcode-select points at Command Line Tools',
                commands: ['sudo xcode-select -s /Applications/Xcode-27.1.app/Contents/Developer'],
                lead: 'select Xcode-27.1',
              },
              { code: 'runtime', reason: 'no iPhone simulator on iOS-27-0 there', followsFrom: 'xcode' },
              {
                code: 'cocoapods',
                reason: 'CocoaPods 1.17.0 there, 1.16.2 here',
              },
            ],
          }),
      },
      fakeIo([approved()]).io,
      ['mini'],
    );
    expect(findings.map(({ code, fix }) => ({ code, fix }))).toEqual([
      {
        code: 'build-machine-xcode',
        fix: 'On mini, select Xcode-27.1:\nsudo xcode-select -s /Applications/Xcode-27.1.app/Contents/Developer',
      },
      { code: 'build-machine-runtime', fix: 'Fix the xcode problem on mini first; this follows from it.' },
      expect.objectContaining({ code: 'build-machine-cocoapods' }),
    ]);
  });

  it.each([undefined, null, { name: 'Stim Host', screenRecording: false, accessibility: true }])(
    'approved entries expose host permissions only when reported: %j',
    async (host) => {
      await approvedCredential();
      const reply = {
        result: {
          capabilities: ['build'],
          device: { id: 'ab12', name: 'laptop' },
          ...(host !== undefined ? { host } : {}),
        },
        serverKey: SERVER_KEY,
      } as HelloReply;
      const result = await inspectBuildMachines({ fix: false }, fakeIo([reply]).io, ['mini']);
      const [entry] = JSON.parse(JSON.stringify(result.machines));
      expect(entry.state).toBe('approved');
      expect(Object.hasOwn(entry, 'host')).toBe(!!host);
    },
  );

  it('forgets the pairing of a machine no longer named, with --fix only', async () => {
    await askedPending();
    await inspectBuildMachines({ fix: false }, fakeIo([]).io, []);
    expect(readBuildMachines()).toHaveLength(1);
    await inspectBuildMachines({ fix: true }, fakeIo([]).io, []);
    expect(readBuildMachines()).toEqual([]);
  });

  it('does not read a protocol 1 credential, which pinned a tailnet node and held a device token', () => {
    writeFileSync(
      buildMachinesFile(),
      JSON.stringify({
        version: 1,
        machines: [
          {
            machine: 'mini',
            nodeId: 'nMini',
            dnsName: 'mini',
            deviceId: 'ab12',
            deviceToken: 't',
            state: 'approved',
            requestedAt: 'x',
          },
        ],
      }),
    );
    expect(readBuildMachines()).toEqual([]);
  });
});

it.each([{ machines: 'mini' }, { machines: ['mini', 42] }, 'mini'])(
  'doctor --fix keeps saved credentials when remote is invalid: %j',
  async (remote) => {
    await askedPending();
    const saved = readFileSync(buildMachinesFile(), 'utf8');
    writeFileSync(getConfigPath(), JSON.stringify({ remote }));
    const { io, calls } = fakeIo([]);
    const result = await inspectBuildMachines({ fix: true }, io);
    expect(result.findings).toEqual([expect.objectContaining({ title: 'Invalid remote.machines setting' })]);
    expect(readFileSync(buildMachinesFile(), 'utf8')).toBe(saved);
    expect(calls).toEqual([]);
  },
);
