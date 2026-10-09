import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCleanupTracker, createHarness, workspaceLogsDir } from './harness.mjs';

assert(process.env.CI === 'true' || process.env.CI === '1', 'This acceptance driver runs only in CI.');
assert.equal(process.platform, 'linux');
const [mode, supplied] = process.argv.slice(2);
assert(
  ['prepare', 'run'].includes(mode) && supplied,
  'usage: run-architecture-samples-e2e.mjs prepare|run <owned-output>',
);
const output = resolve(supplied);
const source = join(output, 'source');
const app = join(output, 'project');
const evidence = join(output, 'evidence');
const home = join(output, 'stim-home');
const sampleCommit = 'ee66e1526b84c026615df032c705842b7d2a521f';
const cli = resolve('packages/stim-cli/dist/cli.mjs');
const env = {
  ...process.env,
  STIM_HOME: home,
  STIM_BUILD_CACHE: join(output, 'build-cache'),
  STIM_DEBUG: '1',
  STIM_MAINTENANCE: 'off',
  STIM_POOL_IOS_PARKED_MAX: '0',
  STIM_POOL_ANDROID_PARKED_MAX: '0',
  GRADLE_USER_HOME: join(output, 'gradle-home'),
  AGENT_DEVICE_HOME: join(output, 'agent-device'),
  AGENT_DEVICE_CLAIMS_DIR: join(output, 'agent-claims'),
};
process.env.STIM_HOME = home;
mkdirSync(evidence, { recursive: true });
const h = createHarness({ env, cliPath: cli, label: 'architecture-samples' });
const cleanup = createCleanupTracker({ h, platform: 'android' });
const summary = { sampleCommit, runs: [], diagnostics: [], failure: null, cleanup: null };
let activeAgentEnv;
let serial;
let avd;
let attemptedRun = false;
let commandNumber = 0;
function command(label, file, args, options = {}) {
  const result = h.sh(file, args, { cwd: app, ...options, allowFail: true });
  const prefix = join(evidence, `${String(++commandNumber).padStart(3, '0')}-${mode}-${label}`);
  writeFileSync(`${prefix}.stdout`, result.stdout);
  writeFileSync(`${prefix}.stderr`, result.stderr);
  if (!options.allowFail) assert.equal(result.code, 0, `${label}: ${result.stderr.slice(-12000)}`);
  return result;
}
function stim(label, args, options) {
  return command(label, process.execPath, [cli, ...args], options);
}
function agent(label, args) {
  return command(
    label,
    'agent-device',
    [...args, '--platform', 'android', '--serial', serial, '--session', 'real-native-android'],
    {
      env: activeAgentEnv,
    },
  );
}
function closeAgent() {
  if (!activeAgentEnv) return;
  agent('agent-close', ['close']);
  command(
    'agent-daemon-stop',
    'agent-device',
    ['daemon', 'stop', '--state-dir', activeAgentEnv.AGENT_DEVICE_STATE_DIR],
    {
      env: activeAgentEnv,
      timeout: 30_000,
    },
  );
  activeAgentEnv = undefined;
}
function appPid(label, facts) {
  const pid = command(label, 'adb', ['-s', facts.serial, 'shell', 'pidof', facts.bundleId], {
    timeout: 10_000,
  }).stdout.trim();
  assert.match(pid, /^[1-9]\d*$/);
  return pid;
}
function verifyUi(label, facts, titleHint) {
  const before = appPid(`${label}-pid-before-ui`, facts);
  activeAgentEnv = { ...env, AGENT_DEVICE_STATE_DIR: facts.agentDevice.stateDir };
  agent(`${label}-open`, ['open', facts.bundleId, '--foreground']);
  assert.equal(appPid(`${label}-pid-after-open`, facts), before, 'UI attachment replaced the launched process.');
  agent(`${label}-new-task`, ['press', 'label="New Task"', '--settle']);
  agent(`${label}-source-revision`, ['wait', `label="${titleHint}"`, '30000']);
  agent(`${label}-form-screenshot`, ['screenshot', join(evidence, `${label}-form.png`)]);
  const title = `Stim real ${label}`;
  agent(`${label}-fill`, ['fill', `label="${titleHint}"`, title, '--settle']);
  agent(`${label}-keyboard`, ['keyboard', 'dismiss']);
  agent(`${label}-save`, ['press', 'label="Save task"', '--settle']);
  agent(`${label}-saved`, ['wait', `label="${title}"`, '30000']);
  agent(`${label}-details`, ['press', `label="${title}"`, '--settle']);
  agent(`${label}-details-title`, ['wait', 'label="Task Details"', '30000']);
  agent(`${label}-details-content`, ['wait', `label="${title}"`, '30000']);
  agent(`${label}-snapshot`, ['snapshot', '-i']);
  const screenshot = join(evidence, `${label}.png`);
  agent(`${label}-screenshot`, ['screenshot', screenshot]);
  assert(statSync(screenshot).size > 0);
  assert.equal(
    appPid(`${label}-pid-after-interaction`, facts),
    before,
    'UI interaction replaced the launched process.',
  );
  closeAgent();
  return { pid: before, screenshot, title };
}
async function waitDeviceGone() {
  const deadline = Date.now() + 30_000;
  let present;
  let attempt = 0;
  do {
    const text = command(`stopped-devices-${++attempt}`, 'adb', ['devices'], { timeout: 10_000 }).stdout;
    present = text.split('\n').some((line) => line.startsWith(`${serial}\t`));
    if (!present || Date.now() >= deadline) break;
    await sleep(250);
  } while (Date.now() < deadline);
  assert(!present, `owned emulator ${serial} is still listed by adb after stop`);
}

