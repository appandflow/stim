import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert(process.env.CI === 'true' || process.env.CI === '1');
assert.equal(process.platform, 'darwin');
const exec = promisify(execFile);
const root = realpathSync(resolve(process.argv[2]));
assert.equal(root, join(realpathSync(process.env.RUNNER_TEMP), 'hosted-native-android'));
const evidence = join(root, 'evidence');
mkdirSync(evidence, { recursive: true });
if (!process.env.STIM_HOSTED_ANDROID_ROOT) {
  writeFileSync(
    join(root, 'tls.conf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
  );
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    join(root, 'tls.conf'),
    '-keyout',
    join(root, 'tls.key'),
    '-out',
    join(root, 'tls.crt'),
  ]);
  const child = fork(fileURLToPath(import.meta.url), [root], {
    env: { ...process.env, CI: '1', STIM_HOSTED_ANDROID_ROOT: root, NODE_EXTRA_CA_CERTS: join(root, 'tls.crt') },
    execArgv: ['--experimental-transform-types'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
assert.equal(process.env.STIM_HOSTED_ANDROID_ROOT, root);
assert.equal(process.env.NODE_EXTRA_CA_CERTS, join(root, 'tls.crt'));
const source = join(root, 'source');
const app = join(root, 'app');
const home = join(root, 'client-home');
const hostHome = join(root, 'host-home');
const cli = fileURLToPath(new URL('../../../packages/stim-cli/dist/cli.mjs', import.meta.url));
const serverCli = fileURLToPath(new URL('../../../packages/server/dist/stim-server.mjs', import.meta.url));
const env = {
  ...process.env,
  CI: '1',
  STIM_HOME: home,
  STIM_DEBUG: '1',
  STIM_MAINTENANCE: 'off',
  STIM_POOL_IOS_PARKED_MAX: '0',
  STIM_POOL_ANDROID_PARKED_MAX: '0',
  GRADLE_USER_HOME: join(root, 'gradle-home'),
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  AGENT_DEVICE_HOME: join(root, 'agent-client'),
  AGENT_DEVICE_STATE_DIR: join(root, 'agent-client-state'),
  AGENT_DEVICE_CLAIMS_DIR: join(root, 'agent-client-claims'),
};
const hostEnv = {
  ...env,
  STIM_HOME: hostHome,
  STIM_HOSTED_ANDROID_EVIDENCE: evidence,
  AGENT_DEVICE_HOME: join(root, 'agent-host'),
  AGENT_DEVICE_STATE_DIR: join(root, 'agent-host-state'),
  AGENT_DEVICE_CLAIMS_DIR: join(root, 'agent-host-claims'),
};
for (const dir of [source, home, hostHome, join(root, 'bin')]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
const { inspectDeviceHostMachines } = await import('../../../packages/stim-cli/src/device-host/machines.ts');
const {
  readDeviceHostMachines,
  readHostedSessions,
  readWorkspaceState,
  hostedAndroidPlacements,
  assertHostedDeviceLedger,
} = await import('../../../packages/core/state/index.ts');
const { readClaimSet } = await import('../../../packages/core/ownership-claim.ts');
const { workspaceStateDir } = await import('../../../packages/core/index.ts');
const secrets = new Set();
const summary = {
  source: process.env.GITHUB_SHA,
  transport: 'synthetic Tailnet identity over verified loopback TLS',
  runs: [],
  failure: null,
  cleanup: null,
};
const sessions = new Map();
let host;
let hostExit;
let machine;
let worktree = false;
let activeFacts;
let beforeDevices;
let beforeAvds;
let commandNumber = 0;
const redact = (text) => {
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
  return text;
};
const save = (label, value) =>
  writeFileSync(
    join(evidence, `${label}.json`),
    JSON.stringify(
      value,
      (key, val) => (/token|secret/i.test(key) ? '[redacted]' : typeof val === 'string' ? redact(val) : val),
      2,
    ) + '\n',
  );
async function run(label, file, args, options = {}) {
  const prefix = join(evidence, `${String(++commandNumber).padStart(3, '0')}-${label}`);
  let output;
  try {
    output = await exec(file, args, {
      cwd: options.cwd ?? app,
      env: options.env ?? env,
      timeout: options.timeout ?? 60_000,
      killSignal: 'SIGINT',
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
    return output.stdout;
  } catch (error) {
    output = { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
    throw error;
  } finally {
    if (output) {
      writeFileSync(`${prefix}.stdout`, redact(output.stdout));
      writeFileSync(`${prefix}.stderr`, redact(output.stderr));
    }
  }
}
async function stim(label, args, options) {
  return JSON.parse(await run(label, process.execPath, [cli, ...args, '--json'], options));
}
function hostSessions() {
  const previous = process.env.STIM_HOME;
  process.env.STIM_HOME = hostHome;
  try {
    return readHostedSessions();
  } finally {
    process.env.STIM_HOME = previous;
  }
}
async function captureOwnedGuestDiagnostics(session) {
  const deadline = Date.now() + 15_000;
  const query = async (name, args) => {
    assert(Date.now() < deadline, 'Guest diagnostic deadline reached');
    let output;
    try {
      output = await exec('adb', ['-s', session.device.serial, ...args], {
        env: hostEnv,
        timeout: Math.min(5000, deadline - Date.now()),
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
      });
      return output.stdout;
    } catch (error) {
      output = { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
      throw error;
    } finally {
      if (output)
        save(`before-cleanup-${session.id}-guest-${name}`, {
          stdout: output.stdout.slice(-128 * 1024),
          stderr: output.stderr.slice(-128 * 1024),
        });
    }
  };
  try {
    assertHostedDeviceLedger(
      join(hostHome, 'device-host', 'sessions', session.id, 'home'),
      session.device.avdName,
      'android',
    );
    const avdName = await query('avd-name', ['emu', 'avd', 'name']);
    assert.equal(avdName.trim().split(/\r?\n/)[0], session.device.avdName);
    for (const [name, args] of [
      ['properties', ['shell', 'getprop']],
      ['services', ['shell', 'service', 'list']],
      ['logcat', ['logcat', '-b', 'all', '-d', '-t', '500']],
    ]) {
      try {
        await query(name, args);
      } catch (error) {
        save(`before-cleanup-${session.id}-guest-${name}-error`, { error: error.message });
      }
    }
  } catch (error) {
    save(`before-cleanup-${session.id}-guest-refusal`, { error: error.message });
  }
}
async function captureHostDiagnostics(label) {
  try {
    const records = hostSessions();
    save(`${label}-host-sessions`, records);
    const files = [['host-debug', join(hostHome, 'logs', 'debug', 'server.ndjson')]];
    for (const session of records) {
      if (label === 'before-cleanup' && session.platform === 'android' && session.device)
        await captureOwnedGuestDiagnostics(session);
      const area = join(hostHome, 'device-host', 'sessions', session.id, 'home');
      save(
        `${label}-${session.id}-claim`,
        readClaimSet(join(hostHome, 'server', 'device-host-sessions', `${session.id}.claims`)),
      );
      for (const path of ['hosted-device.json', 'created-devices.json', 'emulator.log', 'logs/debug/cli.ndjson'])
        files.push([`${session.id}-${path.replaceAll('/', '-')}`, join(area, path)]);
    }
    for (const [name, path] of files) {
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      const bytes = Buffer.alloc(Math.min(size, 128 * 1024));
      const descriptor = openSync(path, 'r');
      try {
        readSync(descriptor, bytes, 0, bytes.length, size - bytes.length);
      } finally {
        closeSync(descriptor);
      }
      writeFileSync(join(evidence, `${label}-${name}.txt`), redact(bytes.toString('utf8')));
    }
  } catch (error) {
    console.error(`Host diagnostic snapshot failed: ${redact(error.message)}`);
  }
}
async function deviceInventory(label) {
  return (await run(label, 'adb', ['devices']))
    .split('\n')
    .filter((line) => /^\S+\t/.test(line))
    .toSorted();
}
async function avdInventory(label) {
  return (await run(label, 'emulator', ['-list-avds'])).trim().split('\n').filter(Boolean).toSorted();
}
async function appPid(label, session, bundleId) {
  const value = (
    await run(label, 'adb', ['-s', session.device.serial, 'shell', 'pidof', bundleId], {
      env: hostEnv,
      timeout: 10_000,
    })
  ).trim();
  assert.match(value, /^[1-9]\d*$/);
  return value;
}
async function agent(label, facts, args) {
  assert.equal(facts.host.agent.driver, 'agent-device');
  const config = JSON.parse(readFileSync(facts.host.agent.remoteConfig, 'utf8'));
  secrets.add(config.daemonAuthToken);
  return run(
    label,
    'agent-device',
    [...args, '--remote-config', facts.host.agent.remoteConfig, '--session', 'hosted-native-android'],
    { timeout: 5 * 60_000 },
  );
}
async function closeAgent() {
  if (!activeFacts) return;
  await agent('agent-close', activeFacts, ['close']);
  activeFacts = undefined;
}
async function lifecycle(label, revision) {
  const facts = await stim(label, ['android', '--variant', 'freeDebug', '--remote', machine, '--slot', 'tablet'], {
    timeout: 20 * 60_000,
  });
  assert.equal(facts.bundleId, 'org.example.stim.free.debug');
  assert.equal(facts.launched, true);
  assert.equal(facts.metroPort, null);
  assert.equal(facts.serial, null);
  assert.equal(facts.cacheKey, null);
  assert.equal(facts.cacheSkipped, true);
  assert.equal(facts.slot, 'tablet');
  assert.equal(facts.host.machine, machine);
  const session = hostSessions().find((item) => item.id === facts.host.session);
  assert.equal(session?.state, 'ready');
  assert.equal(session.platform, 'android');
  assert.equal(session.slot, 'tablet');
  assert.equal(session.device.systemImage, process.env.STIM_QA_ANDROID_SYSTEM_IMAGE);
  assertHostedDeviceLedger(
    join(hostHome, 'device-host', 'sessions', session.id, 'home'),
    session.device.avdName,
    'android',
  );
  const previous = sessions.get('tablet');
  if (previous) {
    assert.equal(session.id, previous.id);
    assert.equal(session.device.avdName, previous.device.avdName);
  }
  sessions.set('tablet', session);
  const receipt = JSON.parse(
    readFileSync(
      join(hostHome, 'device-host', 'sessions', session.id, 'apps', session.appAttempt, 'receipt.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.mode, 'process');
  assert.equal(receipt.state, 'installed');
  const state = readWorkspaceState(app);
  assert.equal(state.supervisor, undefined);
  assert.equal(state.launches['android:tablet'].runtime, 'process');
  assert.equal(state.launches.android, undefined);
  assert.equal(hostedAndroidPlacements(state).tablet.session, session.id);
  const before = await appPid(`${label}-before-ui`, session, facts.bundleId);
  activeFacts = facts;
  await agent(`${label}-open`, facts, ['open', facts.bundleId, '--platform', 'android', '--foreground']);
  assert.equal(await appPid(`${label}-after-open`, session, facts.bundleId), before);
  await agent(`${label}-revision`, facts, ['wait', 'text', `Native QA ${revision}`, '30000']);
  await agent(`${label}-zero`, facts, ['wait', 'text', 'Taps: 0', '30000']);
  await agent(`${label}-press`, facts, ['press', 'label="Increment native counter"', '--settle']);
  await agent(`${label}-one`, facts, ['wait', 'text', 'Taps: 1', '30000']);
  await agent(`${label}-snapshot`, facts, ['snapshot', '-i']);
  const screenshot = join(evidence, `${label}.png`);
  await agent(`${label}-screenshot`, facts, ['screenshot', screenshot]);
  assert(statSync(screenshot).size > 0);
  assert.equal(await appPid(`${label}-after-ui`, session, facts.bundleId), before);
  await closeAgent();
  const digest = createHash('sha256').update(readFileSync(facts.appPath)).digest('hex');
  save(`${label}-facts`, facts);
  save(`${label}-session`, session);
  summary.runs.push({
    label,
    revision,
    session: session.id,
    attempt: session.appAttempt,
    pid: before,
    apk: digest,
    screenshot,
  });
  assert.deepEqual(readClaimSet(join(workspaceStateDir(app), 'native-run.lock')), {
    live: [],
    dead: [],
    unresolved: [],
    orphans: [],
  });
  return digest;
}
try {
  writeFileSync(
    join(root, 'bin', 'tailscale'),
    `#!/usr/bin/env node\nconst [command, , ip] = process.argv.slice(2);\nif (command === 'status') console.log(JSON.stringify({BackendState:'Running', Self:{ID:'ci-client',HostName:'CI client',DNSName:'ci-client.invalid.'}, Peer:{host:{ID:'ci-host',DNSName:'localhost.',TailscaleIPs:['127.0.0.1']}}}));\nelse if (command === 'whois' && ip === '100.64.0.11') console.log(JSON.stringify({Node:{ID:11,StableID:'ci-client',Name:'ci-client.invalid.'},UserProfile:{LoginName:'ci@example.invalid'}}));\nelse process.exit(1);\n`,
    { mode: 0o700 },
  );
  cpSync(join(root, 'project'), source, { recursive: true });
  writeFileSync(join(source, '.gitignore'), '.gradle/\n**/build/\nlocal.properties\n');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Stim hosted acceptance'],
    ['config', 'user.email', 'ci@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-m', 'Native Android fixture'],
    ['worktree', 'add', '--detach', app, 'HEAD'],
  ])
    await run('git', 'git', args, { cwd: source });
  worktree = true;
  for (const setupEnv of [env, hostEnv])
    for (const key of ['iosSimulatorApp', 'androidEmulatorApp'])
      await run('viewer-setting', process.execPath, [cli, 'settings', 'set', key, 'stim-desktop'], { env: setupEnv });
  await run('workflow-guide', process.execPath, [cli, 'guide', 'agent']);
  await run('host-agent-setting', process.execPath, [cli, 'settings', 'set', 'hosting.agentDriver', 'agent-device'], {
    env: hostEnv,
  });
  beforeDevices = await deviceInventory('devices-before');
  beforeAvds = await avdInventory('avds-before');
  host = fork(fileURLToPath(new URL('./hosted-android-server.mjs', import.meta.url)), [], {
    env: hostEnv,
    execArgv: ['--experimental-transform-types'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  host.stdout.on('data', (data) => process.stderr.write(redact(String(data))));
  host.stderr.on('data', (data) => process.stderr.write(redact(String(data))));
  hostExit = once(host, 'exit');
  const [ready] = await Promise.race([
    once(host, 'message'),
    hostExit.then(() => {
      throw new Error('Host exited before ready');
    }),
    sleep(240_000, undefined, { ref: false }).then(() => {
      throw new Error('Host startup did not settle');
    }),
  ]);
  machine = ready.machine;
  assert.match(machine, /^localhost:\d+$/);
  await run('host-configuration', process.execPath, [
    cli,
    'settings',
    'set',
    'remote.machines',
    JSON.stringify([machine]),
  ]);
  const pending = await inspectDeviceHostMachines({ fix: true });
  assert.equal(pending.machines[0].state, 'pending');
  const credential = readDeviceHostMachines()[0];
  secrets.add(credential.deviceToken);
  assert.equal(credential.nodeId, 'ci-host');
  const listed = JSON.parse(
    await run('host-pending', process.execPath, [serverCli, 'devices', '--json'], { env: hostEnv }),
  );
  const request = listed.devices.find((entry) => entry.id === credential.deviceId);
  assert.equal(request.requestedCapability, 'device-host');
  assert.deepEqual(request.capabilities, []);
  await run('host-grant', process.execPath, [serverCli, 'devices', 'grant', credential.deviceId, '--device-host'], {
    env: hostEnv,
  });
  assert.equal((await inspectDeviceHostMachines({ fix: false })).machines[0].state, 'approved');
  const cold = await lifecycle('cold', 'initial');
  assert.equal(await lifecycle('warm', 'initial'), cold);
  const kotlin = join(app, 'mobile/src/main/java/org/example/stim/MainActivity.kt');
  const original = readFileSync(kotlin, 'utf8');
  assert(original.includes('Native QA initial'));
  writeFileSync(kotlin, original.replace('Native QA initial', 'Native QA edited'));
  assert.notEqual(await lifecycle('edited', 'edited'), cold);
  const session = sessions.get('tablet');
  const beforeFailure = await appPid('before-invalid-build', session, 'org.example.stim.free.debug');
  writeFileSync(kotlin, 'not valid Kotlin');
  await assert.rejects(
    () =>
      stim('compile-failure', ['android', '--variant', 'freeDebug', '--remote', machine, '--slot', 'tablet'], {
        timeout: 20 * 60_000,
      }),
    (error) => error.code === 1 && String(error.stdout).includes('STIM_BUILD_FAILED'),
  );
  assert.equal(await appPid('after-invalid-build', session, 'org.example.stim.free.debug'), beforeFailure);
  writeFileSync(kotlin, original.replace('Native QA initial', 'Native QA recovered'));
  await lifecycle('recovered', 'recovered');
  await assert.rejects(
    () => stim('native-reload', ['reload', 'android', '--slot', 'tablet']),
    (error) => error.code === 1 && String(error.stdout).includes('STIM_NO_METRO'),
  );
  const methods = readFileSync(join(evidence, 'host-requests.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method)
    .filter(Boolean);
  assert(methods.includes('device-host.app.launch'));
  assert(!methods.includes('device-host.metro.open'));
  assert(!methods.includes('build.start'));
} catch (error) {
  summary.failure = redact(error.stack ?? String(error));
  await captureHostDiagnostics('before-cleanup');
  process.exitCode = 1;
} finally {
  const failures = [];
  try {
    await closeAgent();
  } catch (error) {
    failures.push(`agent close: ${error.message}`);
  }
  if (worktree) {
    try {
      assert.equal((await stim('stop-workspace', ['stop'])).ok, true);
      assert.deepEqual(Object.keys(hostedAndroidPlacements(readWorkspaceState(app))), []);
      for (const session of hostSessions()) {
        assert.equal(session.state, 'stopped');
        assert.deepEqual(readClaimSet(join(hostHome, 'server', 'device-host-sessions', `${session.id}.claims`)), {
          live: [],
          dead: [],
          unresolved: [],
          orphans: [],
        });
      }
      if (beforeDevices) assert.deepEqual(await deviceInventory('devices-after'), beforeDevices);
      if (beforeAvds) assert.deepEqual(await avdInventory('avds-after'), beforeAvds);
      await run('remove', process.execPath, [cli, 'worktree', 'remove', '--force', app], { cwd: source });
      assert(!existsSync(app));
    } catch (error) {
      failures.push(`owned cleanup: ${error.message}`);
    }
  }
  if (host) {
    try {
      if (host.connected) host.send('close');
      const [code] = await Promise.race([
        hostExit,
        sleep(180_000, undefined, { ref: false }).then(() => {
          throw new Error('Host close did not settle');
        }),
      ]);
      assert.equal(code, 0);
    } catch (error) {
      failures.push(`host close: ${error.message}`);
      if (host.connected) host.disconnect();
      host.unref();
    }
  }
  if (summary.failure || failures.length) await captureHostDiagnostics('after-cleanup');
  summary.cleanup = { ok: failures.length === 0, failures };
  save('summary', summary);
  if (summary.failure || failures.length) {
    process.exitCode = 1;
    console.error(redact(JSON.stringify(summary)));
  } else {
    for (const path of [home, hostHome, join(root, 'agent-client'), join(root, 'agent-host')])
      rmSync(path, { recursive: true, force: true });
  }
}
