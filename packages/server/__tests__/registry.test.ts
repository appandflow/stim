import Ajv2020 from 'ajv/dist/2020.js';
import { protocolJsonSchema } from '../src/protocol.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticateDevice,
  BUILD_REQUEST_TTL_MS,
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  MAX_BUILD_REQUESTS,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  requestBuildAccess,
  requestDeviceHostAccess,
  revokeDevice,
  spendPairingToken,
  type PeerIdentity,
} from '../src/registry.ts';

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

  it('refuses a build name that could forge the approval listing', () => {
    for (const name of ['Laptop\n1234  Mini  build  from mini', 'Laptop\u202e', 'x'.repeat(65)]) {
      expect(requestBuildAccess(name, node('nA'))).toEqual({ ok: false, reason: 'bad-device-name' });
    }
    expect(readBuildClients()).toEqual([]);
  });

  it('keeps one pending request per node and caps the total', () => {
    request('nA');
    const again = request('nA');
    expect(readBuildClients().map((client) => client.id)).toEqual([again.id]);
    for (let i = 1; i < MAX_BUILD_REQUESTS; i++) request(`n${i}`);
    expect(requestBuildAccess('Laptop', node('nFull'))).toEqual({ ok: false, reason: 'build-requests-full' });
    grantDevice(again.id, ['build']);
    expect(requestBuildAccess('Laptop', node('nFull'))).toMatchObject({ ok: true });
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
    const replaced = request('host', now, 'device-host');
    const current = request('host', now, 'device-host');
    expect(authenticateDevice(replaced.token, node('host'), now)).toEqual({ ok: false, reason: 'device-unknown' });
    expect(readBuildClients(now).map((client) => client.id)).toEqual([build.id]);
    for (let i = 1; i < MAX_BUILD_REQUESTS; i++) request(`host${i}`, now, 'device-host');
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

  it('replaces an older binding and accepts absent or invalid optional tickets as ordinary requests', () => {
    ask('Laptop', node('nA'), undefined, 'a'.repeat(43));
    for (const ticket of [undefined, null, 42, 'a'.repeat(42), 'a'.repeat(44), '!'.repeat(43), 'a'.repeat(43) + '\n']) {
      const outcome = ask('Laptop', node('nA'), undefined, ticket);
      if (!outcome.ok) throw new Error(outcome.reason);
      expect(read()).toEqual([outcome.device]);
      expect(read()[0]).not.toHaveProperty('setupTicketHash');
      expect(outcome.device).toMatchObject({
        requestedCapability: capability,
        capabilities: [],
        pendingUntil: expect.any(String),
      });
    }
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
