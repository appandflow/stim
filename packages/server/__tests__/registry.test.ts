import Ajv2020 from 'ajv/dist/2020.js';
import { protocolJsonSchema } from '../src/protocol.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateDevice,
  BUILD_REQUEST_TTL_MS,
  buildClientsReadable,
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  MAX_BUILD_REQUESTS,
  MAX_NODE_REQUESTS,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  requestBuildAccess,
  requestDeviceHostAccess,
  revokeDevice,
  spendPairingToken,
  type PeerIdentity,
} from '../src/registry.ts';
import { selectGrants } from '../src/setup.ts';
import { writeSetupJournal } from '../src/setup-journal.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-registry-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const node = (nodeId: string): PeerIdentity => ({ kind: 'tailnet', nodeId, nodeName: `${nodeId}.ts.net`, user: 'u' });

function request(nodeId: string, now = Date.now(), capability: 'build' | 'device-host' = 'build') {
  const outcome = (capability === 'build' ? requestBuildAccess : requestDeviceHostAccess)('Laptop', node(nodeId), now);
  if (!outcome.ok) throw new Error(outcome.reason);
  return { id: outcome.device.id, token: outcome.deviceToken! };
}

describe('build clients', () => {
  it('keeps build clients out of devices.json, which older servers read', () => {
    request('nA');
    expect(grantDevice(request('nB').id, ['build'])).toBe('granted');
    expect(readDevices()).toEqual([]);
    expect(readBuildClients().map((client) => client.capabilities)).toEqual([[], ['build']]);
  });

  it('tells an unreadable build client registry apart from one with no client left', () => {
    const { id } = request('nA');
    expect(revokeDevice(id)).toBe(true);
    expect(readBuildClients()).toEqual([]);
    expect(buildClientsReadable()).toBe(true);
    writeFileSync(join(home, 'server', 'build-clients.json'), '{"devices": [');
    expect(readBuildClients()).toEqual([]);
    expect(buildClientsReadable()).toBe(false);
  });

  it('refuses a build name that could forge the approval listing', () => {
    for (const name of ['Laptop\n1234  Mini  build  from mini', 'Laptop\u202e', 'x'.repeat(65)]) {
      expect(requestBuildAccess(name, node('nA'))).toEqual({ ok: false, reason: 'bad-device-name' });
    }
    expect(readBuildClients()).toEqual([]);
  });

  it.each([
    ['control and bidi characters', 'Phone\n1234  Mini\u202e  read', 'Phone 1234 Mini read'],
    [
      'a ZWJ emoji sequence',
      'Janic\u2019s \u{1F468}\u200D\u{1F4BB} Pixel',
      'Janic\u2019s \u{1F468}\u200D\u{1F4BB} Pixel',
    ],
    ['a long name ending in a split emoji', `${'x'.repeat(63)}\u{1F4F1}`, 'x'.repeat(63)],
    ['nothing printable', '\u0000\u2028', 'Phone'],
  ])('pairs a phone whose OS name has %s under a cleaned-up name', (_case, name, stored) => {
    const { token } = createPairingToken();
    expect(spendPairingToken(token, name, node('nPhone'))).toMatchObject({ ok: true, device: { name: stored } });
    expect(spendPairingToken(token, name, node('nPhone'))).toEqual({ ok: false, reason: 'pairing-unknown' });
    expect(readDevices().map((device) => device.name)).toEqual([stored]);
  });

  it("keeps a node's earlier request beside a new one, and caps them per node and in total", () => {
    const first = request('nA');
    const again = request('nA');
    expect(readBuildClients().map((client) => client.id)).toEqual([first.id, again.id]);
    expect(authenticateDevice(first.token, node('nA'))).toEqual({ ok: false, reason: 'approval-pending' });
    for (let i = 2; i < MAX_NODE_REQUESTS; i++) request('nA');
    expect(requestBuildAccess('Laptop', node('nA'))).toEqual({ ok: false, reason: 'build-requests-full' });
    const single = request('nB');
    for (let i = MAX_NODE_REQUESTS + 1; i < MAX_BUILD_REQUESTS; i++) request(`n${i}`);
    expect(requestBuildAccess('Laptop', node('nFull'))).toEqual({ ok: false, reason: 'build-requests-full' });
    expect(grantDevice(single.id, ['build'])).toBe('granted');
    expect(requestBuildAccess('Laptop', node('nFull'))).toMatchObject({ ok: true });
  });

  it("approves none of a node's pending requests while it has more than one", () => {
    const first = request('nA');
    const second = request('nA');
    const elsewhere = request('nB');
    expect(grantDevice(first.id, ['build'])).toBe('ambiguous');
    expect(grantDevice(second.id, ['build'])).toBe('ambiguous');
    expect(grantDevice(elsewhere.id, ['build'])).toBe('granted');
    expect(revokeDevice(second.id)).toBe(true);
    expect(grantDevice(first.id, ['build'])).toBe('granted');
    const later = request('nA');
    expect(grantDevice(later.id, ['build'])).toBe('granted');
  });

  it('approves the request a setup ticket names beside another from its node', () => {
    const ticket = 'Ab_9-'.repeat(8) + 'xyz';
    const ticketed = requestBuildAccess('Laptop', node('nA'), undefined, ticket);
    if (!ticketed.ok) throw new Error(ticketed.reason);
    const forged = request('nA');
    const hash = createHash('sha256').update(ticket).digest('hex');
    expect(grantDevice(forged.id, ['build'], Date.now(), hash)).toBe('ambiguous');
    expect(grantDevice(ticketed.device.id, ['build'], Date.now(), hash)).toBe('granted');
  });

  it('forgets a request that lapsed before approval', () => {
    const now = Date.now();
    const { id, token } = request('nA', now);
    const later = now + BUILD_REQUEST_TTL_MS + 1;
    expect(authenticateDevice(token, node('nA'), later)).toEqual({ ok: false, reason: 'device-unknown' });
    expect(grantDevice(id, ['build'], later)).toBe('unknown');
  });

  it('never grants build to a paired device, or read or control to a build client', () => {
    const phone = spendPairingToken(createPairingToken().token, 'Phone', node('nPhone'));
    if (!phone.ok) throw new Error(phone.reason);
    const { id } = request('nA');
    expect(grantDevice(phone.device.id, ['build'])).toBe('build-mismatch');
    expect(grantDevice(phone.device.id, ['read', 'build'])).toBe('build-mismatch');
    expect(grantDevice(id, capabilitiesFor(false))).toBe('build-mismatch');
    expect(grantDevice(id, ['read', 'build'])).toBe('build-mismatch');
    expect(readDevices()[0]!.capabilities).toEqual(['read']);
    expect(readBuildClients()[0]).toMatchObject({ capabilities: [], pendingUntil: expect.any(String) });
  });
});

