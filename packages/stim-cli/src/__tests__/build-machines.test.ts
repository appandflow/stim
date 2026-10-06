import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMachinesFile, readBuildMachines } from '@stim-cli/core/state';
import {
  findPeer,
  inspectBuildMachines,
  parseMachine,
  type Endpoint,
  type HelloReply,
} from '../offload/build-machines.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-machines-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function status(nodeId: string, dnsName = 'mini.tail1.ts.net.') {
  return {
    BackendState: 'Running',
    Self: { ID: 'nLaptop', HostName: 'lap\u200dtop', DNSName: 'laptop.tail1.ts.net.' },
    Peer: {
      key1: { ID: nodeId, DNSName: dnsName, TailscaleIPs: ['fd7a::1', '100.64.0.7'] },
      key2: { ID: 'nFunnel', DNSName: '' },
      key3: { ID: 'nOther', DNSName: 'minimal.tail1.ts.net.', TailscaleIPs: ['100.64.0.8'] },
    },
  };
}

function fakeIo(nodeId: string, replies: HelloReply[]) {
  const calls: { endpoint: Endpoint; auth: Record<string, string> }[] = [];
  const io = {
    status: () => status(nodeId),
    hello: (endpoint: Endpoint, auth: Record<string, string>) => {
      calls.push({ endpoint, auth });
      return Promise.resolve(replies.shift()!);
    },
  };
  return { io, calls };
}

const pending: HelloReply = {
  result: {
    capabilities: [],
    device: { id: 'ab12', name: 'laptop' },
    deviceToken: 'secret',
    approval: { state: 'pending', expiresAt: '2026-09-28T12:15:00.000Z' },
  },
};

describe('findPeer', () => {
  it('matches a MagicDNS name or its first label, and only one peer', () => {
    const mini = { nodeId: 'nMini', dnsName: 'mini.tail1.ts.net', address: '100.64.0.7' };
    expect(findPeer(status('nMini'), 'mini')).toEqual(mini);
    expect(findPeer(status('nMini'), 'mini.tail1.ts.net')).toEqual(mini);
    expect(findPeer(status('nMini'), 'nope')).toBe('missing');
    expect(findPeer(status('nMini', 'minimal.tail1.ts.net.'), 'minimal')).toBe('ambiguous');
    expect(parseMachine('Mini:7444')).toEqual({ name: 'mini', port: 7444 });
    expect(parseMachine('mini;rm')).toBeNull();
  });
});

