import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import { hostingMachines, inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectBuildMachines } from '../offload/build-machines.ts';
import { realIo, type Endpoint, type HelloReply, type MachineAuth, type TailnetMachineIo } from '../offload/tailnet.ts';
import { startProtocol1Server } from './_noise-server.ts';
import { getConfigPath } from '../workspace/config.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-host-machines-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const SERVER_KEY = 'S'.repeat(42) + 'A';

function status(os?: string) {
  return {
    BackendState: 'Running',
    Self: { HostName: 'lap‍top' },
    Peer: {
      mini: { ID: 'nMini', DNSName: 'mini.tail1.ts.net.', TailscaleIPs: ['100.64.0.7'], ...(os ? { OS: os } : {}) },
    },
  };
}
const notYet: HelloReply = { error: { code: 'unknown-secret', message: 'not yet' } };
const hosting = (host?: { name: string; screenRecording: boolean; accessibility: boolean }): HelloReply => ({
  result: { capabilities: ['device-host'], device: { id: 'host12', name: 'laptop' }, ...(host ? { host } : {}) },
  serverKey: SERVER_KEY,
});
function fakeIo(replies: HelloReply[], os?: string) {
  const calls: { endpoint: Endpoint; auth: MachineAuth }[] = [];
  const io: TailnetMachineIo = {
    status: () => status(os),
    hello: (endpoint, auth) => {
      calls.push({
        endpoint,
        auth: 'ticket' in auth ? { access: auth.access, ticket: auth.ticket, name: auth.name } : auth,
      });
      return Promise.resolve(replies.shift() ?? { failed: 'no reply scripted' });
    },
  };
  return { io, calls };
}

async function approvedHosting() {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
  await inspectDeviceHostMachines({ fix: false }, fakeIo([hosting()]).io, ['mini']);
}

test('plain doctor does not ask for hosting; fix makes a ticket for the separate capability in a private file', async () => {
  const { io, calls } = fakeIo([notYet]);
  expect((await inspectDeviceHostMachines({ fix: false }, io, ['mini'])).machines).toEqual([
    { machine: 'mini', dnsName: 'mini.tail1.ts.net', state: 'not-asked' },
  ]);
  expect(calls).toEqual([]);
  const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  const [credential] = readDeviceHostMachines();
  expect(calls).toEqual([
    {
      endpoint: { url: 'wss://100.64.0.7:7443', servername: 'mini.tail1.ts.net', host: 'mini.tail1.ts.net:7443' },
      auth: { access: 'device-host', ticket: credential!.ticket, name: 'laptop' },
    },
  ]);
  expect(result.machines).toEqual([expect.objectContaining({ state: 'pending' })]);
  expect(result.findings[0]?.fix).toContain(`STIM_SETUP_TICKET=${credential!.ticket}`);
  expect(readBuildMachines()).toEqual([]);
  expect(statSync(deviceHostMachinesFile()).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
});

test('a protocol 1 worker reports outdated for build and hosting under one finding title, so doctor prints it once', async () => {
  const old = await startProtocol1Server();
  try {
    const io: TailnetMachineIo = {
      status: () => status(),
      hello: (_endpoint, auth) =>
        realIo.hello({ url: `ws://127.0.0.1:${old.port}`, servername: 'mini', host: `127.0.0.1:${old.port}` }, auth),
    };
    const tickets = new Map();
    const [build, host] = await Promise.all([
      inspectBuildMachines({ fix: true, version: '9.9.9', tickets }, io, ['mini']),
      inspectDeviceHostMachines({ fix: true, version: '9.9.9', tickets }, io, ['mini']),
    ]);
    expect(build.machines).toEqual([expect.objectContaining({ state: 'outdated' })]);
    expect(host.machines).toEqual([expect.objectContaining({ state: 'outdated' })]);
    expect(host.findings).toEqual(build.findings.map((finding) => expect.objectContaining({ title: finding.title })));
  } finally {
    await old.close();
  }
});

test('a worker that proves another key keeps the pin and gets no new ticket', async () => {
  await approvedHosting();
  vi.stubEnv('STIM_ACCESS_TICKET', 'n'.repeat(42) + 'A');
  const { io, calls } = fakeIo([{ error: { code: 'server-key-mismatch', message: 'another key' } }]);
  expect((await inspectDeviceHostMachines({ fix: true }, io, ['mini'])).machines[0]?.state).toBe('key-changed');
  expect(calls.map((call) => call.auth)).toEqual([{ access: 'device-host', serverKey: SERVER_KEY }]);
  expect(readDeviceHostMachines()[0]).toMatchObject({ state: 'approved', serverKey: SERVER_KEY });
});

test.each([{ machines: 'mini' }, { machines: ['mini', 42] }, { machines: null }, 'mini'])(
  'invalid remote settings preserve saved credentials without approval traffic: %j',
  async (remote) => {
    await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
    const saved = readFileSync(deviceHostMachinesFile(), 'utf8');
    writeFileSync(getConfigPath(), JSON.stringify({ remote }));
    const { io, calls } = fakeIo([]);
    const readStatus = vi.spyOn(io, 'status');
    for (const fix of [false, true]) {
      const result = await inspectDeviceHostMachines({ fix }, io);
      expect(result.findings).toEqual([expect.objectContaining({ title: 'Invalid remote.machines setting' })]);
      expect(readFileSync(deviceHostMachinesFile(), 'utf8')).toBe(saved);
    }
    expect(calls).toEqual([]);
    expect(readStatus).not.toHaveBeenCalled();
  },
);

test('a build-only grant, an uncertain answer and a revocation keep the hosting pin', async () => {
  await approvedHosting();
  const buildOnly = { ...hosting(), result: { ...(hosting() as { result: object }).result, capabilities: ['build'] } };
  const { io, calls } = fakeIo([
    buildOnly as HelloReply,
    { failed: 'connection reset' },
    { error: { code: 'unauthorized', message: 'revoked' } },
  ]);
  const states: string[] = [];
  for (let i = 0; i < 3; i++)
    states.push((await inspectDeviceHostMachines({ fix: false }, io, ['mini'])).machines[0]!.state);
  expect(states).toEqual(['revoked', 'unreachable', 'revoked']);
  expect(calls).toHaveLength(3);
  expect(readDeviceHostMachines()[0]).toMatchObject({ state: 'approved', serverKey: SERVER_KEY });
});

test.each(['{"version":2,"machines":[{"ticket":"private"}]}', '{bad', '{"version":2,"machines":null}'])(
  'malformed credentials are retained and block all approval traffic: %s',
  async (text) => {
    writeFileSync(deviceHostMachinesFile(), text);
    const { io, calls } = fakeIo([]);
    const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
    expect(result.machines[0]?.state).toBe('credentials-unavailable');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(readFileSync(deviceHostMachinesFile(), 'utf8')).toBe(text);
    expect(calls).toEqual([]);
  },
);

test('a protocol 1 credential store reads as empty, so --fix asks again', async () => {
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({ version: 1, machines: [{ machine: 'mini', nodeId: 'nMini', deviceToken: 'old' }] }),
  );
  expect(readDeviceHostMachines()).toEqual([]);
  const { io, calls } = fakeIo([notYet]);
  await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  expect(calls[0]!.auth).toHaveProperty('ticket');
});