describe('device-host clients', () => {
  it('keeps approvals separate from build and pairing permissions and pins the token to its node', () => {
    const phone = spendPairingToken(createPairingToken().token, 'Phone', node('phone'));
    if (!phone.ok) throw new Error(phone.reason);
    const build = request('host');
    const host = request('host', Date.now(), 'device-host');
    expect(readDeviceHostClients()).toEqual([
      expect.objectContaining({ id: host.id, requestedCapability: 'device-host', capabilities: [] }),
    ]);
    expect(readBuildClients().map((client) => client.id)).toEqual([build.id]);
    expect(readDevices().map((client) => client.id)).toEqual([phone.device.id]);
    expect(authenticateDevice(host.token, node('host'))).toEqual({ ok: false, reason: 'approval-pending' });
    expect(grantDevice(phone.device.id, ['device-host'])).toBe('device-host-mismatch');
    expect(grantDevice(build.id, ['device-host'])).toBe('build-mismatch');
    for (const capabilities of [['build'], ['read'], ['control'], ['device-host', 'read']] as const) {
      expect(grantDevice(host.id, [...capabilities])).toBe('device-host-mismatch');
    }
    expect(grantDevice(host.id, ['device-host'])).toBe('granted');
    expect(authenticateDevice(host.token, node('elsewhere'))).toEqual({ ok: false, reason: 'node-mismatch' });
    expect(authenticateDevice(host.token, { kind: 'local' })).toEqual({ ok: false, reason: 'node-mismatch' });
    expect(authenticateDevice(host.token, node('host'))).toMatchObject({
      ok: true,
      device: { capabilities: ['device-host'], requestedCapability: 'device-host', lastSeenAt: expect.any(String) },
    });
    expect(readDeviceHostClients()[0]).not.toHaveProperty('pendingUntil');
    expect(revokeDevice(host.id)).toBe(true);
    expect(authenticateDevice(host.token, node('host'))).toEqual({ ok: false, reason: 'device-unknown' });
    expect(readBuildClients().map((client) => client.id)).toEqual([build.id]);
  });

  it("refuses local and forged names, replaces only this node's host request, and expires unapproved tokens", () => {
    const now = Date.now();
    expect(requestDeviceHostAccess('Host', { kind: 'local' }, now)).toEqual({
      ok: false,
      reason: 'device-host-needs-tailnet',
    });
    expect(requestDeviceHostAccess('Host\nApproved', node('host'), now)).toEqual({
      ok: false,
      reason: 'bad-device-name',
    });
    const build = request('host', now);
    const earlier = request('host', now, 'device-host');
    const current = request('host', now, 'device-host');
    expect(authenticateDevice(earlier.token, node('host'), now)).toEqual({ ok: false, reason: 'approval-pending' });
    expect(readBuildClients(now).map((client) => client.id)).toEqual([build.id]);
    for (let i = 2; i < MAX_BUILD_REQUESTS; i++) request(`host${i}`, now, 'device-host');
    expect(requestDeviceHostAccess('Full', node('full'), now)).toEqual({
      ok: false,
      reason: 'device-host-requests-full',
    });
    const later = now + BUILD_REQUEST_TTL_MS + 1;
    expect(authenticateDevice(current.token, node('host'), later)).toEqual({ ok: false, reason: 'device-unknown' });
    expect(grantDevice(current.id, ['device-host'], later)).toBe('unknown');
    expect(readDeviceHostClients(later)).toEqual([]);
  });
});

