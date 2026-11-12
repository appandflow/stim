import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSecret, secretValues } from '@stim-cli/core/noise-session';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  isDesktopClient,
  PAIRING_TTL_MS,
  readBuildClients,
  readDeviceHostClients,
  readTestClients,
  readDevices,
  readRegistries,
  readUnreadable,
  RegistryUnavailable,
  renameDevice,
  revokeDevice,
  secretPsk,
  dropSetupSecret,
  spendSecret,
  storeSetupSecret,
  touchDevice,
  type PairedDevice,
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

function setup(capabilities: ('build' | 'device-host' | 'test')[], key = newKey(), now = Date.now()) {
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
    ['a lone surrogate inside', 'a\ud800b', 'ab'],
    ['only a lone surrogate', '\udc00', 'Phone'],
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
    const { ticket, key } = setup(['build', 'device-host', 'test']);
    const machine = spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')!;
    expect(grantDevice(phone.id, ['build'])).toBe('build-mismatch');
    expect(grantDevice(phone.id, ['read', 'device-host'])).toBe('device-host-mismatch');
    expect(grantDevice(phone.id, ['read', 'test'])).toBe('test-mismatch');
    expect(grantDevice(machine.build!.id, capabilitiesFor(true))).toBe('build-mismatch');
    expect(grantDevice(machine['device-host']!.id, ['device-host'])).toBe('device-host-mismatch');
    assert(machine.test);
    expect(grantDevice(machine.test.id, capabilitiesFor(true))).toBe('test-mismatch');
    expect(grantDevice('missing', ['read'])).toBe('unknown');
    expect(grantDevice(phone.id, capabilitiesFor(true))).toBe('granted');
    expect(readDevices()[0]!.capabilities).toEqual(['read', 'control']);
    expect(readBuildClients()[0]!.capabilities).toEqual(['build']);
    expect(readDeviceHostClients()[0]!.capabilities).toEqual(['device-host']);
    expect(readTestClients().map((client) => client.capabilities)).toEqual([['test']]);
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

  it('renames a record in whichever registry holds it and changes nothing else', () => {
    const phone = pair('Phone', newKey(), capabilitiesFor(true));
    const { ticket, key } = setup(['build', 'device-host']);
    spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net');
    const before = readRegistries();
    const emoji = "Janic's phone \u{1F469}\u200d\u{1F4BB}";
    expect(renameDevice(before.build[0]?.id ?? 'missing', '  Studio build box  ')).toBe('renamed');
    expect(renameDevice(phone.id, emoji)).toBe('renamed');
    expect(readRegistries()).toEqual({
      devices: before.devices.map((record) => ({ ...record, name: emoji })),
      build: before.build.map((record) => ({ ...record, name: 'Studio build box' })),
      deviceHost: before.deviceHost,
      test: before.test,
    });
  });

  it('refuses an unknown id and a name that is empty, too long or not one printable line', () => {
    const phone = pair();
    const before = readRegistries();
    expect(renameDevice('missing', 'Name')).toBe('unknown');
    const invalid = [
      '',
      '   ',
      'x'.repeat(65),
      'two\nlines',
      'tab\there',
      'zero\u200bwidth',
      'line\u2028sep',
      'lone\ud800',
    ];
    for (const name of invalid) expect(renameDevice(phone.id, name)).toBe('invalid-name');
    expect(readRegistries()).toEqual(before);
  });
});

