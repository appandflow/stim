import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { workspaceStateDir } from '../../../packages/core/dist/index.mjs';
import { readClaimSet } from '../../../packages/core/dist/ownership-claim.mjs';
import { captureProcessIdentity, inspectProcessIdentity } from '../../../packages/core/dist/process-identity.mjs';
import { buildSlotPath, readWorkspaceState, workspaceAgentDeviceDir } from '../../../packages/core/dist/state.mjs';

const [mode, supplied] = process.argv.slice(2);
assert(['prepare', 'run'].includes(mode) && supplied, 'usage: run-gradle-e2e.mjs prepare|run <owned-output>');
const output = resolve(supplied);
const fixture = join(output, 'project');
const logs = join(output, 'evidence');
const home = join(output, 'stim-home');
const cli = resolve('packages/stim-cli/dist/cli.mjs');
const shim = resolve('packages/stim-cli/shim/native-android.gradle');
process.env.STIM_HOME = home;
const env = {
  ...process.env,
  GRADLE_USER_HOME: join(output, 'gradle-home'),
  STIM_MAX_BUILDS: '1',
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
    [...args, '--platform', 'android', '--serial', activeAgentSerial, '--session', 'native-gradle-ui'],
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
  closeAgent(`${label}-ui-close`);
  write(
    join(logs, `${label}-ui.json`),
    JSON.stringify({ label, revision, serial: facts.serial, pid: beforePid, screenshot }, null, 2),
  );
}
async function waitUntil(label, timeout, ready) {
  const deadline = Date.now() + timeout;
  do {
    const value = ready();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail(`${label} did not complete within ${timeout}ms`);
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
async function verifyCancellation(serial) {
  const script = join(fixture, 'cancel-qa.gradle');
  const settings = join(fixture, 'mobile/build.gradle.kts');
  const original = readFileSync(settings, 'utf8');
  const marker = join(fixture, 'mobile/build/cancel-qa-started');
  const completed = join(fixture, 'mobile/build/cancel-qa-completed');
  const claimRoot = join(workspaceStateDir(fixture), 'native-run.lock');
  const beforeLaunches = readWorkspaceState(fixture)?.launches;
  write(
    script,
    `abstract class NativeCancellationProbe extends DefaultTask {
  @OutputFile abstract RegularFileProperty getStarted()
  @OutputFile abstract RegularFileProperty getCompleted()
  @TaskAction void probe() {
    def marker = started.get().asFile
    marker.parentFile.mkdirs()
    marker.text = ProcessHandle.current().pid().toString()
    Thread.sleep(180000)
    completed.get().asFile.text = 'completed'
  }
}
def probe = tasks.register('nativeCancellationProbe', NativeCancellationProbe) {
  started = layout.buildDirectory.file('cancel-qa-started')
  completed = layout.buildDirectory.file('cancel-qa-completed')
}
tasks.matching { it.name == 'compileFreeDebugKotlin' }.configureEach { dependsOn(probe) }
`,
  );
  write(settings, `${original}\napply(from = "../cancel-qa.gradle")\n`);
  const stdout = join(logs, 'cancel-run.stdout');
  const stderr = join(logs, 'cancel-run.stderr');
  const outFd = openSync(stdout, 'w');
  const errFd = openSync(stderr, 'w');
  let child;
  let terminal;
  let holder;
  let gradle;
  try {
    child = spawn(process.execPath, [cli, 'android', '--variant', 'freeDebug', '--json'], {
      cwd: fixture,
      env,
      stdio: ['ignore', outFd, errFd],
    });
    child.unref();
    child.once('error', (error) => {
      terminal = { error: error.message };
    });
    child.once('close', (code, signal) => {
      terminal = { code, signal };
    });
    holder = await waitUntil('Gradle task and exact native-run owner', 10 * 60_000, () => {
      assert(!terminal, `cancellation build exited before the probe: ${JSON.stringify(terminal)}`);
      if (!existsSync(marker) || !readFileSync(marker, 'utf8').trim()) return null;
      return readClaimSet(claimRoot).live.find(
        (claim) =>
          claim.owner.pid === child.pid &&
          claim.details.command === 'android' &&
          claim.child &&
          inspectProcessIdentity(claim.owner) === 'same' &&
          inspectProcessIdentity(claim.child) === 'same',
      );
    });
    const pid = Number(readFileSync(marker, 'utf8').trim());
    assert(Number.isSafeInteger(pid) && pid > 0, 'probe has no Gradle JVM PID');
    const identity = captureProcessIdentity(pid);
    assert(identity.ok, 'could not capture the running Gradle JVM identity');
    gradle = { pid, processToken: identity.token };
    const slots = readClaimSet(buildSlotPath(0));
    assert(
      slots.live.some((claim) => claim.owner.pid === child.pid && claim.child?.pid === holder.child.pid),
      'build slot does not hold this exact Gradle invocation',
    );
    assert(!existsSync(completed), 'probe completed before cancellation');
    write(join(logs, 'cancel-before.json'), JSON.stringify({ holder, gradle, slots, beforeLaunches }, null, 2));
    const stopped = stim('cancel-stop', ['stop', '--json'], { timeout: 2 * 60_000 });
    assert.equal(JSON.parse(stopped.stdout.trim()).ok, true);
    await waitUntil('cancelled CLI exit', 30_000, () => terminal);
    assert.equal(terminal.error, undefined);
    assert.notEqual(terminal.code, 0);
    assert.equal(terminal.signal, null);
    assert.equal(JSON.parse(readFileSync(stdout, 'utf8').trim()).code, 'STIM_CANCELLED');
    await waitUntil('declared Gradle child and task JVM exit', 60_000, () =>
      [holder.child, gradle].every((record) => ['gone', 'different'].includes(inspectProcessIdentity(record))),
    );
    assert(!existsSync(completed), 'cancelled task continued to completion');
    await waitDeviceGone('cancel-devices', serial);
    for (const path of [claimRoot, buildSlotPath(0)]) {
      const claims = readClaimSet(path);
      assert.deepEqual(claims, { live: [], dead: [], unresolved: [], orphans: [] }, `${path} was not released`);
    }
    const state = readWorkspaceState(fixture);
    assert.equal(state.lastBuild?.errorCode, 'STIM_CANCELLED');
    const history = state.buildHistory?.android?.[0];
    assert.equal(history?.result, 'cancelled');
    assert(!('install' in history.phases) && !('launch' in history.phases), 'cancelled build reached deployment');
    if (state.launches) assert.deepEqual(state.launches, beforeLaunches, 'cancelled build replaced launch state');
    write(join(logs, 'cancel-after.json'), JSON.stringify({ terminal, state, holder, gradle }, null, 2));
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    write(settings, original);
    rmSync(script);
    write(join(logs, 'cancel-terminal.json'), JSON.stringify({ pid: child?.pid, terminal, holder, gradle }, null, 2));
  }
}
const sourceFile = join(fixture, 'mobile/src/main/java/org/example/stim/MainActivity.kt');
const source = `package org.example.stim
import android.os.Bundle
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
        BasicText("Increment native counter", Modifier.clickable { taps.value += 1 }.padding(16.dp))
      }
    }
  }
}
`;
if (mode === 'prepare') {
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
  command('wrapper-executable', 'chmod', ['+x', join(fixture, 'gradlew')]);
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
  buildTypes { debug { applicationIdSuffix '.debug' } }
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
      android: {
        systemImage: process.env.STIM_QA_ANDROID_SYSTEM_IMAGE ?? 'system-images;android-34;google_apis;x86_64',
      },
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
} else {
  let serial;
  let attemptedRun = false;
  let failure;
  try {
    const agentVersion = command('agent-device-version', 'agent-device', ['--version'], { timeout: 10_000 });
    assert.match(agentVersion.stdout, /\b0\.21\.22\b/);
    for (const setting of ['iosSimulatorApp', 'androidEmulatorApp'])
      stim(`setting-${setting}`, ['settings', 'set', setting, 'stim-desktop']);
    const plan = stim('plan', ['android', '--plan', '--json'], { allowFailure: true });
    assert.notEqual(plan.status, 0);
    assert.match(plan.text, /--plan does not execute Gradle/);
    assert(!existsSync(join(fixture, '.gradle')), 'read-only plan configured Gradle');
    const model = join(output, 'direct-model.json');
    const args = [
      ':stimExportAndroidApk',
      '--configuration-cache',
      '--configuration-cache-problems=fail',
      '--build-cache',
      '--init-script',
      shim,
      '-Pstim.native.variant=freeDebug',
      `-Pstim.native.model=${model}`,
    ];
    const partial = command('shim-configure-on-demand', join(fixture, 'gradlew'), [...args, '--configure-on-demand'], {
      allowFailure: true,
    });
    assert.notEqual(partial.status, 0);
    assert.match(partial.text, /configuration-on-demand enabled/);
    assert.match(partial.text, /org.gradle.configureondemand=false/);
    command('shim-cold', join(fixture, 'gradlew'), args);
    const warm = command('shim-warm', join(fixture, 'gradlew'), args);
    assert.match(warm.text, /Reusing configuration cache/);
    assert.match(warm.text, /:mobile:stimExportFreeDebugApk UP-TO-DATE/);
    assert.match(warm.text, /:mobile:compileFreeDebugKotlin UP-TO-DATE/);
    const exported = JSON.parse(readFileSync(model, 'utf8'));
    assert.equal(exported.applicationId, 'org.example.stim.free.debug');
    assert.equal(exported.module, ':mobile');
    let originalDigest;
    for (const [label, revision] of [
      ['stim-cold', 'initial'],
      ['stim-warm', 'initial'],
      ['stim-edited', 'edited'],
      ['stim-recovered', 'recovered'],
      ['stim-after-cancel', 'recovered'],
    ]) {
      if (label === 'stim-after-cancel') await verifyCancellation(serial);
      if (label === 'stim-edited') write(sourceFile, source.replace('initial', 'edited'));
      if (label === 'stim-recovered') {
        write(sourceFile, 'not valid Kotlin!');
        const broken = stim('stim-compile-failure', ['android', '--variant', 'freeDebug', '--json'], {
          allowFailure: true,
        });
        assert.notEqual(broken.status, 0);
        assert.match(broken.text, /STIM_BUILD_FAILED/);
        write(sourceFile, source.replace('initial', 'recovered'));
      }
      attemptedRun = true;
      const result = stim(label, ['android', '--variant', 'freeDebug', '--json']);
      const facts = JSON.parse(result.stdout.trim());
      assert.equal(facts.bundleId, 'org.example.stim.free.debug');
      assert.equal(facts.launched, true);
      assert.equal(facts.metroPort, null);
      assert.equal(facts.cacheKey, null);
      assert.equal(facts.cacheSkipped, true);
      assert(facts.serial, 'no owned emulator serial');
      serial = facts.serial;
      const pid = command(`${label}-pid`, 'adb', ['-s', serial, 'shell', 'pidof', facts.bundleId]);
      assert.match(pid.stdout.trim(), /^[1-9]\d*$/);
      verifyUi(label, facts, pid.stdout.trim(), revision);
      const digest = createHash('sha256').update(readFileSync(facts.appPath)).digest('hex');
      if (label === 'stim-cold') originalDigest = digest;
      if (label === 'stim-warm') assert.equal(digest, originalDigest);
      if (label === 'stim-edited') assert.notEqual(digest, originalDigest);
      if (label === 'stim-warm') {
        const files = readdirSync(home, { recursive: true }).filter((file) => file.endsWith('build-android.ndjson'));
        assert.equal(files.length, 1);
        const records = readFileSync(join(home, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
        const messages = records
          .slice(records.findLastIndex((entry) => entry.event === 'build_start'))
          .map((entry) => entry.msg)
          .join('\n');
        write(join(logs, 'stim-warm-gradle.log'), messages);
        assert.match(messages, /Reusing configuration cache/);
        assert.match(messages, /:mobile:stimExportFreeDebugApk UP-TO-DATE/);
      }
    }
    const reload = stim('reload', ['reload', 'android', '--json'], { allowFailure: true });
    assert.notEqual(reload.status, 0);
    assert.match(reload.text, /STIM_NO_METRO/);
    write(
      join(logs, 'coverage.json'),
      JSON.stringify(
        {
          configurationCache: 'reused',
          warmGradleTasks: 'up-to-date',
          currentSource: 'APK digest changed and visible source revision matched',
          launch: 'positive app PID',
          recovery: true,
          uiRendering: 'visible counter 0 -> 1 at unchanged Stim-launched PID in all five runs',
          cancellation:
            'public stop interrupted a running Gradle task; CLI, Gradle child and task JVM exited; claims released; no deployment; recovery passed',
          physicalDevice: 'not exercised',
          remoteAndArtifactCache: 'unsupported',
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error;
  }
  try {
    closeAgent('cleanup-agent-close');
  } catch (error) {
    if (failure) console.error(failure);
    failure = error;
  }
  try {
    if (existsSync(env.AGENT_DEVICE_STATE_DIR))
      command('cleanup-agent-daemon', 'agent-device', ['daemon', 'stop', '--state-dir', env.AGENT_DEVICE_STATE_DIR], {
        timeout: 30_000,
      });
  } catch (error) {
    if (failure) console.error(failure);
    failure = error;
  }
  try {
    if (attemptedRun) {
      const stopped = stim('cleanup-stop', ['stop', '--json']);
      assert.equal(JSON.parse(stopped.stdout.trim()).ok, true);
    }
    if (serial) await waitDeviceGone('cleanup-devices', serial);
  } catch (error) {
    if (failure) console.error(failure);
    failure = error;
  }
  if (failure) throw failure;
}
