import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSecret, secretValues } from '@stim-cli/core/noise-session';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  PAIRING_TTL_MS,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  revokeDevice,
  secretPsk,
  dropSetupSecret,
  spendSecret,
  storeSetupSecret,
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

const newKey = () => randomBytes(32).toString('base64url');

const lookupOf = (token: string) => secretValues(Buffer.from(token, 'base64url')).lookup.toString('hex');

function pair(name = 'Phone', key = newKey(), capabilities = capabilitiesFor(false)) {
  const { token } = createPairingToken(Date.now(), capabilities);
  const records = spendSecret(lookupOf(token), key, name, 'phone.ts.net');
  if (!records?.device) throw new Error('the pairing token was not spent');
  return records.device;
}

function setup(capabilities: ('build' | 'device-host')[], key = newKey(), now = Date.now()) {
  const ticket = newSecret();
  storeSetupSecret(Buffer.from(ticket, 'base64url'), capabilities, new Date(now + 60_000).toISOString(), now);
  return { ticket, key, journal: secretValues(Buffer.from(ticket, 'base64url')).journal };
}

describe('pairing tokens', () => {
  it('records the capabilities stored with the token for one key, and never after it expired', () => {
    const now = Date.now();
    const { token } = createPairingToken(now, capabilitiesFor(true));
    const key = newKey();
    expect(secretPsk(lookupOf(token), now)).toEqual(secretValues(Buffer.from(token, 'base64url')).psk);
    expect(spendSecret(lookupOf(token), key, 'Phone', 'phone.ts.net', now)).toEqual({
      device: expect.objectContaining({ publicKey: key, from: 'phone.ts.net', capabilities: ['read', 'control'] }),
    });
    expect(spendSecret(lookupOf(token), newKey(), 'Phone', 'phone.ts.net', now)).toBeNull();
    expect(spendSecret(lookupOf(token), key, 'Phone', 'phone.ts.net', now)).toEqual({
      device: expect.objectContaining({ publicKey: key }),
    });
    expect(readDevices()).toHaveLength(1);
    expect(secretPsk(lookupOf(token), now + PAIRING_TTL_MS + 1)).toBeNull();

    const expired = createPairingToken(now).token;
    expect(spendSecret(lookupOf(expired), newKey(), 'Late', 'phone.ts.net', now + PAIRING_TTL_MS + 1)).toBeNull();
    expect(readDevices().map((device) => device.publicKey)).toEqual([key]);
  });

  it('replaces the earlier pairing of a key that pairs again', () => {
    const key = newKey();
    pair('Phone', key);
    const other = pair('Other');
    const again = pair('Phone', key, capabilitiesFor(true));
    expect(readDevices().map((device) => device.id)).toEqual([other.id, again.id]);
  });

  it.each([
    ['control and bidi characters', 'Phone\n1234  Mini\u202e  read', 'Phone 1234 Mini read'],
    [
      'a ZWJ emoji sequence',
      'Janic\u2019s \u{1F468}\u200d\u{1F4BB} Pixel',
      'Janic\u2019s \u{1F468}\u200d\u{1F4BB} Pixel',
    ],
    ['a long name ending in a split emoji', `${'x'.repeat(63)}\u{1F4F1}`, 'x'.repeat(63)],
    ['nothing printable', '\u0000\u2028', 'Phone'],
  ])('pairs a client whose name has %s under a cleaned-up name', (_case, name, stored) => {
    pair(name);
    expect(readDevices().map((device) => device.name)).toEqual([stored]);
  });
});

describe('setup tickets', () => {
  it('records one client per approved capability under one key and the setup journal, for that key only', () => {
    const { ticket, key, journal } = setup(['build', 'device-host']);
    const records = spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net');
    expect(records).toEqual({
      build: expect.objectContaining({ publicKey: key, capabilities: ['build'], setupJournal: journal }),
      'device-host': expect.objectContaining({ publicKey: key, capabilities: ['device-host'], setupJournal: journal }),
    });
    expect(readBuildClients()).toEqual([records!.build]);
    expect(readDeviceHostClients()).toEqual([records!['device-host']]);
    expect(readDevices()).toEqual([]);
    expect(spendSecret(lookupOf(ticket), newKey(), 'Copy', 'copy.ts.net')).toBeNull();
    expect(spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')).toEqual(records);
    expect(readBuildClients()).toHaveLength(1);
    dropSetupSecret(journal);
    expect(secretPsk(lookupOf(ticket))).not.toBeNull();
  });

  it('stores neither a pairing token nor a setup ticket in its text', () => {
    const pairing = createPairingToken().token;
    const { ticket } = setup(['build']);
    const stored = readdirSync(join(home, 'server'))
      .map((file) => readFileSync(join(home, 'server', file), 'utf8'))
      .join('\n');
    expect(stored).toContain(lookupOf(pairing));
    for (const secret of [pairing, ticket]) {
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(Buffer.from(secret, 'base64url').toString('hex'));
    }
  });
});

describe('registries', () => {
  it('sets read and control only on paired devices', () => {
    const phone = pair();
    const { ticket, key } = setup(['build', 'device-host']);
    const machine = spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')!;
    expect(grantDevice(phone.id, ['build'])).toBe('build-mismatch');
    expect(grantDevice(phone.id, ['read', 'device-host'])).toBe('device-host-mismatch');
    expect(grantDevice(machine.build!.id, capabilitiesFor(true))).toBe('build-mismatch');
    expect(grantDevice(machine['device-host']!.id, ['device-host'])).toBe('device-host-mismatch');
    expect(grantDevice('missing', ['read'])).toBe('unknown');
    expect(grantDevice(phone.id, capabilitiesFor(true))).toBe('granted');
    expect(readDevices()[0]!.capabilities).toEqual(['read', 'control']);
    expect(readBuildClients()[0]!.capabilities).toEqual(['build']);
    expect(readDeviceHostClients()[0]!.capabilities).toEqual(['device-host']);
  });

  it('revokes a record from whichever registry holds it and leaves the others', () => {
    const phone = pair();
    const { ticket, key } = setup(['build', 'device-host']);
    const machine = spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')!;
    expect(revokeDevice(machine['device-host']!.id)).toBe(true);
    expect(readDeviceHostClients()).toEqual([]);
    expect(readBuildClients().map((client) => client.id)).toEqual([machine.build!.id]);
    expect(revokeDevice(machine.build!.id)).toBe(true);
    expect(readBuildClients()).toEqual([]);
    expect(revokeDevice(phone.id)).toBe(true);
    expect(readDevices()).toEqual([]);
    expect(revokeDevice(phone.id)).toBe(false);
  });
});
