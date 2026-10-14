import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import { hostingMachines, inspectDeviceHostMachines } from '../device-host/machines.ts';
import { inspectBuildMachines } from '../offload/build-machines.ts';
import type { Endpoint, HelloReply, MachineAuth, TailnetMachineIo } from '../offload/tailnet.ts';
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
      calls.push({ endpoint, auth });
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

test('one doctor --fix run prints one ticket for build and hosting, and both pin the key once setup approves', async () => {
  const tickets = new Map();
  const io = fakeIo([notYet, notYet]).io;
  const [build, host] = await Promise.all([
    inspectBuildMachines({ fix: true, tickets }, io, ['mini']),
    inspectDeviceHostMachines({ fix: true, tickets }, io, ['mini']),
  ]);
  const ticket = readDeviceHostMachines()[0]!.ticket!;
  expect(readBuildMachines()[0]!.ticket).toBe(ticket);
  expect(build.findings[0]!.fix).toContain('--build --device-host');
  expect(host.findings[0]!.fix).toContain(`STIM_SETUP_TICKET=${ticket}`);
  const built = { ...hosting(), result: { ...(hosting() as { result: object }).result, capabilities: ['build'] } };
  await inspectBuildMachines({ fix: false }, fakeIo([built as HelloReply]).io, ['mini']);
  const { io: after, calls } = fakeIo([notYet, hosting()]);
  expect((await inspectDeviceHostMachines({ fix: false }, after, ['mini'])).machines[0]?.state).toBe('approved');
  expect(calls.map((call) => call.auth)).toEqual([
    { access: 'device-host', ticket, name: 'laptop' },
    { access: 'device-host', serverKey: SERVER_KEY },
  ]);
});

test('fix never asks a peer Tailscale reports as running another OS than macOS, which cannot host', async () => {
  for (const os of ['linux', 'windows']) {
    const { io, calls } = fakeIo([notYet], os);
    const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
    expect(calls).toEqual([]);
    expect(result).toEqual({
      findings: [],
      machines: [{ machine: 'mini', dnsName: 'mini.tail1.ts.net', state: 'not-asked' }],
    });
    expect(readDeviceHostMachines()).toEqual([]);
  }
});

test('a saved approval for a peer reported as Linux is neither contacted nor reported', async () => {
  await approvedHosting();
  const { io, calls } = fakeIo([], 'linux');
  const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  expect(calls).toEqual([]);
  expect(result.findings).toEqual([]);
  expect(result.machines).toEqual([expect.objectContaining({ machine: 'mini', state: 'not-asked' })]);
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

test('only a definite refusal and fix make a new ticket', async () => {
  await approvedHosting();
  const { io, calls } = fakeIo([{ error: { code: 'unauthorized', message: 'revoked' } }, notYet]);
  expect((await inspectDeviceHostMachines({ fix: true }, io, ['mini'])).machines[0]?.state).toBe('pending');
  expect(calls.map((call) => Object.keys(call.auth).toSorted())).toEqual([
    ['access', 'serverKey'],
    ['access', 'name', 'ticket'],
  ]);
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
  const io: TailnetMachineIo = {
    status: () => status(),
    hello: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const first = inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  const second = await inspectDeviceHostMachines({ fix: true }, fakeIo([]).io, ['mini']);
  expect(second.machines[0]?.state).toBe('busy');
  release(notYet);
  expect((await first).machines[0]?.state).toBe('pending');
  expect(readDeviceHostMachines()).toHaveLength(1);
});

test('two aliases of the same worker route do not replace each other pending request', async () => {
  const { io, calls } = fakeIo([notYet]);
  const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini', 'mini.tail1.ts.net']);
  expect(result.machines.map((each) => each.state)).toEqual(['pending', 'invalid']);
  expect(calls).toHaveLength(1);
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

test.each([undefined, { name: 'Stim Host', screenRecording: true, accessibility: true }])(
  'approved entries expose host permissions only when reported, and granted ones add no note: %j',
  async (host) => {
    await approvedHosting();
    const result = await inspectDeviceHostMachines({ fix: false }, fakeIo([hosting(host)]).io, ['mini']);
    const [entry] = JSON.parse(JSON.stringify(result.machines));
    expect(entry.state).toBe('approved');
    expect(Object.hasOwn(entry, 'host')).toBe(!!host);
    expect(result.findings).toEqual([]);
  },
);

test('automatic hosting considers only the remote machines this machine asked for device-host access', async () => {
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini', 'other'] } }));
  expect(hostingMachines(() => status())).toEqual([]);
  await inspectDeviceHostMachines({ fix: true }, fakeIo([notYet]).io, ['mini']);
  expect(hostingMachines(() => status())).toEqual(['mini']);
  expect(hostingMachines(() => null)).toEqual(['mini']);
  for (const os of ['linux', 'windows']) expect(hostingMachines(() => status(os))).toEqual([]);
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: 'mini' } }));
  expect(hostingMachines(() => status())).toBeNull();
});