describe('inspectBuildMachines', () => {
  it('requests access with --fix and pins the node it asked', async () => {
    const { io, calls } = fakeIo('nMini', [pending]);
    const { findings, machines } = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls).toEqual([
      {
        endpoint: { url: 'wss://100.64.0.7:7443', servername: 'mini.tail1.ts.net', host: 'mini.tail1.ts.net:7443' },
        auth: { request: 'build', deviceName: 'laptop' },
      },
    ]);
    expect(findings[0]!.fix).toContain('stim-server devices grant ab12 --build');
    expect(machines).toEqual([
      expect.objectContaining({ machine: 'mini', state: 'pending', dnsName: 'mini.tail1.ts.net', deviceId: 'ab12' }),
    ]);
    expect(readBuildMachines()).toEqual([
      expect.objectContaining({ machine: 'mini', nodeId: 'nMini', deviceToken: 'secret', state: 'pending' }),
    ]);
    expect(await inspectBuildMachines({ fix: false }, fakeIo('nMini', []).io, [])).toEqual({
      findings: [],
      machines: [],
    });
  });

  it('never sends the token to a node other than the pinned one', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    vi.stubEnv('STIM_ACCESS_TICKET', 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn');
    const { io, calls } = fakeIo('nImpostor', []);
    const { findings, machines } = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls).toEqual([]);
    expect(findings).toEqual([expect.objectContaining({ title: 'Build machine mini is a different tailnet node' })]);
    expect(machines).toEqual([expect.objectContaining({ machine: 'mini', state: 'node-changed' })]);
    expect(readBuildMachines()[0]!.nodeId).toBe('nMini');
  });

  it('records the approval once the worker accepts the token', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    const approved: HelloReply = { result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' } } };
    const { io, calls } = fakeIo('nMini', [{ error: { code: 'approval-pending', message: 'wait' } }, approved]);
    expect(await inspectBuildMachines({ fix: false }, io, ['mini'])).toEqual({
      findings: [expect.objectContaining({ title: 'Build machine mini has not approved this Mac yet' })],
      machines: [expect.objectContaining({ state: 'pending', deviceId: 'ab12' })],
    });
    expect(await inspectBuildMachines({ fix: false }, io, ['mini'])).toEqual({
      findings: [],
      machines: [expect.objectContaining({ machine: 'mini', state: 'approved', deviceId: 'ab12' })],
    });
    expect(calls.map((call) => call.auth)).toEqual([{ deviceToken: 'secret' }, { deviceToken: 'secret' }]);
    expect(readBuildMachines()[0]!.state).toBe('approved');
  });

  it('reports every reason an approved machine would not take the build, with a remedy for each', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    const host = { name: 'Stim Host', screenRecording: true, accessibility: false };
    const approved: HelloReply = { result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' }, host } };
    const asked: string[] = [];
    const { findings, machines } = await inspectBuildMachines(
      {
        fix: false,
        check: (credential) => {
          asked.push(credential.deviceToken);
          return Promise.resolve({
            capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
            problems: [
              { code: 'stim-build', reason: 'Stim build 6bbe there, e774 here' },
              { code: 'busy', reason: 'busy (load at or above 2/core; load 8.2/core, 2 builds)' },
            ],
          });
        },
      },
      fakeIo('nMini', [approved]).io,
      ['mini'],
    );
    expect(asked).toEqual(['secret']);
    expect(machines).toEqual([
      expect.objectContaining({
        state: 'approved',
        host,
        offloadable: false,
        reasons: ['Stim build 6bbe there, e774 here', 'busy (load at or above 2/core; load 8.2/core, 2 builds)'],
        problems: [
          { code: 'stim-build', reason: 'Stim build 6bbe there, e774 here' },
          { code: 'busy', reason: 'busy (load at or above 2/core; load 8.2/core, 2 builds)' },
        ],
        capacity: { running: 0, max: 1, loadPerCore: 8.2, builds: 2 },
      }),
    ]);
    expect(findings.map(({ code, level }) => ({ code, level }))).toEqual([
      { code: 'build-machine-stim-build', level: 'cost' },
      { code: 'build-machine-busy', level: 'note' },
    ]);
    expect(findings[0]!.detail).toContain('6bbe there, e774 here');
    expect(findings[0]!.fix).toContain('run `stim-server service update --release <version>`');

    const ready = await inspectBuildMachines(
      { fix: false, check: () => Promise.resolve({ capacity: null, problems: [] }) },
      fakeIo('nMini', [approved]).io,
      ['mini'],
    );
    expect(ready).toEqual({
      findings: [],
      machines: [expect.objectContaining({ state: 'approved', offloadable: true, reasons: [], host })],
    });
  });

  it('reports a revoked machine and one never asked without asking either', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    const { io, calls } = fakeIo('nMini', [{ error: { code: 'unauthorized', message: 'Unknown device.' } }]);
    const { machines } = await inspectBuildMachines({ fix: false }, io, ['mini', 'minimal', 'nope', 'bad;name']);
    expect(machines).toEqual([
      expect.objectContaining({ machine: 'mini', state: 'revoked', deviceId: 'ab12' }),
      { machine: 'minimal', state: 'not-asked', dnsName: 'minimal.tail1.ts.net' },
      { machine: 'nope', state: 'not-on-tailnet' },
      { machine: 'bad;name', state: 'invalid' },
    ]);
    expect(calls.map((call) => call.auth)).toEqual([{ deviceToken: 'secret' }]);
    const off = await inspectBuildMachines({ fix: false }, { status: () => null, hello: io.hello }, ['mini']);
    expect(off.machines).toEqual([{ machine: 'mini', state: 'tailscale-off' }]);
  });

  it('forgets the pairing of a machine no longer named, with --fix only', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    await inspectBuildMachines({ fix: false }, fakeIo('nMini', []).io, []);
    expect(readBuildMachines()).toHaveLength(1);
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', []).io, []);
    expect(readBuildMachines()).toEqual([]);
  });
});

test.each([undefined, '', '   ', '  ddddddddddddddddddddddddddddddddddddddddddd  '])(
  'access requests carry only a non-empty trimmed ticket and persist only its hash: %j',
  async (value) => {
    vi.stubEnv('STIM_ACCESS_TICKET', value);
    const replies: HelloReply[] = [pending];
    const { io, calls } = fakeIo('nMini', replies);
    const result = await inspectBuildMachines({ fix: true }, io, ['mini']);
    const ticket = value?.trim();
    expect(calls).toEqual([
      expect.objectContaining({
        auth: {
          request: 'build',
          deviceName: 'laptop',
          ...(ticket ? { setupTicket: ticket } : {}),
        },
      }),
    ]);
    expect(Object.hasOwn(calls[0]!.auth, 'setupTicket')).toBe(!!ticket);
    const credential = readBuildMachines()[0]!;
    expect(credential.ticketHash).toBe(ticket ? createHash('sha256').update(ticket).digest('hex') : undefined);
    expect(Object.hasOwn(credential, 'ticketHash')).toBe(!!ticket);
    expect(readFileSync(buildMachinesFile(), 'utf8')).not.toContain('ddddddddddddddddddddddddddddddddddddddddddd');
    expect(JSON.stringify(result)).not.toContain('ddddddddddddddddddddddddddddddddddddddddddd');
  },
);