test('forgetting a configured machine is explicit and does not touch build credentials', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
  await inspectDeviceHostMachines({ fix: false }, fakeIo([]).io, []);
  expect(readDeviceHostMachines()).toHaveLength(1);
  await inspectDeviceHostMachines({ fix: true }, fakeIo([]).io, []);
  expect(readDeviceHostMachines()).toEqual([]);
});

test('concurrent doctors cannot replace a pending ticket before the first credentials settle', async () => {
  let release!: (reply: HelloReply) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const io: TailnetMachineIo = {
    status: () => status(),
    hello: () =>
      new Promise((resolve) => {
        release = resolve;
        ready();
      }),
  };
  const first = inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  await started;
  const second = await inspectDeviceHostMachines({ fix: true }, fakeIo([]).io, ['mini']);
  expect(second.machines[0]?.state).toBe('busy');
  release(notYet);
  expect((await first).machines[0]?.state).toBe('pending');
  expect(readDeviceHostMachines()).toHaveLength(1);
});

test('unconfigured hosting makes doctor fix a no-op without taking a process claim', async () => {
  const { io, calls } = fakeIo([]);
  expect(await inspectDeviceHostMachines({ fix: true }, io, [])).toEqual({ findings: [], machines: [] });
  expect(calls).toEqual([]);
  expect(readdirSync(home)).toEqual([]);
});

test('missing hosting grants produce a note without changing approval', async () => {
  await approvedHosting();
  const result = await inspectDeviceHostMachines(
    { fix: false },
    fakeIo([hosting({ name: 'Stim Host Dev', screenRecording: false, accessibility: false })]).io,
    ['mini'],
  );
  expect(result.machines[0]?.state).toBe('approved');
  expect(result.findings).toHaveLength(1);
  const [finding] = result.findings;
  expect(finding).toMatchObject({ code: 'device-host-machine', level: 'note' });
  expect(finding?.title).toMatch(
    /mini.*Screen & System Audio Recording.*Device Control and Data Access.*Stim Host Dev/,
  );
  expect(finding?.fix).toContain('stim-server service install');
});

test('automatic hosting considers only the remote machines this machine asked for device-host access', async () => {
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini', 'other'] } }));
  expect(await hostingMachines(() => status())).toEqual([]);
  await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
  expect(await hostingMachines(() => status())).toEqual(['mini']);
  expect(await hostingMachines(() => null)).toEqual(['mini']);
  for (const os of ['linux', 'windows']) expect(await hostingMachines(async () => status(os))).toEqual([]);
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: 'mini' } }));
  expect(await hostingMachines(() => status())).toBeNull();
});

test('a local network machine asks for hosting without Tailscale and pins its key only once a person confirms it', async () => {
  const LAN = 'local:10.0.0.92';
  const noTailscale = (replies: HelloReply[]) => {
    const fake = fakeIo(replies);
    fake.io.status = () => {
      throw new Error('a local network machine must not read tailscale status');
    };
    return fake;
  };
  const first = await inspectDeviceHostMachines({ fix: true }, noTailscale([notYet]).io, [LAN]);
  expect(first.machines).toEqual([expect.objectContaining({ machine: LAN, state: 'pending' })]);
  const asked: string[] = [];
  const confirmKey = (answer: boolean) => async (_machine: string, key: string) => {
    asked.push(key);
    return answer;
  };
  const declined = await inspectDeviceHostMachines(
    { fix: true, confirmKey: confirmKey(false) },
    noTailscale([hosting()]).io,
    [LAN],
  );
  expect(declined.machines).toEqual([expect.objectContaining({ state: 'key-unconfirmed' })]);
  expect(readDeviceHostMachines()[0]).not.toHaveProperty('serverKey');
  const accepted = await inspectDeviceHostMachines(
    { fix: true, confirmKey: confirmKey(true) },
    noTailscale([hosting()]).io,
    [LAN],
  );
  expect(accepted.machines).toEqual([expect.objectContaining({ state: 'approved' })]);
  expect(readDeviceHostMachines()[0]).toMatchObject({ transport: 'local', serverKey: SERVER_KEY });
  expect(asked).toEqual([SERVER_KEY, SERVER_KEY]);
});
