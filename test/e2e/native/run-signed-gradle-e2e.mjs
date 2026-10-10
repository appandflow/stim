import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { workspaceStateDir } from '../../../packages/core/dist/index.mjs';
import { readClaimSet } from '../../../packages/core/dist/ownership-claim.mjs';
import {
  buildSlotPath,
  getProject,
  readWorkspaceState,
  workspaceAgentDeviceDir,
} from '../../../packages/core/dist/state.mjs';

const { sync: spawnSync } = createRequire(resolve('packages/stim-cli/package.json'))('cross-spawn');
const [mode, supplied] = process.argv.slice(2);
assert(
  ['prepare', 'run', 'cleanup'].includes(mode) && supplied,
  'usage: run-signed-gradle-e2e.mjs prepare|run|cleanup <owned-output>',
);
assert(process.env.RUNNER_TEMP, 'This fixture runs only in a hosted CI task directory.');
const output = resolve(supplied);
assert.equal(output, resolve(process.env.RUNNER_TEMP, 'native-signed-flavor'));
if (mode === 'prepare') assert(!existsSync(output), 'Refuse to overwrite a prior fixture.');
mkdirSync(output, { recursive: true });
const fixture = join(realpathSync.native(output), 'project');
const logs = join(output, 'evidence');
const home = join(output, 'stim-home');
const cli = resolve('packages/stim-cli/dist/cli.mjs');
const signing = join(output, 'signing');
const activeKey = join(signing, 'active.jks');
const publicApks = join(output, 'public-apks');
const ownerPath = join(output, 'fixture-owner.json');
const owner = { schema: 1, kind: 'native-signed-flavor', output, fixture };
if (mode === 'prepare') write(ownerPath, JSON.stringify(owner));
else assert.deepEqual(JSON.parse(readFileSync(ownerPath, 'utf8')), owner);
process.env.STIM_HOME = home;
const env = {
  ...process.env,
  GRADLE_USER_HOME: join(output, 'gradle-home'),
  STIM_MAX_BUILDS: '1',
  STIM_QA_KEYSTORE: activeKey,
  STIM_QA_SIGN_RELEASE: 'true',
  AGENT_DEVICE_HOME: join(output, 'agent-device'),
  AGENT_DEVICE_CLAIMS_DIR: join(output, 'agent-claims'),
  AGENT_DEVICE_STATE_DIR: workspaceAgentDeviceDir(fixture),
};
let activeAgentSerial;
mkdirSync(logs, { recursive: true });
function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
function command(label, file, args, { cwd = fixture, allowFailure = false, timeout = 20 * 60_000 } = {}) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  write(join(logs, `${label}.log`), text);
  write(join(logs, `${label}.stdout`), result.stdout ?? '');
  write(join(logs, `${label}.stderr`), result.stderr ?? '');
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, `${label}: ${text.slice(-12000)}`);
  return { ...result, text };
}
function stim(label, args, options) {
  return command(label, process.execPath, [cli, ...args], options);
}
function agent(label, args) {
  return command(
    label,
    'agent-device',
    [...args, '--platform', 'android', '--serial', activeAgentSerial, '--session', 'native-signed-flavor-ui'],
    { timeout: 5 * 60_000 },
  );
}
function closeAgent(label) {
  if (!activeAgentSerial) return;
  agent(label, ['close']);
  activeAgentSerial = undefined;
}
function verifyUi(label, facts, beforePid, revision) {
  assert.equal(facts.agentDevice?.stateDir, env.AGENT_DEVICE_STATE_DIR);
  activeAgentSerial = facts.serial;
  agent(`${label}-ui-open`, ['open', facts.bundleId, '--foreground']);
  const afterOpen = command(
    `${label}-pid-after-ui-open`,
    'adb',
    ['-s', facts.serial, 'shell', 'pidof', facts.bundleId],
    { timeout: 10_000 },
  );
  assert.equal(afterOpen.stdout.trim(), beforePid, 'UI attachment replaced the Stim-launched app process.');
  agent(`${label}-ui-revision`, ['wait', 'text', `Native QA ${revision}`, '10000']);
  agent(`${label}-ui-counter-zero`, ['wait', 'text', 'Taps: 0', '10000']);
  agent(`${label}-ui-press`, ['press', 'label="Increment native counter"', '--settle']);
  agent(`${label}-ui-counter-one`, ['wait', 'text', 'Taps: 1', '10000']);
  const screenshot = join(logs, `${label}-counter.png`);
  agent(`${label}-ui-screenshot`, ['screenshot', screenshot]);
  assert(statSync(screenshot).size > 0, 'The UI screenshot artifact is empty.');
  const afterInteraction = command(
    `${label}-pid-after-ui-interaction`,
    'adb',
    ['-s', facts.serial, 'shell', 'pidof', facts.bundleId],
    { timeout: 10_000 },
  );
  assert.equal(afterInteraction.stdout.trim(), beforePid, 'UI interaction replaced the Stim-launched app process.');
  const nativeLog = command(
    `${label}-native-log`,
    'adb',
    ['-s', facts.serial, 'shell', 'logcat', '-d', `--pid=${beforePid}`, '-s', 'StimNativeQa:I', '*:S'],
    { timeout: 10_000 },
  );
  assert.match(nativeLog.stdout, /counter=1/);
  closeAgent(`${label}-ui-close`);
  write(
    join(logs, `${label}-ui.json`),
    JSON.stringify({ label, revision, serial: facts.serial, pid: beforePid, screenshot }, null, 2),
  );
}
async function waitDeviceGone(label, serial) {
  const deadline = Date.now() + 30_000;
  let present;
  let attempt = 0;
  do {
    const devices = command(`${label}-${++attempt}`, 'adb', ['devices'], { timeout: 10_000 });
    present = devices.stdout.split('\n').some((line) => line.startsWith(`${serial}\t`));
    if (!present || Date.now() >= deadline) break;
    await sleep(250);
  } while (Date.now() < deadline);
  assert(!present, `owned emulator ${serial} still listed by adb after stop`);
}
const sourceFile = join(fixture, 'mobile/src/main/java/org/example/stim/MainActivity.kt');
const source = `package org.example.stim
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
class MainActivity : ComponentActivity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContent {
      val taps = remember { mutableStateOf(0) }
      Column(Modifier.padding(24.dp)) {
        BasicText("Native QA initial")
        BasicText("Taps: " + taps.value)
        BasicText("Increment native counter", Modifier.clickable { taps.value += 1; Log.i("StimNativeQa", "counter=" + taps.value) }.padding(16.dp))
      }
    }
  }
}
`;
if (mode === 'prepare') {
  const base = '4be32e3ced015cec3c7e335ab34bde659bc4acf3';
  const gitOptions = { cwd: process.cwd(), timeout: 30_000 };
  command('source-ancestor', 'git', ['merge-base', '--is-ancestor', base, 'HEAD'], gitOptions);
  const changed = command('source-diff', 'git', ['diff', '--name-only', base, 'HEAD'], gitOptions)
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert(
    changed.every((path) =>
      ['.github/workflows/e2e-native.yml', 'test/e2e/native/run-signed-gradle-e2e.mjs'].includes(path),
    ),
    `QA branch changes production inputs: ${changed.join(', ')}`,
  );
  const head = command('source-head', 'git', ['rev-parse', 'HEAD'], gitOptions).stdout.trim();
  write(join(logs, 'source.json'), JSON.stringify({ base, head, changed }, null, 2));
  mkdirSync(signing, { recursive: true });
  for (const name of ['one', 'two']) {
    const key = join(signing, `${name}.jks`);
    const certificate = join(logs, `${name}-certificate.der`);
    command(
      `key-${name}`,
      'keytool',
      [
        '-genkeypair',
        '-alias',
        'qa',
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '30',
        '-keystore',
        key,
        '-storepass',
        'android',
        '-keypass',
        'android',
        '-dname',
        `CN=Stim Native QA ${name}`,
        '-noprompt',
      ],
      { cwd: output, timeout: 30_000 },
    );
    command(
      `certificate-${name}`,
      'keytool',
      ['-exportcert', '-alias', 'qa', '-keystore', key, '-storepass', 'android', '-file', certificate],
      { cwd: output, timeout: 30_000 },
    );
  }
  copyFileSync(join(signing, 'one.jks'), activeKey);
  const bootstrap = join(output, 'wrapper');
  write(join(bootstrap, 'settings.gradle'), "rootProject.name = 'wrapper'\n");
  command('wrapper', 'gradle', ['wrapper', '--gradle-version', '8.13', '--distribution-type', 'bin'], {
    cwd: bootstrap,
  });
  for (const file of [
    'gradlew',
    'gradlew.bat',
    'gradle/wrapper/gradle-wrapper.jar',
    'gradle/wrapper/gradle-wrapper.properties',
  ]) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    copyFileSync(join(bootstrap, file), join(fixture, file));
  }
  if (process.platform !== 'win32') command('wrapper-executable', 'chmod', ['+x', join(fixture, 'gradlew')]);
  write(
    join(fixture, 'settings.gradle.kts'),
    `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "NativeQa"
include(":mobile")
`,
  );
  write(
    join(fixture, 'gradle/libs.versions.toml'),
    `[versions]
agp = "8.13.2"
kotlin = "2.1.20"
[plugins]
android = { id = "com.android.application", version.ref = "agp" }
kotlin = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
`,
  );
  write(
    join(fixture, 'build.gradle.kts'),
    `plugins { alias(libs.plugins.android) apply false; alias(libs.plugins.kotlin) apply false; alias(libs.plugins.compose) apply false }
`,
  );
  write(
    join(fixture, 'gradle.properties'),
    `org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=fail
org.gradle.daemon=false
org.gradle.workers.max=2
org.gradle.jvmargs=-Xmx3g
android.useAndroidX=true
`,
  );
  write(
    join(fixture, 'native-conventions.gradle'),
    `android {
  namespace 'org.example.stim'
  compileSdk 36
  defaultConfig { applicationId 'org.example.stim'; minSdk 24; targetSdk 34; versionCode 1; versionName '1.0' }
  flavorDimensions 'tier'
  productFlavors { free { dimension 'tier'; applicationIdSuffix '.free' }; paid { dimension 'tier'; applicationIdSuffix '.paid' } }
  signingConfigs { qa {
    storeFile file(providers.environmentVariable('STIM_QA_KEYSTORE').get())
    storePassword 'android'
    keyAlias 'qa'
    keyPassword 'android'
  } }
  buildTypes {
    debug { applicationIdSuffix '.debug'; signingConfig signingConfigs.qa }
    release {
      minifyEnabled false
      if (providers.environmentVariable('STIM_QA_SIGN_RELEASE').get() == 'true') signingConfig signingConfigs.qa
    }
  }
  buildFeatures { compose true }
  compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = '17' }
}
`,
  );
  write(
    join(fixture, 'mobile/build.gradle.kts'),
    `plugins { alias(libs.plugins.android); alias(libs.plugins.kotlin); alias(libs.plugins.compose) }
apply(from = "../native-conventions.gradle")
dependencies {
  implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.compose.foundation:foundation:1.8.3")
}
`,
  );
  write(
    join(fixture, 'mobile/src/main/AndroidManifest.xml'),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Stim Native QA" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name="org.example.stim.MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n`,
  );
  write(sourceFile, source);
  write(
    join(fixture, '.stim.json'),
    JSON.stringify({
      android: { systemImage: 'system-images;android-34;google_apis;x86_64' },
      optimizations: { android: { compilerCache: 'none' } },
    }),
  );
  write(
    join(logs, 'pins.json'),
    JSON.stringify(
      {
        gradle: '8.13',
        agp: '8.13.2',
        kotlin: '2.1.20',
        composeFoundation: '1.8.3',
        activityCompose: '1.10.1',
        compileSdk: 36,
        emulatorApi: 34,
        agentDevice: '0.21.22',
      },
      null,
      2,
    ),
  );
}
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function tool(name) {
  const suffix = process.platform === 'win32' ? (name === 'apksigner' ? '.bat' : '.exe') : '';
  assert(env.ANDROID_HOME, 'ANDROID_HOME is required');
  const path = join(env.ANDROID_HOME, 'build-tools', '36.0.0', `${name}${suffix}`);
  assert(existsSync(path), `${name} 36.0.0 is unavailable`);
  return path;
}
function apkIdentity(label, path) {
  const signatures = command(`${label}-signature`, tool('apksigner'), ['verify', '--print-certs', path], {
    timeout: 30_000,
  }).stdout;
  const signers = [...signatures.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([\da-fA-F]{64})$/gm)].map(
    (match) => match[1].toLowerCase(),
  );
  assert.equal(signers.length, 1, 'Expected one test signer');
  const badging = command(`${label}-badging`, tool('aapt'), ['dump', 'badging', path], { timeout: 30_000 }).stdout;
  const packageName = badging.match(/^package: name='([^']+)'/m)?.[1];
  assert(packageName, 'aapt did not return the package');
  return { sha256: digest(path), signer: signers[0], package: packageName };
}
function lastGradleMessages(label) {
  const files = readdirSync(home, { recursive: true }).filter((file) => file.endsWith('build-android.ndjson'));
  assert.equal(files.length, 1);
  const records = readFileSync(join(home, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
  const start = records.findLastIndex((entry) => entry.event === 'build_start');
  assert(start >= 0);
  const messages = records
    .slice(start)
    .map((entry) => entry.msg)
    .join('\n');
  write(join(logs, `${label}-gradle.log`), messages);
  return messages;
}
function refused(label, variant, message) {
  const before = readWorkspaceState(fixture)?.launches;
  const result = stim(label, ['android', '--variant', variant, '--json'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout.trim()).code, 'STIM_BUILD_FAILED');
  assert.match(result.text, message);
  const state = readWorkspaceState(fixture);
  const history = state.buildHistory?.android?.[0];
  assert.equal(history?.result, 'failed');
  assert(!('install' in history.phases) && !('launch' in history.phases), 'Refused artifact reached deployment');
  assert.deepEqual(state.launches, before, 'Refusal replaced the saved launch');
  write(join(logs, `${label}-state.json`), JSON.stringify(state, null, 2));
}
async function cleanup() {
  const errors = [];
  const before = getProject(fixture)?.platforms?.android;
  const serial = before?.serial ?? (before?.consolePort ? `emulator-${before.consolePort}` : null);
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      errors.push({ label, message: error.stack ?? String(error) });
    }
  };
  await attempt('agent-session', () => closeAgent('cleanup-agent-close'));
  await attempt('agent-daemon', () => {
    if (existsSync(env.AGENT_DEVICE_STATE_DIR))
      command('cleanup-agent-daemon', 'agent-device', ['daemon', 'stop', '--state-dir', env.AGENT_DEVICE_STATE_DIR], {
        timeout: 30_000,
      });
  });
  await attempt('stim-stop', () => {
    if (existsSync(join(output, 'native-attempted.json'))) {
      const result = stim('cleanup-stop', ['stop', '--json'], { timeout: 3 * 60_000 });
      assert.equal(JSON.parse(result.stdout.trim()).ok, true);
    }
  });
  await attempt('device-settlement', async () => {
    if (serial) await waitDeviceGone('cleanup-devices', serial);
  });
  await attempt('claims', () => {
    for (const path of [join(workspaceStateDir(fixture), 'native-run.lock'), buildSlotPath(0)])
      assert.deepEqual(readClaimSet(path), { live: [], dead: [], unresolved: [], orphans: [] }, `${path} not released`);
  });
  await attempt('test-signing-material', () => {
    for (const name of ['active.jks', 'one.jks', 'two.jks']) rmSync(join(signing, name), { force: true });
  });
  write(join(logs, 'cleanup.json'), JSON.stringify({ before, serial, errors, ok: errors.length === 0 }, null, 2));
  if (errors.length) throw new Error(JSON.stringify(errors));
}
if (mode === 'cleanup') {
  if (existsSync(join(logs, 'cleanup.json')))
    assert.equal(
      JSON.parse(readFileSync(join(logs, 'cleanup.json'), 'utf8')).ok,
      true,
      'The earlier cleanup failed; its evidence is retained.',
    );
  else await cleanup();
}
if (mode === 'run') {
  let failure;
  let cleanupFailure;
  const cases = [];
  try {
    assert.match(
      command('agent-device-version', 'agent-device', ['--version'], { timeout: 10_000 }).stdout,
      /\b0\.21\.22\b/,
    );
    command('emulator-acceleration', 'emulator', ['-accel-check'], { timeout: 30_000 });
    for (const setting of ['iosSimulatorApp', 'androidEmulatorApp'])
      stim(`setting-${setting}`, ['settings', 'set', setting, 'stim-desktop']);
    const initialSigner = digest(join(logs, 'one-certificate.der'));
    const rotatedSigner = digest(join(logs, 'two-certificate.der'));
    assert.notEqual(initialSigner, rotatedSigner);
    async function positive(label, variant, revision, signer) {
      write(join(output, 'native-attempted.json'), JSON.stringify({ label, variant }));
      const startedAt = new Date().toISOString();
      const result = stim(label, ['android', '--variant', variant, '--json']);
      const facts = JSON.parse(result.stdout.trim());
      const packageName = `org.example.stim.${variant.startsWith('free') ? 'free' : 'paid'}${variant.endsWith('Debug') ? '.debug' : ''}`;
      assert.equal(facts.variant, variant);
      assert.equal(facts.bundleId, packageName);
      assert.equal(facts.launched, true);
      assert.equal(facts.metroPort, null);
      assert.equal(facts.fingerprint, null);
      assert.equal(facts.cacheKey, null);
      assert.equal(facts.cacheHit, false);
      assert.equal(facts.cacheSkipped, true);
      assert.match(facts.serial, /^emulator-\d+$/);
      const project = getProject(fixture);
      assert.equal(project?.platforms?.android?.serial, facts.serial);
      assert.equal(project?.platforms?.android?.owned, true);
      const pid = command(`${label}-pid`, 'adb', ['-s', facts.serial, 'shell', 'pidof', packageName], {
        timeout: 10_000,
      }).stdout.trim();
      assert.match(pid, /^[1-9]\d*$/);
      const produced = apkIdentity(`${label}-produced`, facts.appPath);
      assert.deepEqual({ signer: produced.signer, package: produced.package }, { signer, package: packageName });
      const installedPaths = command(
        `${label}-installed-path`,
        'adb',
        ['-s', facts.serial, 'shell', 'pm', 'path', packageName],
        { timeout: 10_000 },
      )
        .stdout.trim()
        .split(/\r?\n/)
        .filter(Boolean);
      assert.equal(installedPaths.length, 1, 'Expected one installed standalone APK');
      assert(installedPaths[0].startsWith('package:/data/app/'));
      const pulled = join(publicApks, `${label}.apk`);
      mkdirSync(publicApks, { recursive: true });
      command(`${label}-pull-installed`, 'adb', ['-s', facts.serial, 'pull', installedPaths[0].slice(8), pulled], {
        timeout: 60_000,
      });
      const installed = apkIdentity(`${label}-installed`, pulled);
      assert.deepEqual(installed, produced, 'Installed APK differs from the admitted build');
      verifyUi(label, facts, pid, revision);
      const gradle = lastGradleMessages(label);
      const evidence = {
        label,
        variant,
        revision,
        startedAt,
        completedAt: new Date().toISOString(),
        facts,
        pid,
        produced,
        installed,
      };
      cases.push(evidence);
      write(join(logs, 'cases.json'), JSON.stringify(cases, null, 2));
      return { ...evidence, gradle };
    }
    for (const variant of ['freeDebug', 'freeRelease']) {
      write(sourceFile, source);
      const first = await positive(`${variant}-cold`, variant, 'initial', initialSigner);
      const warm = await positive(`${variant}-warm`, variant, 'initial', initialSigner);
      assert.equal(warm.produced.sha256, first.produced.sha256);
      assert.match(warm.gradle, /Reusing configuration cache/);
      const title = variant[0].toUpperCase() + variant.slice(1);
      assert(warm.gradle.includes(`:mobile:compile${title}Kotlin UP-TO-DATE`));
      assert(warm.gradle.includes(`:mobile:stimExport${title}Apk UP-TO-DATE`));
      write(sourceFile, source.replace('Native QA initial', 'Native QA edited'));
      const edited = await positive(`${variant}-edited`, variant, 'edited', initialSigner);
      assert.notEqual(edited.produced.sha256, first.produced.sha256);
    }
    await positive('paidDebug', 'paidDebug', 'edited', initialSigner);
    copyFileSync(join(signing, 'two.jks'), activeKey);
    await positive('freeRelease-rotated-signature', 'freeRelease', 'edited', rotatedSigner);
    env.STIM_QA_SIGN_RELEASE = 'false';
    refused('unsigned-release', 'freeRelease', /signature could not be verified/);
    const unsignedModel = JSON.parse(
      readFileSync(join(workspaceStateDir(fixture), 'gradle-build', 'native-apk-freeRelease.json'), 'utf8'),
    );
    assert.equal(unsignedModel.variant, 'freeRelease');
    assert.equal(unsignedModel.elements.length, 1);
    const signature = command('unsigned-apk-proof', tool('apksigner'), ['verify', unsignedModel.elements[0].path], {
      allowFailure: true,
      timeout: 30_000,
    });
    assert.notEqual(signature.status, 0);
    env.STIM_QA_SIGN_RELEASE = 'true';
    refused('unknown-variant', 'missingDebug', /could not select variant 'missingDebug'/);
    await positive('freeRelease-recovered', 'freeRelease', 'edited', rotatedSigner);
    write(
      join(logs, 'coverage.json'),
      JSON.stringify(
        {
          lifecycle:
            'freeDebug/freeRelease cold-warm-edit, paidDebug, signer rotation, unsigned/unknown-variant refusal and recovery',
          ui: 'Every successful case retained the Stim-launched PID, visible revision, native log and counter 0 -> 1',
          signing: 'Produced and pulled installed APK bytes and public signer hashes match; job-owned test keys only',
          compilerReuse: 'Unchanged Gradle Kotlin/export tasks UP-TO-DATE and configuration cache reused',
          artifactCache: 'Intentionally undeclared; every lifecycle case explicitly verifies uncached artifact facts',
          notExercised: ['physical devices', 'remote worker', 'hosted device', 'native C++ compiler cache'],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  write(
    join(logs, 'terminal.json'),
    JSON.stringify(
      {
        ok: !failure && !cleanupFailure,
        failure: failure?.stack ?? null,
        cleanupFailure: cleanupFailure?.stack ?? null,
        completedCases: cases.map((entry) => entry.label),
      },
      null,
      2,
    ),
  );
  if (failure || cleanupFailure)
    throw new AggregateError([failure, cleanupFailure].filter(Boolean), 'Signed native lifecycle failed');
}