describe.each(['build', 'device-host'] as const)('%s setup binding', (capability) => {
  const ask = capability === 'build' ? requestBuildAccess : requestDeviceHostAccess;
  const read = capability === 'build' ? readBuildClients : readDeviceHostClients;

  it('persists only the ticket hash and retains the binding after approval and authentication', () => {
    const ticket = 'Ab_9-'.repeat(8) + 'xyz';
    const hash = createHash('sha256').update(ticket).digest('hex');
    const outcome = ask('Laptop', node('nA'), undefined, ticket);
    if (!outcome.ok) throw new Error(outcome.reason);
    const file = join(home, 'server', `${capability}-clients.json`);
    expect(readFileSync(file, 'utf8')).not.toContain(ticket);
    expect(read()[0]).toMatchObject({ setupTicketHash: hash, capabilities: [] });
    expect(grantDevice(outcome.device.id, [capability])).toBe('granted');
    expect(authenticateDevice(outcome.deviceToken!, node('nA'))).toMatchObject({
      ok: true,
      device: { setupTicketHash: hash, capabilities: [capability] },
    });
    expect(read()[0]).toHaveProperty('setupTicketHash', hash);
    expect(readFileSync(file, 'utf8')).not.toContain(ticket);
  });

  it("replaces only the node's pending request with the same ticket, and keeps every other request", () => {
    const first = ask('Laptop', node('nA'), undefined, 'a'.repeat(43));
    const again = ask('Laptop', node('nA'), undefined, 'a'.repeat(43));
    const otherTicket = ask('Laptop', node('nA'), undefined, 'b'.repeat(43));
    const unticketed = ask('Laptop', node('nA'));
    const otherNode = ask('Laptop', node('nB'), undefined, 'a'.repeat(43));
    if (!first.ok || !again.ok || !otherTicket.ok || !unticketed.ok || !otherNode.ok) throw new Error('refused');
    expect(read()).toEqual([again.device, otherTicket.device, unticketed.device, otherNode.device]);
  });

  describe('while stim-server setup waits for a ticket', () => {
    const ticket = 'Ab_9-'.repeat(8) + 'xyz';
    const hash = createHash('sha256').update(ticket).digest('hex');
    const match = () => ({ nodeId: 'nA', ticketHash: hash, capabilities: [capability], now: Date.now() });
    const journal = (done = false) =>
      writeSetupJournal(hash, {
        v: 1,
        client: { nodeId: 'nA' },
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        capabilities: [capability],
        steps: [],
        granted: [],
        done,
      });
    const fillNode = () => {
      for (let i = 0; i < MAX_NODE_REQUESTS; i++) ask('Forged', node('nA'));
      expect(ask('Laptop', node('nA'))).toEqual({ ok: false, reason: `${capability}-requests-full` });
    };

    it('lets setup choose the ticketed request over a forged one sent first', () => {
      journal();
      ask('Forged', node('nA'));
      const honest = ask('Laptop', node('nA'), undefined, ticket);
      if (!honest.ok) throw new Error(honest.reason);
      expect(selectGrants(read(), match())).toEqual([{ capability, record: honest.device, approved: false }]);
    });

    it("admits the ticket's request past a full node and Mac, and copies under other nodes take none of it", () => {
      journal();
      fillNode();
      for (let i = MAX_NODE_REQUESTS; i < MAX_BUILD_REQUESTS; i++) ask('Copy', node(`n${i}`), undefined, ticket);
      const honest = ask('Laptop', node('nA'), undefined, ticket);
      if (!honest.ok) throw new Error(honest.reason);
      expect(selectGrants(read(), match())).toEqual([{ capability, record: honest.device, approved: false }]);
    });

    it('replaces the request an honest retry with the same ticket orphaned, so setup still chooses', () => {
      journal();
      const lost = ask('Laptop', node('nA'), undefined, ticket);
      const retry = ask('Laptop', node('nA'), undefined, ticket);
      if (!lost.ok || !retry.ok) throw new Error('request refused');
      expect(read().map((client) => client.id)).not.toContain(lost.device.id);
      expect(selectGrants(read(), match())).toEqual([{ capability, record: retry.device, approved: false }]);
    });

    it('stops exempting the ticket once setup is done', () => {
      journal(true);
      fillNode();
      expect(ask('Laptop', node('nA'), undefined, ticket)).toEqual({
        ok: false,
        reason: `${capability}-requests-full`,
      });
    });
  });
});

test('the published hello schema accepts ticket-bound and legacy access requests for both capabilities', () => {
  const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(protocolJsonSchema());
  for (const capability of ['build', 'device-host']) {
    for (const binding of [{}, { setupTicket: 'Ab_9-'.repeat(8) + 'xyz' }]) {
      expect(
        validate({
          id: 1,
          method: 'hello',
          params: {
            protocol: 1,
            client: { name: 'Test', version: '1' },
            auth: { request: capability, deviceName: 'Laptop', ...binding },
          },
        }),
      ).toBe(true);
    }
  }
});
