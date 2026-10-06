import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, readBuildMachines, readDeviceHostMachines } from '@stim-cli/core/state';
import { inspectDeviceHostMachines } from '../device-host/machines.ts';
import type { Endpoint, HelloReply, TailnetMachineIo } from '../offload/tailnet.ts';
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

function status(nodeId = 'nMini') {
  return {
    Self: { HostName: 'lap\u200dtop' },
    Peer: { mini: { ID: nodeId, DNSName: 'mini.tail1.ts.net.', TailscaleIPs: ['100.64.0.7'] } },
  };
}
const pending: HelloReply = {
  result: {
    capabilities: [],
    device: { id: 'host12', name: 'laptop' },
    deviceToken: 'hosting-secret',
    approval: { state: 'pending', expiresAt: '2026-10-03T12:00:00Z' },
  },
};
function fakeIo(replies: HelloReply[], nodeId = 'nMini') {
  const calls: { endpoint: Endpoint; auth: Record<string, string> }[] = [];
  const io: TailnetMachineIo = {
    status: () => status(nodeId),
    hello: (endpoint, auth) => {
      calls.push({ endpoint, auth });
      return Promise.resolve(replies.shift()!);
    },
  };
  return { io, calls };
}

test('plain doctor does not request hosting; fix requests the separate capability and stores a private pin', async () => {
  const { io, calls } = fakeIo([pending]);
  expect((await inspectDeviceHostMachines({ fix: false }, io, ['mini'])).machines).toEqual([
    { machine: 'mini', dnsName: 'mini.tail1.ts.net', state: 'not-asked' },
  ]);
  expect(calls).toEqual([]);
  const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  expect(calls).toEqual([
    {
      endpoint: { url: 'wss://100.64.0.7:7443', servername: 'mini.tail1.ts.net', host: 'mini.tail1.ts.net:7443' },
      auth: { request: 'device-host', deviceName: 'laptop' },
    },
  ]);
  expect(result.machines).toEqual([expect.objectContaining({ state: 'pending', deviceId: 'host12' })]);
  expect(result.findings[0]?.fix).toContain('stim-server devices grant host12 --device-host');
  expect(JSON.stringify(result)).not.toContain('hosting-secret');
  expect(readDeviceHostMachines()).toEqual([
    expect.objectContaining({ nodeId: 'nMini', deviceToken: 'hosting-secret', state: 'pending' }),
  ]);
  expect(readBuildMachines()).toEqual([]);
  expect(statSync(deviceHostMachinesFile()).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
});

test('the changed node receives neither a token nor a replacement access request', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  vi.stubEnv('STIM_ACCESS_TICKET', 'new-ticket');
  const { io, calls } = fakeIo([], 'nReplacement');
  expect((await inspectDeviceHostMachines({ fix: true }, io, ['mini'])).machines[0]?.state).toBe('node-changed');
  expect(calls).toEqual([]);
  expect(readDeviceHostMachines()[0]?.nodeId).toBe('nMini');
});

test.each([{ machines: 'mini' }, { machines: ['mini', 42] }, { machines: null }, 'mini'])(
  'invalid hosting settings preserve saved credentials without approval traffic: %j',
  async (hosting) => {
    await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
    const saved = readFileSync(deviceHostMachinesFile(), 'utf8');
    writeFileSync(getConfigPath(), JSON.stringify({ hosting }));
    const { io, calls } = fakeIo([]);
    const readStatus = vi.spyOn(io, 'status');
    for (const fix of [false, true]) {
      const result = await inspectDeviceHostMachines({ fix }, io);
      expect(result.findings).toEqual([expect.objectContaining({ title: 'Invalid hosting.machines setting' })]);
      expect(readFileSync(deviceHostMachinesFile(), 'utf8')).toBe(saved);
      expect(JSON.stringify(result)).not.toContain('hosting-secret');
    }
    expect(calls).toEqual([]);
    expect(readStatus).not.toHaveBeenCalled();
  },
);

test('pending, approved, revoked and uncertain responses preserve capability separation and the saved token', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  const { io, calls } = fakeIo([
    { error: { code: 'approval-pending', message: 'wait' } },
    { result: { capabilities: ['device-host'], device: { id: 'host12', name: 'laptop' } } },
    { result: { capabilities: ['build'], device: { id: 'host12', name: 'laptop' } } },
    { failed: 'connection reset' },
    { error: { code: 'unauthorized', message: 'revoked' } },
  ]);
  const states: string[] = [];
  for (const fix of [false, false, true, true, false])
    states.push((await inspectDeviceHostMachines({ fix }, io, ['mini'])).machines[0]!.state);
  expect(states).toEqual(['pending', 'approved', 'unreachable', 'unreachable', 'revoked']);
  expect(calls).toHaveLength(5);
  expect(readDeviceHostMachines()[0]).toMatchObject({
    deviceToken: 'hosting-secret',
    state: 'approved',
    nodeId: 'nMini',
  });
});

