import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  EMBEDDED_PROFILE,
  findSigningIdentities,
  gateAppForDevice,
  gateProfileForDevice,
  readEmbeddedProfile,
  resealBundle,
  sealAppForDevice,
  type ResealFailure,
  type ResealMode,
  type ResealSuccess,
  type SigningGateOptions,
} from '../engine/ios-signing.ts';
import { certificateCommonName, type SigningIdentity, type SigningRefusalCode } from '../engine/ios-profile.ts';

const PHONE = '00008030-001A2B3C4D5E802E';
const STRANGER = '00008101-999999999999999E';
const JANE = 'Apple Development: Jane Fixture (TEAMID5678)';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/ios-signing/${name}`, import.meta.url), 'utf-8');
}

const BEFORE_EXPIRY = Date.parse('2026-09-01T00:00:00Z');

const SCRATCH_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.stimcli.scratch</string>
<key>CFBundleExecutable</key><string>Scratch</string>
<key>CFBundleName</key><string>Scratch</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

const SCRATCH_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>get-task-allow</key><true/>
<key>keychain-access-groups</key><array><string>TEAMID5678.*</string></array>
</dict></plist>
`;

const AD_HOC: SigningIdentity = { sha1: '', name: '-' };

describe('the re-seal primitive against the real codesign and security', { timeout: 60_000 }, () => {
  beforeAll(() => {
    if (process.platform !== 'darwin')
      throw new Error('Compatibility requires macOS with codesign, security, clang and openssl.');
    for (const tool of ['codesign', 'security', 'clang', 'openssl']) {
      getExecutor().run('command -v ' + tool, { timeoutMs: 15_000 });
    }
  });

  let dir: string;
  let appPath: string;

  function writeScratchApp(): void {
    appPath = join(dir, 'Scratch.app');
    mkdirSync(appPath, { recursive: true });
    writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n');
    writeFileSync(join(appPath, 'Info.plist'), SCRATCH_INFO_PLIST);
    writeFileSync(join(dir, 'entitlements.plist'), SCRATCH_ENTITLEMENTS);
    writeFileSync(join(appPath, 'ip.txt'), '10.0.0.132:8081');
    const exec = getExecutor();
    exec.runFile('clang', ['-o', join(appPath, 'Scratch'), join(dir, 'main.c')]);
    exec.runFile('codesign', [
      '--force',
      '--sign',
      '-',
      '--entitlements',
      join(dir, 'entitlements.plist'),
      '--timestamp=none',
      appPath,
    ]);
  }

  function sealIsValid(): boolean {
    return getExecutor().runQuiet(`codesign --verify --strict ${JSON.stringify(appPath)}`) !== null;
  }

  function entitlementsOf(): string {
    return getExecutor().runFile('codesign', ['-d', '--entitlements', '-', '--xml', appPath]);
  }

  beforeEach(() => {
    resetExecutor();
    dir = mkdtempSync(join(tmpdir(), 'stim-reseal-'));
    writeScratchApp();
  });

  afterEach(() => {
    resetExecutor();
    rmSync(dir, { recursive: true, force: true });
  });

  test('rewriting a sealed resource really does break the seal, which is why the re-seal exists', () => {
    expect(sealIsValid()).toBe(true);
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    expect(sealIsValid()).toBe(false);
  });

  test('the preferred form re-seals a mutated bundle and carries its entitlements over verbatim', () => {
    const before = entitlementsOf();
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    expect(sealIsValid()).toBe(false);

    const result = resealBundle({ appPath, identity: AD_HOC });
    expect(result).toEqual({ ok: true, identity: AD_HOC, mode: 'preserve-metadata' });
    expect(sealIsValid()).toBe(true);
    expect(entitlementsOf()).toBe(before);
    expect(readFileSync(join(appPath, 'ip.txt'), 'utf-8')).toBe('192.168.1.42:8085');
    expect(entitlementsOf()).toContain('keychain-access-groups');
  });

  test('the entitlements fallback re-seals for real when --preserve-metadata is rejected', () => {
    const real = getExecutor();
    const before = entitlementsOf();
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    setExecutor({
      runFile(file: string, args: string[], opts?: unknown) {
        if (file === 'codesign' && args.some((a) => a.startsWith('--preserve-metadata='))) {
          throw Object.assign(new Error('codesign: unknown option --preserve-metadata'), {
            stderr: 'codesign: unknown option --preserve-metadata',
          });
        }
        return real.runFile(file, args, opts as never);
      },
    });

    const result = resealBundle({ appPath, identity: AD_HOC });
    resetExecutor();
    expect(result).toEqual({ ok: true, identity: AD_HOC, mode: 'entitlements' });
    expect(sealIsValid()).toBe(true);
    expect(entitlementsOf()).toBe(before);
  });

  test('a bundle codesign will not sign reports STIM_CODESIGN_FAILED with the real stderr', () => {
    const result = resealBundle({ appPath: join(dir, 'Missing.app'), identity: AD_HOC });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'STIM_CODESIGN_FAILED' });
    expect('lastLines' in result && result.lastLines.join(' ')).toMatch(/Missing\.app/);
  });

  test('readEmbeddedProfile decodes a real CMS-wrapped profile through security cms -D', () => {
    const exec = getExecutor();
    const key = join(dir, 'signer.key');
    const pem = join(dir, 'signer.pem');
    exec.runFile('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${JANE}/OU=TEAMID5678/O=Fixture Inc/C=US`,
    ]);
    const plist = join(dir, 'profile.plist');
    writeFileSync(plist, fixture('development-profile.plist'));
    exec.runFile('openssl', [
      'smime',
      '-sign',
      '-nodetach',
      '-binary',
      '-in',
      plist,
      '-signer',
      pem,
      '-inkey',
      key,
      '-outform',
      'DER',
      '-out',
      join(appPath, EMBEDDED_PROFILE),
    ]);

    const read = readEmbeddedProfile(appPath);
    expect(read.present).toBe(true);
    expect(read.profile?.provisionedDevices).toContain(PHONE);
    expect(read.profile?.expirationDate?.toISOString()).toBe('2027-06-01T12:00:00.000Z');
    expect(certificateCommonName(read.profile?.certificates[0])).toBe(JANE);
  }, 60_000);

  test('an app with no embedded.mobileprovision reads as absent rather than throwing', () => {
    expect(readEmbeddedProfile(appPath)).toEqual({ present: false, profile: null });
  });

  test('a profile that is not CMS at all reads as present but undecodable', () => {
    writeFileSync(join(appPath, EMBEDDED_PROFILE), 'not a CMS blob');
    expect(readEmbeddedProfile(appPath)).toEqual({ present: true, profile: null });
  });

  test('gateAppForDevice refuses a bundle with no profile, without reaching codesign', () => {
    const options: SigningGateOptions = { appPath, udid: PHONE, configuration: 'Release' };
    const gated = gateAppForDevice(options);
    expect(gated).toMatchObject({ ok: false, code: 'STIM_NO_PROFILE' });
    expect(sealIsValid()).toBe(true);
  });

  test('sealAppForDevice returns the gate refusal with no lines, so a caller can print one shape', () => {
    const failure = sealAppForDevice({ appPath, udid: PHONE }) as ResealFailure;
    expect(failure.ok).toBe(false);
    const codes: SigningRefusalCode[] = [
      'STIM_NO_PROFILE',
      'STIM_PROFILE_MISMATCH',
      'STIM_NO_SIGNING_IDENTITY',
      'STIM_CODESIGN_FAILED',
    ];
    expect(codes).toContain(failure.code);
    expect(failure.lastLines).toEqual([]);
  });

  test('sealAppForDevice refuses a real profile that does not name the target phone', () => {
    const exec = getExecutor();
    const key = join(dir, 'signer.key');
    const pem = join(dir, 'signer.pem');
    exec.runFile('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${JANE}/OU=TEAMID5678/O=Fixture Inc/C=US`,
    ]);
    const plist = join(dir, 'profile.plist');
    writeFileSync(plist, fixture('development-profile.plist'));
    exec.runFile('openssl', [
      'smime',
      '-sign',
      '-nodetach',
      '-binary',
      '-in',
      plist,
      '-signer',
      pem,
      '-inkey',
      key,
      '-outform',
      'DER',
      '-out',
      join(appPath, EMBEDDED_PROFILE),
    ]);

    const refused = sealAppForDevice({ appPath, udid: STRANGER, now: BEFORE_EXPIRY });
    expect(refused).toMatchObject({ ok: false, code: 'STIM_PROFILE_MISMATCH' });
    expect('reason' in refused && refused.reason).toContain(STRANGER);
  }, 60_000);

  test('a successful re-seal reports which of the two forms sealed it', () => {
    writeFileSync(join(appPath, 'ip.txt'), '192.168.1.42:8085');
    const sealed = resealBundle({ appPath, identity: AD_HOC }) as ResealSuccess;
    const modes: ResealMode[] = ['preserve-metadata', 'entitlements', 'no-entitlements'];
    expect(modes).toContain(sealed.mode);
    expect(sealed.identity).toEqual(AD_HOC);
  });

  test('gateProfileForDevice decodes the real profile and never asks the keychain', () => {
    const exec = getExecutor();
    const key = join(dir, 'gate.key');
    const pem = join(dir, 'gate.pem');
    exec.runFile('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      key,
      '-out',
      pem,
      '-days',
      '30',
      '-nodes',
      '-subj',
      `/CN=${JANE}/OU=TEAMID5678/O=Fixture Inc/C=US`,
    ]);
    const plist = join(dir, 'gate-profile.plist');
    writeFileSync(plist, fixture('development-profile.plist'));
    exec.runFile('openssl', [
      'smime',
      '-sign',
      '-nodetach',
      '-binary',
      '-in',
      plist,
      '-signer',
      pem,
      '-inkey',
      key,
      '-outform',
      'DER',
      '-out',
      join(appPath, EMBEDDED_PROFILE),
    ]);

    const calls: string[][] = [];
    const real = getExecutor();
    setExecutor({
      runFile(file: string, args: string[], opts?: Record<string, unknown>) {
        calls.push([file, ...args]);
        return real.runFile(file, args, opts as never);
      },
    });
    let gated;
    try {
      gated = gateProfileForDevice({ appPath, udid: PHONE, now: BEFORE_EXPIRY });
    } finally {
      resetExecutor();
    }
    expect(gated).toMatchObject({ ok: true });
    expect(calls.some((c) => c.includes('cms'))).toBe(true);
    expect(calls.some((c) => c.includes('find-identity'))).toBe(false);
    expect(sealIsValid()).toBe(false);
  }, 60_000);

  test('findSigningIdentities parses whatever this machine really has in its keychain', () => {
    for (const identity of findSigningIdentities()) {
      expect(identity.sha1).toMatch(/^[0-9A-F]{40}$/);
      expect(identity.name.length).toBeGreaterThan(0);
    }
  });
});
