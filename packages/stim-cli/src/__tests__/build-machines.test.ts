import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSecret } from '@stim-cli/core/noise-session';
import { buildMachinesFile, deviceHostMachinesFile, readBuildMachines } from '@stim-cli/core/state';
import { resetExecutor, setExecutor } from '../exec.ts';
import { inspectBuildMachines, resolveEndpoint, type Endpoint } from '../offload/build-machines.ts';
import { findPeer, parseMachine, realIo, type HelloReply, type MachineAuth } from '../offload/tailnet.ts';
import { startProtocol1Server } from './_noise-server.ts';
import { getConfigPath } from '../workspace/config.ts';

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
      { machine: 'nope', state: 'not-on-tailnet' },
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
