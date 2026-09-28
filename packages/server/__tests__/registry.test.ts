import { mkdtempSync, rmSync } from 'node:fs';
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
  readDevices,
  requestBuildAccess,
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

function request(nodeId: string, now = Date.now()) {
  const outcome = requestBuildAccess('Laptop', node(nodeId), now);
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