if (mode === 'prepare') {
  mkdirSync(source, { recursive: true });
  for (const args of [
    ['init'],
    ['remote', 'add', 'origin', 'https://github.com/android/architecture-samples.git'],
    ['fetch', '--depth', '1', 'origin', sampleCommit],
    ['checkout', '--detach', 'FETCH_HEAD'],
  ])
    command('sample-git', 'git', args, { cwd: source });
  assert.equal(command('sample-head', 'git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim(), sampleCommit);
  command('worktree', 'git', ['worktree', 'add', '--detach', app, 'HEAD'], { cwd: source });
} else {
  try {
    assert.equal(command('sample-head', 'git', ['rev-parse', 'HEAD']).stdout.trim(), sampleCommit);
    assert.match(command('agent-version', 'agent-device', ['--version']).stdout, /\b0\.21\.22\b/);
    for (const setting of ['iosSimulatorApp', 'androidEmulatorApp'])
      stim(`setting-${setting}`, ['settings', 'set', setting, 'stim-desktop']);
    stim('setting-image', [
      'settings',
      'set',
      'android.systemImage',
      'system-images;android-34;google_apis;x86_64',
      '--scope',
      'machine',
    ]);
    const plan = stim('read-only-plan', ['android', '--variant', 'debug', '--plan', '--json'], { allowFail: true });
    assert.notEqual(plan.code, 0);
    assert.equal(JSON.parse(plan.stdout).code, 'STIM_BAD_ARG');
    assert.match(plan.stdout, /--plan does not execute Gradle/);
    assert(!existsSync(join(app, '.gradle')), 'Read-only planning configured Gradle.');
    let originalDigest;
    for (const label of ['cold', 'unchanged', 'edited']) {
      const titleHint = label === 'edited' ? 'Stim real title' : 'Title';
      if (label === 'edited') {
        const resources = join(app, 'app/src/main/res/values/strings.xml');
        const xml = readFileSync(resources, 'utf8');
        const old = '<string name="title_hint">Title</string>';
        assert.equal(xml.split(old).length, 2);
        writeFileSync(resources, xml.replace(old, '<string name="title_hint">Stim real title</string>'));
        const activity = join(
          app,
          'app/src/main/java/com/example/android/architecture/blueprints/todoapp/TodoActivity.kt',
        );
        const code = readFileSync(activity, 'utf8');
        const call = 'super.onCreate(savedInstanceState)';
        assert.equal(code.split(call).length, 2);
        writeFileSync(
          activity,
          code.replace(call, `${call}\n        android.util.Log.i("StimRealQA", "stim-real-android:edited")`),
        );
        command('source-edit', 'git', ['diff']);
      }
      const started = Date.now();
      attemptedRun = true;
      const result = stim(label, ['android', '--variant', 'debug', '--json'], {
        timeout: 20 * 60_000,
        allowFail: true,
      });
      try {
        cleanup.recordWorkspace(app);
      } catch (error) {
        if (result.code === 0) throw error;
        summary.diagnostics.push(error.stack ?? String(error));
      }
      assert.equal(result.code, 0, result.stderr.slice(-12000));
      const facts = JSON.parse(result.stdout);
      cleanup.recordBuild(facts);
      assert.equal(facts.bundleId, 'com.example.android.architecture.blueprints.main');
      assert.equal(facts.launched, true);
      assert.equal(facts.metroPort, null);
      assert.equal(facts.cacheKey, null);
      assert.equal(facts.cacheHit, false);
      assert.equal(facts.cacheSkipped, true);
      assert(facts.serial && facts.avdName && facts.agentDevice?.stateDir);
      if (serial) assert.equal(facts.serial, serial);
      if (avd) assert.equal(facts.avdName, avd);
      serial = facts.serial;
      avd = facts.avdName;
      const ui = verifyUi(label, facts, titleHint);
      const digest = createHash('sha256').update(readFileSync(facts.appPath)).digest('hex');
      if (label === 'cold') originalDigest = digest;
      if (label === 'unchanged') {
        assert.equal(digest, originalDigest);
        const records = readFileSync(join(workspaceLogsDir(app), 'build-android.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        const messages = records
          .slice(records.findLastIndex((entry) => entry.event === 'build_start'))
          .map((entry) => entry.msg)
          .join('\n');
        writeFileSync(join(evidence, 'unchanged-gradle.log'), messages);
        assert.match(messages, /Reusing configuration cache/);
        assert.match(messages, /:app:stimExportDebugApk UP-TO-DATE/);
      }
      if (label === 'edited') {
        assert.notEqual(digest, originalDigest);
        const deadline = Date.now() + 30_000;
        let current;
        do {
          const logs = stim('edited-device-log', [
            'logs',
            '--source',
            'device',
            '--grep',
            'stim-real-android:edited',
            '--json',
          ]);
          current = logs.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse)
            .some((record) => record.ts >= started);
          if (current) break;
          await sleep(500);
        } while (Date.now() < deadline);
        assert(current, 'Stim did not collect the edited app launch log.');
      }
      const status = JSON.parse(stim(`${label}-status`, ['status', '--json']).stdout);
      const current = status.environments.find((entry) => entry.path === app);
      assert(current);
      assert.equal(current.metro, null);
      assert.equal(current.supervisor, null);
      const reload = stim(`${label}-reload`, ['reload', 'android', '--json'], { allowFail: true });
      assert.notEqual(reload.code, 0);
      assert.match(reload.stdout, /STIM_NO_METRO/);
      assert.equal(stim(`${label}-errors`, ['logs', '--errors', '--json']).stdout.trim(), '');
      summary.runs.push({ label, facts, digest, ui });
    }
  } catch (error) {
    summary.failure = error.stack ?? String(error);
  } finally {
    const failures = [];
    for (const clean of [
      () => closeAgent(),
      () => cleanup.recordWorkspace(app),
      () => {
        if (existsSync(workspaceLogsDir(app)))
          cpSync(workspaceLogsDir(app), join(evidence, 'workspace-logs'), { recursive: true });
      },
      async () => {
        if (attemptedRun) assert.equal(JSON.parse(stim('stop', ['stop', '--json']).stdout).ok, true);
        if (serial) await waitDeviceGone();
      },
      () => {
        stim('remove', ['worktree', 'remove', '--force', app], { cwd: source });
        assert(!existsSync(app));
      },
      () => assert.deepEqual(cleanup.remainingDevices(), []),
      () => cleanup.verifyProcesses(),
      () => {
        const status = JSON.parse(stim('final-status', ['status', '--json'], { cwd: source }).stdout);
        assert(!status.environments.some((entry) => entry.path === app));
      },
      () => command('gradle-daemon-stop', join(source, 'gradlew'), ['--stop'], { cwd: source }),
    ]) {
      try {
        await clean();
      } catch (error) {
        failures.push(error.stack ?? String(error));
      }
    }
    summary.cleanup = { ok: failures.length === 0, failures };
    writeFileSync(join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    if (summary.failure || failures.length) {
      process.exitCode = 1;
      process.stderr.write(`${[summary.failure, ...failures].filter(Boolean).join('\n')}\n`);
    }
  }
}
