import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  parsePlist,
  parseProvisioningProfilePlist,
  parseSigningIdentities,
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

test('parsePlist reads the container types a decoded profile contains', () => {
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

test('parsePlist refuses what is not a plist rather than guessing', () => {
  expect(parsePlist('')).toBe(null);
  expect(parsePlist(null)).toBe(null);
  expect(parsePlist('<html><body>nope</body></html>')).toBe('');
});

test('provisioningProfileKind names the four shapes the remedy has to distinguish', () => {
  expect(provisioningProfileKind(profile())).toBe('development');
  expect(provisioningProfileKind(profile('app-store-profile.plist'))).toBe('App Store');
  expect(provisioningProfileKind(profile('enterprise-profile.plist'))).toBe('enterprise');
  expect(provisioningProfileKind({ ...profile(), getTaskAllow: false })).toBe('ad hoc');
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

test('a pinned sha1 that is not in the keychain refuses and lists what is', () => {
  const refused = gate({ pinnedSha1: 'D'.repeat(40) });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('reason' in refused && refused.reason).toContain(JANE_SHA1);
});

test('a profile whose certificate has no readable subject refuses with the settings escape hatch', () => {
  const refused = gate({ profile: { ...profile(), certificates: [] } });
  expect(refused).toMatchObject({ ok: false, code: 'STIM_NO_SIGNING_IDENTITY' });
  expect('remedy' in refused && refused.remedy).toContain('ios.signingIdentity');
});

test('the refusal remedies name the explicit provisioning step and the Xcode build, never a build flag', () => {
  for (const refused of [
    gate({ profilePresent: false, profile: null }),
    gate({ profile: profile('expired-profile.plist') }),
    gate({ profile: profile('app-store-profile.plist') }),
    gate({ udid: STRANGER }),
  ]) {
    expect('remedy' in refused && refused.remedy).toMatch(/build once from Xcode/);
    expect('remedy' in refused && refused.remedy).toMatch(/stim device provision ios/);
  }
});
