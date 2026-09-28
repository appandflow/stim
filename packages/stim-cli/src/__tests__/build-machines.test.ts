import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildMachines } from '@stim-cli/core/state';
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
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
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
    const findings = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls).toEqual([
      {
        endpoint: { url: 'wss://100.64.0.7:7443', servername: 'mini.tail1.ts.net', host: 'mini.tail1.ts.net:7443' },
        auth: { request: 'build', deviceName: 'laptop' },
      },
    ]);
    expect(findings[0]!.fix).toContain('stim-server devices grant ab12 --build');
    expect(readBuildMachines()).toEqual([
      expect.objectContaining({ machine: 'mini', nodeId: 'nMini', deviceToken: 'secret', state: 'pending' }),
    ]);
    expect(await inspectBuildMachines({ fix: false }, fakeIo('nMini', []).io, [])).toEqual([]);
  });

  it('never sends the token to a node other than the pinned one', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    const { io, calls } = fakeIo('nImpostor', []);
    const findings = await inspectBuildMachines({ fix: true }, io, ['mini']);
    expect(calls).toEqual([]);
    expect(findings).toEqual([expect.objectContaining({ title: 'Build machine mini is a different tailnet node' })]);
    expect(readBuildMachines()[0]!.nodeId).toBe('nMini');
  });

  it('records the approval once the worker accepts the token', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    const approved: HelloReply = { result: { capabilities: ['build'], device: { id: 'ab12', name: 'laptop' } } };
    const { io, calls } = fakeIo('nMini', [{ error: { code: 'approval-pending', message: 'wait' } }, approved]);
    expect(await inspectBuildMachines({ fix: false }, io, ['mini'])).toEqual([
      expect.objectContaining({ title: 'Build machine mini has not approved this Mac yet' }),
    ]);
    expect(await inspectBuildMachines({ fix: false }, io, ['mini'])).toEqual([]);
    expect(calls.map((call) => call.auth)).toEqual([{ deviceToken: 'secret' }, { deviceToken: 'secret' }]);
    expect(readBuildMachines()[0]!.state).toBe('approved');
  });

  it('forgets the pairing of a machine no longer named, with --fix only', async () => {
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', [pending]).io, ['mini']);
    await inspectBuildMachines({ fix: false }, fakeIo('nMini', []).io, []);
    expect(readBuildMachines()).toHaveLength(1);
    await inspectBuildMachines({ fix: true }, fakeIo('nMini', []).io, []);
    expect(readBuildMachines()).toEqual([]);
  });
});
