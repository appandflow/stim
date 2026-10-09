import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCleanupTracker, createHarness, workspaceLogsDir } from './harness.mjs';

assert(process.env.CI === 'true' || process.env.CI === '1', 'This acceptance driver runs only in CI.');
assert.equal(process.platform, 'darwin', 'Native Xcode acceptance requires a hosted macOS runner.');
const exec = promisify(execFile);
const evidence = resolve(process.env.STIM_NATIVE_XCODE_EVIDENCE ?? 'artifacts/native-xcode');
mkdirSync(evidence, { recursive: true });
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-xcode-acceptance-')));
const source = join(temporary, 'source');
const app = join(temporary, 'app');
const home = join(temporary, 'stim-home');
const cli = fileURLToPath(new URL('../../../packages/stim-cli/dist/cli.mjs', import.meta.url));
const env = {
  ...process.env,
  CI: '1',
  STIM_HOME: home,
  STIM_BUILD_CACHE: join(temporary, 'build-cache'),
  STIM_POOL_IOS_PARKED_MAX: '0',
  STIM_POOL_ANDROID_PARKED_MAX: '0',
  STIM_MAINTENANCE: 'off',
  AGENT_DEVICE_HOME: join(temporary, 'agent-device'),
  AGENT_DEVICE_CLAIMS_DIR: join(temporary, 'agent-claims'),
};
process.env.STIM_HOME = home;
const harness = createHarness({ env, cliPath: cli, label: 'native-xcode' });
const cleanup = createCleanupTracker({ h: harness, platform: 'ios' });
const summary = { temporary, source, app, home, steps: [], runs: [], diagnostics: [], cleanup: null, failure: null };
let commandNumber = 0;
let activeAgentEnv;
let ownedUdid;
let worktreeCreated = false;