describe('the client app a hello names', () => {
  it('fills in a record that has none at once, in whichever registry holds it, and keeps the rest', () => {
    const phone = pair();
    const { ticket, key } = setup(['build']);
    spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net');
    const [build] = readBuildClients();
    assert(build);
    touchDevice(phone.id, { name: 'stim-mobile', version: '2.3.4' });
    touchDevice(build.id, { name: 'Stim Desktop', version: '1.0.0' });
    expect(readDevices()).toEqual([{ ...phone, clientApp: 'stim-mobile', clientVersion: '2.3.4' }]);
    expect(readBuildClients()).toEqual([{ ...build, clientApp: 'Stim Desktop', clientVersion: '1.0.0' }]);
  });

  it('cleans what the client chose like a pairing name, and stores nothing for a missing or empty name', () => {
    const phone = pair();
    touchDevice(phone.id, { name: 'Stim\u202eDesktop\n  ', version: 7 });
    expect(readDevices()[0]).toMatchObject({ clientApp: 'StimDesktop' });
    expect(readDevices()[0]).not.toHaveProperty('clientVersion');
    const other = pair('Other');
    touchDevice(other.id, { name: '\u200b ', version: '1' });
    touchDevice(other.id, {});
    touchDevice(other.id, { name: 4 });
    expect(readDevices()[1]).toEqual(other);
    touchDevice(other.id, { name: 'a\ud800b', version: '\udc00' });
    expect(readDevices()[1]).toMatchObject({ clientApp: 'ab' });
    expect(readDevices()[1]).not.toHaveProperty('clientVersion');
    const long = pair('Long');
    touchDevice(long.id, { name: 'x'.repeat(100), version: 'v'.repeat(100) });
    expect(readDevices()[2]).toMatchObject({ clientApp: 'x'.repeat(64), clientVersion: 'v'.repeat(64) });
  });

  it('records a new version only when the minute throttle lets the touch through', () => {
    const phone = pair();
    const at = Date.parse(phone.lastSeenAt ?? '');
    touchDevice(phone.id, { name: 'stim-mobile', version: '1' }, at + 1000);
    touchDevice(phone.id, { name: 'stim-mobile', version: '2' }, at + 30_000);
    expect(readDevices()[0]).toMatchObject({ clientVersion: '1', lastSeenAt: phone.lastSeenAt });
    touchDevice(phone.id, { name: 'stim-mobile', version: '2' }, at + 61_000);
    expect(readDevices()[0]).toMatchObject({ clientVersion: '2', lastSeenAt: new Date(at + 61_000).toISOString() });
  });

  it('survives a rename and a grant, and reads Stim Desktop and Stim Dev as Desktop only', () => {
    const phone = pair('Phone', newKey(), capabilitiesFor(false));
    touchDevice(phone.id, { name: 'Stim Dev', version: '1' });
    renameDevice(phone.id, 'Studio');
    grantDevice(phone.id, ['read', 'control']);
    const [record] = readDevices();
    assert(record);
    expect(record).toMatchObject({ name: 'Studio', clientApp: 'Stim Dev', capabilities: ['read', 'control'] });
    expect(isDesktopClient(record)).toBe(true);
    expect(isDesktopClient({ ...record, clientApp: 'stim-mobile' })).toBe(false);
    expect(isDesktopClient({ ...record, clientApp: 'Stim Desktop 2' })).toBe(false);
    expect(isDesktopClient(pair('Plain'))).toBe(false);
  });
});

describe('a Stim home that does not answer', () => {
  it('reads a server directory without registry files as no clients', () => {
    mkdirSync(join(home, 'server'));
    expect(readRegistries()).toEqual({ devices: [], build: [], deviceHost: [], test: [] });
  });

  it('refuses to read the registries or a secret through a home symlink whose target moved away', () => {
    const target = join(home, 'volume');
    mkdirSync(target);
    process.env.STIM_HOME = join(home, 'linked');
    symlinkSync(target, process.env.STIM_HOME);
    pair();
    const { token } = createPairingToken();
    renameSync(target, join(home, 'unmounted'));
    expect(() => readRegistries()).toThrow(RegistryUnavailable);
    expect(() => secretPsk(lookupOf(token))).toThrow(RegistryUnavailable);
    renameSync(join(home, 'unmounted'), target);
    expect(readRegistries().devices).toHaveLength(1);
    expect(secretPsk(lookupOf(token))).not.toBeNull();
  });

  it('keeps a registry file it cannot parse instead of overwriting it', () => {
    const phone = pair();
    const file = join(home, 'server', 'devices.json');
    writeFileSync(file, '{"version": 2, "devices": [');
    expect(() => readRegistries()).toThrow(RegistryUnavailable);
    expect(() => revokeDevice(phone.id)).toThrow(RegistryUnavailable);
    expect(() => renameDevice(phone.id, 'Renamed')).toThrow(RegistryUnavailable);
    expect(readFileSync(file, 'utf8')).toBe('{"version": 2, "devices": [');
  });
});

