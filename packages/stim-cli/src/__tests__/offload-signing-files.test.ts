import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { androidSyncPlan, isSigningKeystore } from '../offload/signing-files.ts';

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

async function firstFound(paths: string[], configured: string[]): Promise<string | null> {
  const { refusal } = await androidSyncPlan(root, paths, { release: true, configured, projectScripts: [] });
  return refusal ? (paths.find((path) => refusal.startsWith(path)) ?? null) : null;
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
  {
    name: 'a commented Gradle literal',
    path: 'android/app/build.gradle',
    text: "// storePassword 'secret'\n/* keyPassword 'x' */\n",
    found: false,
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
  {
    name: 'a TLS key store',
    path: 'android/gradle.properties',
    text: 'systemProp.javax.net.ssl.keyStorePassword=changeit\n',
    found: false,
  },
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
  expect(await firstFound(['package.json', path], [])).toBe(found ? path : null);
});

test('the configured android.keystore counts under any name, resolved through a symlinked root', async () => {
  const path = write('android/signing/app.key');
  expect(await firstFound([path], [join(root, path)])).toBe(path);
  expect(await firstFound([path], [join(root, 'absent.key')])).toBe(null);
});

test('a password file that cannot be read counts as holding a password', async () => {
  expect(await firstFound(['android/gone.properties'], [])).toBe('android/gone.properties');
});

test.each([
  { name: 'a .env holding a signing password', path: '.env', text: 'MYAPP_UPLOAD_STORE_PASSWORD=x\n' },
  { name: 'a gitignored password file', path: 'android/signing.properties', text: 'storePassword=x\n' },
])('a debug offload is not refused over $name', async ({ path, text }) => {
  write(path, text);
  const plan = await androidSyncPlan(root, [path], { release: false, configured: [], projectScripts: [] });
  expect(plan).toEqual({ omit: new Set(), refusal: null });
});

test('a release offload is not refused over a .env holding a signing password', async () => {
  write('.env', 'MYAPP_UPLOAD_STORE_PASSWORD=x\n');
  expect(await firstFound(['.env'], [])).toBe(null);
});

test.each([
  { release: false, script: 'plain', omitted: true },
  { release: false, script: "file('keystore.properties')", omitted: false },
  { release: true, script: "file('keystore.properties')", omitted: true },
])(
  'release $release with a script reading $script omits keystore.properties: $omitted',
  async ({ release, script, omitted }) => {
    const paths = [write('android/keystore.properties', 'x'), write('android/app/build.gradle', script)];
    const plan = await androidSyncPlan(root, paths, { release, configured: [], projectScripts: [] });
    expect(plan.omit.has('android/keystore.properties')).toBe(omitted);
  },
);

test('a script generated outside the synced files still keeps the file it names on debug', async () => {
  const path = write('android/app/custom.keystore', 'x');
  const script = join(root, 'generated.gradle');
  writeFileSync(script, "storeFile file('custom.keystore')");
  const plan = await androidSyncPlan(root, [path], { release: false, configured: [], projectScripts: [script] });
  expect(plan.omit.size).toBe(0);
});
