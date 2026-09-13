import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  certificateCommonName,
  parsePlist,
  parseProvisioningProfilePlist,
  parseSigningIdentities,
  profileGate,
  provisioningProfileKind,
  signingGate,
  type ProvisioningProfile,
  type SigningIdentity,
} from '../engine/ios-profile.ts';

const PHONE = '00008030-001A2B3C4D5E802E';
const STRANGER = '00008101-999999999999999E';
const JANE = 'Apple Development: Jane Fixture (TEAMID5678)';
const JANE_SHA1 = '3FE19E227EC5BC2EDE3AC52AB02FF46920445C6A';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/ios-signing/${name}`, import.meta.url), 'utf-8');
}

function profile(name = 'development-profile.plist'): ProvisioningProfile {
  const parsed = parseProvisioningProfilePlist(fixture(name));
  if (!parsed) throw new Error(`fixture ${name} did not parse`);
  return parsed;
}

const BEFORE_EXPIRY = Date.parse('2026-09-01T00:00:00Z');
const IDENTITIES: SigningIdentity[] = parseSigningIdentities(fixture('find-identity.txt'));

test('parsePlist reads the container types security cms -D emits', () => {
  const value = parsePlist(
    '<plist version="1.0"><dict><key>a</key><string>x &amp; y</string>' +
      '<key>n</key><integer>7</integer><key>r</key><real>1.5</real>' +
      '<key>t</key><true/><key>f</key><false/>' +
      '<key>list</key><array><string>one</string><string>two</string></array>' +
      '<key>nested</key><dict><key>deep</key><string>value</string></dict>' +
      '<key>empty</key><array/></dict></plist>',
  );
  expect(value).toEqual({
    a: 'x & y',
    n: 7,
    r: 1.5,
    t: true,
    f: false,
    list: ['one', 'two'],
    nested: { deep: 'value' },
    empty: [],
  });
});

test('parsePlist fails closed on an out-of-range character reference', () => {
  expect(parsePlist('<plist version="1.0"><string>&#xFFFFFFF;</string></plist>')).toBe(null);
  expect(parsePlist('<plist version="1.0"><string>&#1114112;</string></plist>')).toBe(null);
  expect(parsePlist('<plist version="1.0"><string>&#xD800;</string></plist>')).toBe(null);
  expect(parsePlist('<plist version="1.0"><string>&#65;&#x42;</string></plist>')).toBe('AB');
});

test('parsePlist ignores XML comments, including markup hiding inside one', () => {
  expect(
    parsePlist(
      '<plist version="1.0"><dict><!-- <key>ghost</key><string>x</string> -->' +
        '<key>real</key><string>value</string></dict></plist>',
    ),
  ).toEqual({ real: 'value' });
});

test('a key with no value ends its dict instead of swallowing the parent', () => {
  expect(
    parsePlist(
      '<plist version="1.0"><dict><key>outer</key><dict><key>dangling</key></dict>' +
        '<key>after</key><string>kept</string></dict></plist>',
    ),
  ).toEqual({ outer: {}, after: 'kept' });
});

test('parsePlist refuses what is not a plist rather than guessing', () => {
  expect(parsePlist('')).toBe(null);
  expect(parsePlist(null)).toBe(null);
  expect(parsePlist('<html><body>nope</body></html>')).toBe('');
});

test('parseProvisioningProfilePlist reads the keys the gate decides on', () => {
  const parsed = profile();
  expect(parsed.name).toBe('iOS Team Provisioning Profile: com.example.stim');
  expect(parsed.uuid).toBe('9d1f8f6a-0e0c-4c33-9a1f-2b6a5c7d8e90');
  expect(parsed.teamIdentifier).toBe('TEAMID5678');
  expect(parsed.expirationDate?.toISOString()).toBe('2027-06-01T12:00:00.000Z');
  expect(parsed.provisionedDevices).toEqual([PHONE, '00008120-000A11223C44201E']);
  expect(parsed.provisionsAllDevices).toBe(false);
  expect(parsed.getTaskAllow).toBe(true);
  expect(parsed.certificates).toHaveLength(1);
  expect(parsed.certificates[0]!.length).toBeGreaterThan(500);
});

test('parseProvisioningProfilePlist returns null for input that is not a profile', () => {
  expect(parseProvisioningProfilePlist('not a plist')).toBe(null);
  expect(parseProvisioningProfilePlist('<plist version="1.0"><array/></plist>')).toBe(null);
});

test('provisioningProfileKind names the four shapes the remedy has to distinguish', () => {
  expect(provisioningProfileKind(profile())).toBe('development');
  expect(provisioningProfileKind(profile('app-store-profile.plist'))).toBe('App Store');
  expect(provisioningProfileKind(profile('enterprise-profile.plist'))).toBe('enterprise');
  expect(provisioningProfileKind({ ...profile(), getTaskAllow: false })).toBe('ad hoc');
});

test('certificateCommonName pulls the identity name out of a real X509 subject', () => {
  expect(certificateCommonName(profile().certificates[0])).toBe(JANE);
  expect(certificateCommonName(Buffer.from('not a certificate'))).toBe(null);
  expect(certificateCommonName(null)).toBe(null);
});

test('parseSigningIdentities scrapes what security find-identity prints', () => {
  expect(IDENTITIES).toEqual([
    { sha1: JANE_SHA1, name: JANE },
    { sha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678', name: 'Apple Distribution: Fixture Inc (TEAMID5678)' },
  ]);
  expect(parseSigningIdentities(fixture('find-identity-empty.txt'))).toEqual([]);
  expect(parseSigningIdentities(null)).toEqual([]);
});

function gate(overrides: Partial<Parameters<typeof signingGate>[0]> = {}) {
  return signingGate({
    profilePresent: true,
    profile: profile(),
    identities: IDENTITIES,
    udid: PHONE,
    now: BEFORE_EXPIRY,
    ...overrides,
  });
}

test('the gate admits a development profile that names the phone and an identity in the keychain', () => {
  expect(gate()).toEqual({ ok: true, identity: { sha1: JANE_SHA1, name: JANE } });
});

test('profileGate stops at the profile: an install that modifies nothing needs no identity', () => {
  const admitted = profileGate({
    profilePresent: true,
    profile: profile(),
    identities: [],
    udid: PHONE,
    now: BEFORE_EXPIRY,
  });
  expect(admitted).toMatchObject({ ok: true });
  expect('profile' in admitted && admitted.profile.name).toBe(profile().name);
  expect(
    profileGate({ profilePresent: true, profile: profile(), identities: [], udid: STRANGER, now: BEFORE_EXPIRY }),
  ).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
});

test('a bundle with no embedded.mobileprovision is STIM_NO_PROFILE, not a codesign attempt', () => {
  const refused = gate({ profilePresent: false, profile: null });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
  expect('remedy' in refused && refused.remedy).toMatch(/Signing & Capabilities/);
  expect('remedy' in refused && refused.remedy).toMatch(/changes your Apple Developer account/);
});

test('a profile that will not decode is STIM_NO_PROFILE too', () => {
  expect(gate({ profile: null })).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
});

test('an expired profile is STIM_PROFILE_MISMATCH and the message names the date', () => {
  const refused = gate({ profile: profile('expired-profile.plist') });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in refused && refused.reason).toContain('2024-02-03');
});

test('a profile that is still in date but expires before now is refused on the boundary', () => {
  const expiry = Date.parse('2027-06-01T12:00:00Z');
  expect(gate({ now: expiry - 1 })).toMatchObject({ ok: true });
  expect(gate({ now: expiry })).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
});

test('an App Store or enterprise profile is refused by name, because it cannot prove the device', () => {
  const store = gate({ profile: profile('app-store-profile.plist') });
  expect(store).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in store && store.reason).toContain('App Store');
  expect('reason' in store && store.reason).toContain('ProvisionedDevices');
  expect('remedy' in store && store.remedy).toMatch(/development profile/);

  const enterprise = gate({ profile: profile('enterprise-profile.plist') });
  expect('reason' in enterprise && enterprise.reason).toContain('enterprise');
});

test('a development profile that does not list this phone is refused with the udid named', () => {
  const refused = gate({ udid: STRANGER });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
  expect('reason' in refused && refused.reason).toContain(STRANGER);
  expect('remedy' in refused && refused.remedy).toContain(STRANGER);
});

test('the device list is matched case-insensitively', () => {
  expect(gate({ udid: PHONE.toLowerCase() })).toMatchObject({ ok: true });
});

test('an empty keychain is STIM_NO_SIGNING_IDENTITY', () => {
  const refused = gate({ identities: [] });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toMatch(/Xcode > Settings > Accounts/);
});

test('an artifact signed by someone else is detected before any codesign runs', () => {
  const refused = gate({
    identities: [{ sha1: 'C'.repeat(40), name: 'Apple Development: Someone Else (OTHERTEAM)' }],
  });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('reason' in refused && refused.reason).toContain(JANE);
  expect('reason' in refused && refused.reason).toContain('Someone Else');
});

test('two certificates sharing a common name are refused rather than picked between', () => {
  const refused = gate({ identities: parseSigningIdentities(fixture('find-identity-duplicate.txt')) });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toContain('ios.signingIdentitySha1');
});

test('ios.signingIdentitySha1 disambiguates and wins over the name', () => {
  expect(
    gate({
      identities: parseSigningIdentities(fixture('find-identity-duplicate.txt')),
      pinnedSha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
  ).toEqual({ ok: true, identity: { sha1: 'B'.repeat(40), name: JANE } });
});

test('a pinned sha1 that is not in the keychain refuses and lists what is', () => {
  const refused = gate({ pinnedSha1: 'D'.repeat(40) });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('reason' in refused && refused.reason).toContain(JANE_SHA1);
});

test('ios.signingIdentity overrides the identity derived from the profile', () => {
  expect(gate({ pinnedName: 'Apple Distribution: Fixture Inc (TEAMID5678)' })).toEqual({
    ok: true,
    identity: {
      sha1: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678',
      name: 'Apple Distribution: Fixture Inc (TEAMID5678)',
    },
  });
});

test('a profile whose certificate has no readable subject refuses with the settings escape hatch', () => {
  const refused = gate({ profile: { ...profile(), certificates: [] } });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toContain('ios.signingIdentity');
});

test('the gate checks the profile before the keychain, so a bad profile is not masked', () => {
  const refused = gate({ profile: profile('expired-profile.plist'), identities: [] });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
});

test('the refusal remedies name the manual Xcode step rather than a flag Stim could pass', () => {
  for (const refused of [
    gate({ profilePresent: false, profile: null }),
    gate({ profile: profile('expired-profile.plist') }),
    gate({ profile: profile('app-store-profile.plist') }),
    gate({ udid: STRANGER }),
  ]) {
    expect('remedy' in refused && refused.remedy).toMatch(/build once from Xcode/);
  }
});