describe('entries this version cannot read', () => {
  const malformed = '{"id":"bad","name":5}';
  const future =
    '{ "id" : "future-1",  "record":{"kind":"passkey","big":12345678901234567890,"n":1.0,"note":"a \\"quoted\\" ] }, [ { text","list":[1,[2,{"x":"}"}]]} }';
  const opaque = '"opaque"';
  const escaped = '{"id":"esc","note":"one \\" quote ] }","tail":"back\\\\"}';
  const unreadable = [malformed, future, opaque, escaped];
  const file = (name: string) => join(home, 'server', name);

  function interleave(name: string, first: PairedDevice, second: PairedDevice) {
    const records = [first, second].map((record) => JSON.stringify(record));
    writeFileSync(
      file(name),
      `{"version":2,"devices":[${malformed}, ${records[0]}, ${future},\n${records[1]},${opaque}, ${escaped}]}`,
    );
  }

  function expectKept(name: string, order: string[]) {
    const text = readFileSync(file(name), 'utf8');
    for (const raw of unreadable) expect(text).toContain(raw);
    const at = order.map((marker) => text.indexOf(marker));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual(at.toSorted((a, b) => a - b));
  }

  it('writes every kind of change next to them without touching them, in their places', () => {
    const first = pair('First');
    const second = pair('Second');
    interleave('devices.json', first, second);
    const order = [malformed, first.id, future, second.id, opaque, escaped];
    const at = Date.parse(first.lastSeenAt ?? '') + 120_000;

    touchDevice(first.id, { name: 'Stim Desktop', version: '1' }, at);
    expectKept('devices.json', order);
    renameDevice(second.id, 'Studio');
    expectKept('devices.json', order);
    expect(grantDevice(first.id, ['read', 'control'])).toBe('granted');
    expectKept('devices.json', order);
    expect(readDevices()).toMatchObject([
      { id: first.id, capabilities: ['read', 'control'], clientApp: 'Stim Desktop' },
      { id: second.id, name: 'Studio' },
    ]);

    const third = pair('Third');
    expectKept('devices.json', [...order, third.id]);
    expect(revokeDevice(first.id)).toBe(true);
    expectKept('devices.json', [malformed, future, second.id, opaque, escaped, third.id]);
    expect(readDevices().map((device) => device.id)).toEqual([second.id, third.id]);
  });

  it.each(['build', 'device-host'] as const)(
    'keeps them in the %s client registry through rename and revoke',
    (capability) => {
      const client = () => {
        const { ticket, key } = setup([capability]);
        const records = spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net');
        assert(records?.[capability]);
        return records[capability];
      };
      const first = client();
      const second = client();
      const name = `${capability}-clients.json`;
      interleave(name, first, second);
      renameDevice(first.id, 'Box');
      expectKept(name, [malformed, first.id, future, second.id, opaque, escaped]);
      expect(revokeDevice(first.id)).toBe(true);
      expectKept(name, [malformed, future, second.id, opaque, escaped]);
    },
  );

  it('lists them with their position and id, and reads none of them as a client', () => {
    interleave('devices.json', pair('First'), pair('Second'));
    expect(readDevices()).toHaveLength(2);
    expect(readUnreadable()).toEqual([
      { file: 'devices.json', index: 0, id: 'bad' },
      { file: 'devices.json', index: 2, id: 'future-1' },
      { file: 'devices.json', index: 4 },
      { file: 'devices.json', index: 5, id: 'esc' },
    ]);
  });
  it('keeps the other top-level members of a version 2 file as their text', () => {
    const first = pair('First');
    const others = '"label": {"keep":[1,2.0]}, "big":12345678901234567890';
    writeFileSync(
      file('devices.json'),
      `{"version":2, ${others.split(', ')[0]}, "devices":[${JSON.stringify(first)}], ${others.split(', ')[1]}}`,
    );
    renameDevice(first.id, 'Studio');
    pair('Second');
    const text = readFileSync(file('devices.json'), 'utf8');
    for (const member of others.split(', ')) expect(text).toContain(member);
    expect(readDevices().map((device) => device.name)).toEqual(['Studio', 'Second']);
  });

  it('refuses every write to a file that a newer Stim wrote, and lists it as a whole', () => {
    const phone = pair();
    const newer = JSON.stringify({ version: 3, devices: [{ id: phone.id, record: { kind: 'passkey' } }] });
    for (const name of ['devices.json', 'build-clients.json', 'device-host-clients.json']) {
      writeFileSync(file(name), newer);
    }
    expect(() => pair('Second')).toThrow(/version 3, which a newer Stim wrote/);
    expect(readUnreadable()).toEqual([
      { file: 'devices.json', version: 3 },
      { file: 'build-clients.json', version: 3 },
      { file: 'device-host-clients.json', version: 3 },
    ]);
    for (const name of ['devices.json', 'build-clients.json', 'device-host-clients.json']) {
      expect(readFileSync(file(name), 'utf8')).toBe(newer);
    }
  });

  it('writes none of the files a setup ticket records into when one of them is newer, and keeps the ticket', () => {
    const { ticket, key } = setup(['build', 'device-host']);
    mkdirSync(join(home, 'server'), { recursive: true });
    const newer = JSON.stringify({ version: 3, devices: [] });
    writeFileSync(file('device-host-clients.json'), newer);
    expect(() => spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')).toThrow(/version 3/);
    expect(existsSync(file('build-clients.json'))).toBe(false);
    expect(readFileSync(file('device-host-clients.json'), 'utf8')).toBe(newer);
    expect(secretPsk(lookupOf(ticket))).not.toBeNull();
    rmSync(file('device-host-clients.json'));
    expect(spendSecret(lookupOf(ticket), key, 'Laptop', 'laptop.ts.net')).toMatchObject({
      build: { publicKey: key },
      'device-host': { publicKey: key },
    });
  });

  it('still replaces a file of protocol 1 on the next write', () => {
    mkdirSync(join(home, 'server'));
    writeFileSync(file('devices.json'), JSON.stringify({ version: 1, devices: [{ id: 'old', token: 'secret' }] }));
    pair();
    expect(JSON.parse(readFileSync(file('devices.json'), 'utf8'))).toMatchObject({ version: 2 });
    expect(readUnreadable()).toEqual([]);
    expect(readFileSync(file('devices.json'), 'utf8')).not.toContain('secret');
  });
});