test.each([
  ['missing hash', undefined, 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn', true, 'pending', false, true],
  [
    'different hash',
    'ooooooooooooooooooooooooooooooooooooooooooo',
    'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    true,
    'pending',
    false,
    true,
  ],
  [
    'matching hash',
    'sssssssssssssssssssssssssssssssssssssssssss',
    '  sssssssssssssssssssssssssssssssssssssssssss  ',
    true,
    'pending',
    false,
    false,
  ],
  ['no ticket', 'ooooooooooooooooooooooooooooooooooooooooooo', undefined, true, 'pending', false, false],
  ['blank ticket', 'ooooooooooooooooooooooooooooooooooooooooooo', '   ', true, 'pending', false, false],
  ['plain doctor', undefined, 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn', false, 'pending', false, false],
  [
    'approved credential',
    'ooooooooooooooooooooooooooooooooooooooooooo',
    'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    true,
    'approved',
    true,
    false,
  ],
  [
    'approved credential with pending reply',
    undefined,
    'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    true,
    'approved',
    false,
    false,
  ],
  [
    'approval since last request',
    undefined,
    'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    true,
    'pending',
    true,
    false,
  ],
] as const)(
  'ticket replacement respects approval and fix: %s',
  async (_name, storedTicket, currentTicket, fix, state, approved, retry) => {
    vi.stubEnv('STIM_ACCESS_TICKET', storedTicket);
    const replies: HelloReply[] = [pending];
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', replies).io, ['mini']);
    const saved = readBuildMachines()[0]!;
    writeFileSync(buildMachinesFile(), JSON.stringify({ version: 1, machines: [{ ...saved, state }] }));
    vi.stubEnv('STIM_ACCESS_TICKET', currentTicket);
    replies.push(
      approved
        ? { result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' } } }
        : { error: { code: 'approval-pending', message: 'wait' } },
      { result: { ...pending.result, deviceToken: 'replacement-token' } },
    );
    const { io, calls } = fakeIo('nMini', replies);
    const result = await inspectBuildMachines({ fix }, io, ['mini']);
    expect(calls).toMatchObject([
      { auth: { deviceToken: 'secret' } },
      ...(retry ? [{ auth: { request: 'build', deviceName: 'laptop', setupTicket: currentTicket } }] : []),
    ]);
    expect(result.machines[0]?.state).toBe(approved ? 'approved' : 'pending');
    expect(readFileSync(buildMachinesFile(), 'utf8')).not.toContain('nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn');
    expect(JSON.stringify(result)).not.toContain('nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn');
    expect(readBuildMachines()[0]?.deviceToken).toBe(retry ? 'replacement-token' : 'secret');
    expect(readBuildMachines()[0]?.ticketHash).toBe(
      retry ? createHash('sha256').update(currentTicket!).digest('hex') : saved.ticketHash,
    );
  },
);

test('credential parsing drops a mistyped optional ticket hash without losing the node pin', async () => {
  const replies: HelloReply[] = [pending];
  await inspectBuildMachines({ fix: true }, fakeIo('nMini', replies).io, ['mini']);
  const saved = readBuildMachines()[0]!;
  writeFileSync(buildMachinesFile(), JSON.stringify({ version: 1, machines: [{ ...saved, ticketHash: 42 }] }));
  expect(readBuildMachines()).toEqual([saved]);
});

test.each([undefined, null, { name: 'Stim Host', screenRecording: false, accessibility: true }])(
  'approved doctor machine entries expose host permissions only when reported: %j',
  async (host) => {
    const replies: HelloReply[] = [pending];
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', replies).io, ['mini']);
    replies.push({
      result: {
        capabilities: ['build'],
        device: { id: 'ab12', name: 'laptop' },
        ...(host !== undefined ? { host } : {}),
      },
    });
    const result = await inspectBuildMachines({ fix: false }, fakeIo('nMini', replies).io, ['mini']);
    const [entry] = JSON.parse(JSON.stringify(result.machines));
    expect(entry.state).toBe('approved');
    expect(entry.host).toEqual(host ?? undefined);
    expect(Object.hasOwn(entry, 'host')).toBe(!!host);
  },
);