test('only a definite unauthorized response and fix ask again on the same pinned node', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  const { io, calls } = fakeIo([{ error: { code: 'unauthorized', message: 'revoked' } }, pending]);
  expect((await inspectDeviceHostMachines({ fix: true }, io, ['mini'])).machines[0]?.state).toBe('pending');
  expect(calls).toEqual([
    expect.objectContaining({ auth: { deviceToken: 'hosting-secret' } }),
    expect.objectContaining({ auth: { request: 'device-host', deviceName: 'laptop' } }),
  ]);
});

test.each(['{"result":null}', '{"error":null}', '{"result":{"device":null}}', '{"error":{"code":null}}'])(
  'malformed hello replies report unreachable without creating or replacing credentials: %s',
  async (text) => {
    const reply = JSON.parse(text) as HelloReply;
    const first = await inspectDeviceHostMachines({ fix: true }, fakeIo([reply]).io, ['mini']);
    expect(first.machines[0]?.state).toBe('unreachable');
    expect(readDeviceHostMachines()).toEqual([]);

    await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
    const saved = readFileSync(deviceHostMachinesFile(), 'utf8');
    const { io, calls } = fakeIo([reply]);
    const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
    expect(result.machines[0]?.state).toBe('unreachable');
    expect(calls).toHaveLength(1);
    expect(readFileSync(deviceHostMachinesFile(), 'utf8')).toBe(saved);
    expect(JSON.stringify(result)).not.toContain('hosting-secret');
  },
);

test.each(['{"version":1,"machines":[{"deviceToken":"private"}]}', '{bad', '{"version":1,"machines":null}'])(
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

test('forgetting a configured machine is explicit and does not touch build credentials', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  await inspectDeviceHostMachines({ fix: false }, fakeIo([]).io, []);
  expect(readDeviceHostMachines()).toHaveLength(1);
  await inspectDeviceHostMachines({ fix: true }, fakeIo([]).io, []);
  expect(readDeviceHostMachines()).toEqual([]);
});

