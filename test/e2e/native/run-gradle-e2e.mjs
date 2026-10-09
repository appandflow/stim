import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { workspaceAgentDeviceDir } from '../../../packages/core/dist/state.mjs';

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
    ]) {
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
          uiRendering: 'visible counter 0 -> 1 at unchanged Stim-launched PID in all four runs',
          cancellation: 'not exercised',
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
    if (serial) {
      const deadline = Date.now() + 30_000;
      let present;
      let attempt = 0;
      do {
        const devices = command(`cleanup-devices-${++attempt}`, 'adb', ['devices'], { timeout: 10_000 });
        present = devices.stdout.split('\n').some((line) => line.startsWith(`${serial}\t`));
        if (!present || Date.now() >= deadline) break;
        await sleep(250);
      } while (Date.now() < deadline);
      assert(!present, `owned emulator ${serial} still listed by adb after stop`);
    }
  } catch (error) {
    if (failure) console.error(failure);
    failure = error;
  }
  if (failure) throw failure;
}