async function run(label, file, args, options = {}) {
  const prefix = join(evidence, `${String(++commandNumber).padStart(3, '0')}-${label}`);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let failure;
  try {
    ({ stdout, stderr } = await exec(file, args, {
      cwd: options.cwd ?? app,
      env: options.env ?? env,
      timeout: options.timeout ?? 60_000,
      killSignal: 'SIGINT',
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch (error) {
    failure = error;
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? error.message;
  }
  writeFileSync(`${prefix}.stdout`, stdout);
  writeFileSync(`${prefix}.stderr`, stderr);
  summary.steps.push({ label, file, args, code: failure?.code ?? 0, durationMs: Date.now() - started });
  process.stderr.write(`[native-xcode] ${label}: ${failure ? 'FAILED' : 'ok'} (${Date.now() - started}ms)\n`);
  if (failure) throw new Error(`${label} failed; see ${prefix}.stderr`, { cause: failure });
  return stdout;
}

async function stim(label, args, options) {
  return JSON.parse(await run(label, process.execPath, [cli, ...args, '--json'], options));
}

async function inventory(label) {
  return Object.values(JSON.parse(await run(label, 'xcrun', ['simctl', 'list', 'devices', '--json'])).devices).flat();
}

async function appPid(label, facts) {
  const text = await run(label, 'xcrun', ['simctl', 'spawn', facts.udid, 'launchctl', 'list']);
  const entry = text.split('\n').find((line) => line.includes(`UIKitApplication:${facts.bundleId}[`));
  const pid = Number(entry?.trim().split(/\s+/)[0]);
  assert(Number.isInteger(pid) && pid > 0, 'The exact Stim-launched app must be live before UI attachment.');
  return pid;
}

async function agent(label, args) {
  return run(label, 'agent-device', [...args, '--session', 'native-xcode-acceptance'], {
    env: activeAgentEnv,
    timeout: 5 * 60_000,
  });
}

async function closeAgent() {
  if (!activeAgentEnv) return;
  await agent('agent-close', ['close']);
  activeAgentEnv = undefined;
}

async function verifyUi(label, facts, revision) {
  const beforePid = await appPid(`${label}-pid-before-ui`, facts);
  await run(`${label}-pre-attach-screenshot`, 'xcrun', [
    'simctl',
    'io',
    facts.udid,
    'screenshot',
    join(evidence, `${label}-before-attach.png`),
  ]);
  assert(facts.agentDevice?.stateDir, 'Stim must expose the workspace agent-device directory.');
  activeAgentEnv = { ...env, AGENT_DEVICE_STATE_DIR: facts.agentDevice.stateDir };
  await agent(`${label}-open`, ['open', facts.bundleId, '--platform', 'ios', '--udid', facts.udid, '--foreground']);
  assert.equal(
    await appPid(`${label}-pid-after-ui`, facts),
    beforePid,
    'UI attachment must not replace the app process.',
  );
  await agent(`${label}-revision`, ['wait', 'text', revision, '30000']);
  await agent(`${label}-initial-state`, ['wait', 'text', 'Count: 0', '30000']);
  await agent(`${label}-snapshot`, ['snapshot', '-i']);
  const clickedAt = Date.now();
  await agent(`${label}-press`, ['press', 'id="increment"', '--settle']);
  await agent(`${label}-changed-state`, ['wait', 'text', 'Count: 1', '30000']);
  await agent(`${label}-screenshot`, ['screenshot', join(evidence, `${label}-clicked.png`)]);
  const deadline = Date.now() + 30_000;
  let records;
  do {
    const text = await run(`${label}-device-logs`, process.execPath, [
      cli,
      'logs',
      '--source',
      'device',
      '--grep',
      `native-acceptance-click:${revision}:1`,
      '--json',
    ]);
    records = text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (records.some((record) => record.ts >= clickedAt)) break;
    await sleep(1000);
  } while (Date.now() < deadline);
  assert(
    records.some((record) => record.ts >= clickedAt),
    'Stim must collect the current native UI click log.',
  );
  const errors = await run(`${label}-errors`, process.execPath, [cli, 'logs', '--errors', '--json']);
  assert.equal(errors.trim(), '', 'Stim reported an app, build, or runtime error.');
  await closeAgent();
  return beforePid;
}

function flags(configuration) {
  return [
    'ios',
    '--scheme',
    'NativeAcceptance',
    ...(configuration === 'Staging' ? [] : ['--configuration', configuration]),
  ];
}

async function lifecycle(configuration, phase, revision, expectedHit) {
  const label = `${configuration}-${phase}`;
  const plan = await stim(`${label}-plan`, [...flags(configuration), '--plan']);
  assert.equal(plan.cacheHit, expectedHit);
  assert.equal(plan.prebuild, expectedHit ? null : 'none');
  let facts;
  try {
    facts = await stim(label, [...flags(configuration), '--simulator-app', 'xcode'], { timeout: 15 * 60_000 });
  } finally {
    cleanup.recordWorkspace(app);
  }
  cleanup.recordBuild(facts);
  assert.equal(facts.platform, 'ios');
  assert.equal(facts.configuration, configuration);
  assert.equal(facts.launched, true);
  assert.equal(facts.metroPort, null);
  assert.equal(facts.devServer, undefined);
  assert.equal(facts.cacheSkipped, false);
  assert.equal(facts.cacheHit, expectedHit);
  assert.equal(facts.cacheKey, plan.cacheKey, 'Planning must predict the artifact execution reads/writes.');
  assert.equal(facts.bundleId, 'dev.stim.native.acceptance');
  assert(facts.cacheKey && facts.fingerprint && existsSync(facts.appPath));
  if (ownedUdid) assert.equal(facts.udid, ownedUdid, 'Repeated native runs must retain their owned simulator.');
  ownedUdid = facts.udid;
  const status = await stim(`${label}-status`, ['status']);
  const current = status.environments.find((entry) => entry.path === app);
  assert(current, 'Status must include the native workspace.');
  assert.equal(current.metro, null, 'Native runs must not allocate a Metro endpoint.');
  assert.equal(current.supervisor, null, 'Native runs must not start a Metro supervisor.');
  const pid = await verifyUi(label, facts, revision);
  summary.runs.push({ configuration, phase, revision, pid, plan, facts });
  return facts;
}

try {
  cpSync(fileURLToPath(new URL('./fixtures/xcode', import.meta.url)), source, { recursive: true });
  writeFileSync(
    join(source, '.stim.json'),
    JSON.stringify({ ios: { configuration: 'Staging' }, optimizations: { releaseBundleSwap: false } }) + '\n',
  );
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Stim native acceptance'],
    ['config', 'user.email', 'native-acceptance@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-m', 'Native Xcode acceptance fixture'],
    ['worktree', 'add', '--detach', app, 'HEAD'],
  ])
    await run('fixture-git', 'git', args, { cwd: source });
  worktreeCreated = true;
  await run('ios-viewer-default', process.execPath, [cli, 'settings', 'set', 'iosSimulatorApp', 'stim-desktop']);
  await run('android-viewer-default', process.execPath, [cli, 'settings', 'set', 'androidEmulatorApp', 'stim-desktop']);
  await run('warm', process.execPath, [cli, 'worktree', 'warm']);
  await run('xcode-version', 'xcodebuild', ['-version']);
  await run('swift-version', 'xcrun', ['swift', '--version']);
  await run('agent-device-version', 'agent-device', ['--version']);
  const initialDevices = (await inventory('initial-devices')).map((device) => device.udid).toSorted();
  await stim('read-only-plan', [...flags('Debug'), '--plan']);
  assert.deepEqual((await inventory('after-plan-devices')).map((device) => device.udid).toSorted(), initialDevices);
  const original = readFileSync(join(app, 'NativeAcceptance.swift'), 'utf8');
  for (const configuration of ['Debug', 'Release', 'Staging']) {
    writeFileSync(join(app, 'NativeAcceptance.swift'), original);
    const cold = await lifecycle(configuration, 'cold', 'native-revision-one', false);
    const warm = await lifecycle(configuration, 'warm', 'native-revision-one', 'local');
    assert.equal(warm.cacheKey, cold.cacheKey);
    const revision = `native-revision-${configuration.toLowerCase()}`;
    writeFileSync(join(app, 'NativeAcceptance.swift'), original.replace('native-revision-one', revision));
    const edited = await lifecycle(configuration, 'edited', revision, false);
    assert.notEqual(edited.cacheKey, cold.cacheKey, 'Changing native source must invalidate the artifact.');
  }
  const stopped = await stim('stop', ['stop']);
  assert.equal(stopped.ok, true);
  assert.equal((await inventory('stopped-devices')).find((device) => device.udid === ownedUdid)?.state, 'Shutdown');
} catch (error) {
  summary.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  const cleanupFailures = [];
  try {
    await closeAgent();
  } catch (error) {
    cleanupFailures.push(error.message);
  }
  if (worktreeCreated && existsSync(app)) {
    try {
      cleanup.recordWorkspace(app);
    } catch (error) {
      cleanupFailures.push(error.message);
    }
    try {
      const logs = workspaceLogsDir(app);
      if (existsSync(logs)) cpSync(logs, join(evidence, 'workspace-logs'), { recursive: true });
      await run('final-logs', process.execPath, [cli, 'logs', '--source', 'all', '--json']);
    } catch (error) {
      summary.diagnostics.push(error.message);
    }
    try {
      assert.equal((await stim('cleanup-stop', ['stop'])).ok, true);
    } catch (error) {
      cleanupFailures.push(error.message);
    }
    try {
      await run('cleanup-remove', process.execPath, [cli, 'worktree', 'remove', '--force', app], {
        cwd: source,
        timeout: 5 * 60_000,
      });
      assert.equal(existsSync(app), false);
      assert.deepEqual(cleanup.remainingDevices(), []);
      await cleanup.verifyProcesses();
      const status = await stim('cleanup-status', ['status'], { cwd: source });
      assert(!status.environments.some((entry) => entry.path === app));
    } catch (error) {
      cleanupFailures.push(error.message);
    }
  }
  summary.cleanup = { ok: cleanupFailures.length === 0, failures: cleanupFailures };
  writeFileSync(join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (cleanupFailures.length) {
    process.exitCode = 1;
    process.stderr.write(`Ownership state retained at ${temporary}: ${cleanupFailures.join('; ')}\n`);
  } else rmSync(temporary, { recursive: true, force: true });
}
if (summary.failure) process.stderr.write(`${summary.failure}\n`);