test('concurrent doctors cannot rotate a pending request before the first credentials settle', async () => {
  let release!: (reply: HelloReply) => void;
  const io: TailnetMachineIo = {
    status,
    hello: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const first = inspectDeviceHostMachines({ fix: true }, io, ['mini']);
  const second = await inspectDeviceHostMachines({ fix: true }, fakeIo([]).io, ['mini']);
  expect(second.machines[0]?.state).toBe('busy');
  release(pending);
  expect((await first).machines[0]?.state).toBe('pending');
  expect(readDeviceHostMachines()[0]?.deviceToken).toBe('hosting-secret');
});

test('two aliases of the same worker route do not replace each other pending request', async () => {
  const { io, calls } = fakeIo([pending]);
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
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  const { io } = fakeIo([
    {
      result: {
        capabilities: ['device-host'],
        device: { id: 'host12', name: 'laptop' },
        host: { name: 'Stim Host Dev', screenRecording: false, accessibility: false },
      },
    },
  ]);
  const result = await inspectDeviceHostMachines({ fix: false }, io, ['mini']);
  expect(result.machines[0]?.state).toBe('approved');
  expect(readDeviceHostMachines()[0]?.state).toBe('approved');
  expect(result.findings).toHaveLength(1);
  const [finding] = result.findings;
  expect(finding).toMatchObject({ code: 'device-host-machine', level: 'note' });
  expect(finding?.title).toMatch(
    /mini.*Screen & System Audio Recording.*Device Control and Data Access.*Stim Host Dev/,
  );
  expect(finding?.fix).toContain('stim-server service install');
});

test('granted host permissions produce no doctor note', async () => {
  await inspectDeviceHostMachines({ fix: true }, fakeIo([pending]).io, ['mini']);
  const { io } = fakeIo([
    {
      result: {
        capabilities: ['device-host'],
        device: { id: 'host12', name: 'laptop' },
        host: { name: 'Stim Host Dev', screenRecording: true, accessibility: true },
      },
    },
  ]);
  const result = await inspectDeviceHostMachines({ fix: false }, io, ['mini']);
  expect(result.machines[0]?.state).toBe('approved');
  expect(result.findings).toEqual([]);
});

test.each([undefined, '', '   ', '  desktop-access-ticket  '])(
  'access requests carry only a non-empty trimmed ticket and persist only its hash: %j',
  async (value) => {
    vi.stubEnv('STIM_ACCESS_TICKET', value);
    const replies: HelloReply[] = [pending];
    const { io, calls } = fakeIo(replies);
    const result = await inspectDeviceHostMachines({ fix: true }, io, ['mini']);
    const ticket = value?.trim();
    expect(calls).toEqual([
      expect.objectContaining({
        auth: {
          request: 'device-host',
          deviceName: 'laptop',
          ...(ticket ? { setupTicket: ticket } : {}),
        },
      }),
    ]);
    expect(Object.hasOwn(calls[0]!.auth, 'setupTicket')).toBe(!!ticket);
    const credential = readDeviceHostMachines()[0]!;
    expect(credential.ticketHash).toBe(ticket ? createHash('sha256').update(ticket).digest('hex') : undefined);
    expect(Object.hasOwn(credential, 'ticketHash')).toBe(!!ticket);
    expect(readFileSync(deviceHostMachinesFile(), 'utf8')).not.toContain('desktop-access-ticket');
    expect(JSON.stringify(result)).not.toContain('desktop-access-ticket');
  },
);

test.each([
  ['missing hash', undefined, 'new-ticket', true, 'pending', false, true],
  ['different hash', 'old-ticket', 'new-ticket', true, 'pending', false, true],
  ['matching hash', 'same-ticket', '  same-ticket  ', true, 'pending', false, false],
  ['no ticket', 'old-ticket', undefined, true, 'pending', false, false],
  ['blank ticket', 'old-ticket', '   ', true, 'pending', false, false],
  ['plain doctor', undefined, 'new-ticket', false, 'pending', false, false],
  ['approved credential', 'old-ticket', 'new-ticket', true, 'approved', true, false],
  ['approved credential with pending reply', undefined, 'new-ticket', true, 'approved', false, false],
  ['approval since last request', undefined, 'new-ticket', true, 'pending', true, false],
] as const)(
  'ticket replacement respects approval and fix: %s',
  async (_name, storedTicket, currentTicket, fix, state, approved, retry) => {
    vi.stubEnv('STIM_ACCESS_TICKET', storedTicket);
    const replies: HelloReply[] = [pending];
    await inspectDeviceHostMachines({ fix: true }, fakeIo(replies).io, ['mini']);
    const saved = readDeviceHostMachines()[0]!;
    writeFileSync(deviceHostMachinesFile(), JSON.stringify({ version: 1, machines: [{ ...saved, state }] }));
    vi.stubEnv('STIM_ACCESS_TICKET', currentTicket);
    replies.push(
      approved
        ? { result: { capabilities: ['device-host'], device: { id: 'host12', name: 'laptop' } } }
        : { error: { code: 'approval-pending', message: 'wait' } },
      { result: { ...pending.result, deviceToken: 'replacement-token' } },
    );
    const { io, calls } = fakeIo(replies);
    const result = await inspectDeviceHostMachines({ fix }, io, ['mini']);
    expect(calls).toMatchObject([
      { auth: { deviceToken: 'hosting-secret' } },
      ...(retry
        ? [
            {
              auth: { request: 'device-host', deviceName: 'laptop', setupTicket: currentTicket },
            },
          ]
        : []),
    ]);
    expect(result.machines[0]?.state).toBe(approved ? 'approved' : 'pending');
    expect(readFileSync(deviceHostMachinesFile(), 'utf8')).not.toContain('new-ticket');
    expect(JSON.stringify(result)).not.toContain('new-ticket');
    expect(readDeviceHostMachines()[0]?.deviceToken).toBe(retry ? 'replacement-token' : 'hosting-secret');
    expect(readDeviceHostMachines()[0]?.ticketHash).toBe(
      retry ? createHash('sha256').update(currentTicket!).digest('hex') : saved.ticketHash,
    );
  },
);

test('credential parsing drops a mistyped optional ticket hash without losing the node pin', async () => {
  const replies: HelloReply[] = [pending];
  await inspectDeviceHostMachines({ fix: true }, fakeIo(replies).io, ['mini']);
  const saved = readDeviceHostMachines()[0]!;
  writeFileSync(deviceHostMachinesFile(), JSON.stringify({ version: 1, machines: [{ ...saved, ticketHash: 42 }] }));
  expect(readDeviceHostMachines()).toEqual([saved]);
});

test.each([undefined, null, { name: 'Stim Host', screenRecording: false, accessibility: true }])(
  'approved doctor machine entries expose host permissions only when reported: %j',
  async (host) => {
    const replies: HelloReply[] = [pending];
    await inspectDeviceHostMachines({ fix: true }, fakeIo(replies).io, ['mini']);
    replies.push({
      result: {
        capabilities: ['device-host'],
        device: { id: 'host12', name: 'laptop' },
        ...(host !== undefined ? { host } : {}),
      },
    });
    const result = await inspectDeviceHostMachines({ fix: false }, fakeIo(replies).io, ['mini']);
    const [entry] = JSON.parse(JSON.stringify(result.machines));
    expect(entry.state).toBe('approved');
    expect(entry.host).toEqual(host ?? undefined);
    expect(Object.hasOwn(entry, 'host')).toBe(!!host);
  },
);
