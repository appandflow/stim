import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fingerprintProject } from '../cache/build-cache.ts';
import { firstSigningFile, isSigningKeystore } from '../offload/signing-files.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-signing-files-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = 'bytes'): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return path;
}

test.each([
  { path: 'android/app/release.keystore', left: true },
  { path: 'apps/other/upload.JKS', left: true },
  { path: 'android/keystore.properties', left: true },
  { path: 'android/app/upload.p12', left: true },
  { path: 'android/app/debug.keystore', left: false },
  { path: 'android/app/src/main/res/raw/truststore.jks', left: false },
  { path: 'android/app/src/main/assets/client.p12', left: false },
  { path: 'android/gradle.properties', left: false },
])('$path left out of an Android sync: $left', ({ path, left }) => {
  expect(isSigningKeystore(path)).toBe(left);
});

test.each([
  { name: 'a store password', path: 'android/signing.properties', text: 'storePassword=hunter2\n', found: true },
  {
    name: 'a project property password',
    path: 'android/gradle.properties',
    text: 'MYAPP_RELEASE_KEY_PASSWORD = x\n',
    found: true,
  },
  { name: 'a password in an env file', path: '.env.production', text: 'KEY_PASSWORD=x\n', found: true },
  { name: 'EAS local credentials', path: 'credentials.json', text: '{"keystorePassword": "x"}', found: true },
  {
    name: 'a literal in a Gradle script',
    path: 'android/app/build.gradle',
    text: "storePassword 'hunter2'\n",
    found: true,
  },
  {
    name: 'a literal in a Kotlin script',
    path: 'android/app/build.gradle.kts',
    text: 'keyPassword = "x"\n',
    found: true,
  },
  { name: 'the debug literal', path: 'android/app/build.gradle', text: "storePassword 'android'\n", found: false },
  {
    name: 'a Gradle property read',
    path: 'android/app/build.gradle',
    text: "keyPassword = props['keyPassword']\n",
    found: false,
  },
  { name: 'a Gradle interpolation', path: 'android/app/build.gradle', text: 'storePassword "$pw"\n', found: false },
  {
    name: 'a commented password',
    path: 'android/gradle.properties',
    text: '# MYAPP_KEY_PASSWORD=*****\n',
    found: false,
  },
  { name: 'an env template', path: '.env.example', text: 'STORE_PASSWORD=changeme\n', found: false },
  { name: 'an API key pass', path: '.env', text: 'GOOGLE_API_KEY_PASS=abc\n', found: false },
  {
    name: 'a keystore properties read',
    path: 'android/app/build.gradle',
    text: 'storePassword keystoreProperties[\'storePassword\']\nkeyPassword keystoreProperties["keyPassword"]\n',
    found: false,
  },
  {
    name: 'an empty assignment',
    path: 'android/gradle.properties',
    text: 'MYAPP_UPLOAD_STORE_PASSWORD=\nAPP_ALIAS=k\n',
    found: false,
  },
  { name: 'a null credential', path: 'credentials.json', text: '{"keyPassword": null}', found: false },
  {
    name: 'a docs placeholder',
    path: 'android/gradle.properties',
    text: 'MYAPP_UPLOAD_STORE_PASSWORD=*****\n',
    found: false,
  },
  { name: 'another word ending in key', path: '.env', text: 'MONKEY_PASSWORD=abc\n', found: false },
  {
    name: 'a TLS trust store',
    path: 'android/gradle.properties',
    text: 'javax.net.ssl.trustStorePassword=changeit\n',
    found: false,
  },
  {
    name: 'a password with a dollar',
    path: 'android/gradle.properties',
    text: 'MYAPP_UPLOAD_STORE_PASSWORD=P@ss$word\n',
    found: true,
  },
  {
    name: 'one line of JSON',
    path: 'credentials.json',
    text: '{"a":"x#y","keyPassword":null,"keystorePassword":"real"}',
    found: true,
  },
  {
    name: 'the React Native upload names',
    path: 'android/gradle.properties',
    text: 'MYAPP_UPLOAD_STORE_PASSWORD=x\nMYAPP_UPLOAD_KEY_PASSWORD=y\n',
    found: true,
  },
  {
    name: 'AGP injected signing',
    path: 'android/gradle.properties',
    text: 'android.injected.signing.store.password=x\n',
    found: true,
  },
  { name: 'an exported password', path: '.env', text: 'export KEY_PASSWORD="abc"\n', found: true },
  { name: 'an encryption key password', path: '.env', text: 'ENCRYPTION_KEY_PASSWORD=abc\n', found: false },
  { name: 'a JWT key password', path: '.env', text: 'JWT_KEY_PASSWORD=dev\n', found: false },
  { name: 'an App Store password', path: '.env', text: 'APP_STORE_PASSWORD=x\n', found: false },
  {
    name: 'a TLS key store',
    path: 'android/gradle.properties',
    text: 'systemProp.javax.net.ssl.keyStorePassword=changeit\n',
    found: false,
  },
  { name: 'a local env template', path: '.env.local.example', text: 'KEY_PASSWORD=changeme\n', found: false },
  { name: 'the debug password', path: 'android/gradle.properties', text: 'storePassword=android\n', found: false },
  {
    name: 'properties with no password',
    path: 'android/gradle.properties',
    text: 'hermesEnabled=true\n',
    found: false,
  },
  { name: 'a password word in another file type', path: 'README.md', text: 'storePassword=hunter2\n', found: false },
])('$name found: $found', async ({ path, text, found }) => {
  write(path, text);
  expect(await firstSigningFile(root, ['package.json', path], [])).toBe(found ? path : null);
});

test('the configured android.keystore counts under any name, resolved through a symlinked root', async () => {
  const path = write('android/signing/app.key');
  expect(await firstSigningFile(root, [path], [join(root, path)])).toBe(path);
  expect(await firstSigningFile(root, [path], [join(root, 'absent.key')])).toBe(null);
});

test('a password file that cannot be read counts as holding a password', async () => {
  expect(await firstSigningFile(root, ['android/gone.properties'], [])).toBe('android/gone.properties');
});

test.each([
  { path: 'android/app/release.keystore', platform: 'android' as const, moves: false },
  { path: 'android/keystore.properties', platform: 'android' as const, moves: false },
  { path: 'android/app/debug.keystore', platform: 'android' as const, moves: true },
  { path: 'android/app/src/main/res/raw/truststore.jks', platform: 'android' as const, moves: true },
  { path: 'android/app/src/main/assets/client.p12', platform: 'android' as const, moves: true },
  { path: 'ios/client.p12', platform: 'ios' as const, moves: true },
])('editing $path moves the $platform fingerprint: $moves', async ({ path, platform, moves }) => {
  write('package.json', '{"name":"app","version":"1.0.0"}');
  write('android/build.gradle', 'x');
  write('ios/Podfile', 'x');
  write(path, 'one');
  const before = await fingerprintProject(root, { platform });
  write(path, 'two');
  const after = await fingerprintProject(root, { platform });
  expect(after?.hash !== before?.hash).toBe(moves);
});
