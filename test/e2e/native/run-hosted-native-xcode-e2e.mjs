import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert(process.env.CI === '1' || process.env.CI === 'true', 'This driver runs only in CI.');
assert.equal(process.platform, 'darwin');
const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const evidence = resolve(process.env.STIM_HOSTED_XCODE_EVIDENCE ?? 'artifacts/hosted-native-xcode');
mkdirSync(evidence, { recursive: true });
if (!process.env.STIM_HOSTED_XCODE_ROOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-xcode-')));
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
  const child = fork(script, [], {
    env: {
      ...process.env,
      CI: '1',
      STIM_HOSTED_XCODE_ROOT: root,
      STIM_HOSTED_XCODE_EVIDENCE: evidence,
      NODE_EXTRA_CA_CERTS: join(root, 'tls.crt'),
    },
    execArgv: ['--experimental-transform-types'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
const root = realpathSync(process.env.STIM_HOSTED_XCODE_ROOT);
assert(root.startsWith(realpathSync(tmpdir()) + '/stim-hosted-xcode-'));
assert.equal(process.env.NODE_EXTRA_CA_CERTS, join(root, 'tls.crt'));
const source = join(root, 'source');
const app = join(root, 'app');
const clientHome = join(root, 'client-home');
const hostHome = join(root, 'host-home');
const cli = fileURLToPath(new URL('../../../packages/stim-cli/dist/cli.mjs', import.meta.url));
const serverCli = fileURLToPath(new URL('../../../packages/server/dist/stim-server.mjs', import.meta.url));
const env = {
  ...process.env,
  CI: '1',
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  STIM_HOME: clientHome,
  STIM_DEBUG: '1',
  STIM_BUILD_CACHE: join(root, 'build-cache'),
  STIM_POOL_IOS_PARKED_MAX: '0',
  STIM_POOL_ANDROID_PARKED_MAX: '0',
  STIM_MAINTENANCE: 'off',
  AGENT_DEVICE_HOME: join(root, 'agent-client'),
  AGENT_DEVICE_STATE_DIR: join(root, 'agent-client-state'),
  AGENT_DEVICE_CLAIMS_DIR: join(root, 'agent-client-claims'),
  STIM_AGENT_DEVICE_BIN: join(process.env.HOME, '.local', 'bin', 'agent-device'),
  PATH: `${join(root, 'bin')}:${process.env.PATH}`,
};
const hostEnv = {
  ...env,
  STIM_HOME: hostHome,
  AGENT_DEVICE_HOME: join(root, 'agent-host'),
  AGENT_DEVICE_STATE_DIR: join(root, 'agent-host-state'),
  AGENT_DEVICE_CLAIMS_DIR: join(root, 'agent-host-claims'),
};
for (const path of [source, clientHome, hostHome, join(root, 'bin')]) mkdirSync(path, { recursive: true });
Object.assign(process.env, env);
const { inspectDeviceHostMachines } = await import('../../../packages/stim-cli/src/device-host/machines.ts');
const { readDeviceHostMachines } = await import('../../../packages/core/state/device-host-machines.ts');
const { assertHostedDeviceLedger } = await import('../../../packages/core/state/device-host.ts');
const { openObserver } = await import('./hosted-xcode-client.mjs');
const { createCleanupTracker, createHarness } = await import('./harness.mjs');
const cleanup = createCleanupTracker({
  h: createHarness({ env, cliPath: cli, label: 'hosted-native-xcode' }),
  platform: 'ios',
});
const summary = {
  root,
  runs: [],
  steps: [],
  diagnostics: [],
  failure: null,
  cleanup: null,
  transport: 'synthetic Tailnet identity over verified loopback TLS',
};
let serial = 0;
let host;
let hostExit;
let observer;
let machine;
let createdWorktree = false;
let initialDevices;
const sessions = new Map();
const secrets = new Set();
function redact(text) {
  for (const value of secrets) text = text.replaceAll(value, '[redacted]');
  return text;
}
function save(label, payload) {
  writeFileSync(
    join(evidence, `${label}.json`),
    JSON.stringify(payload, (key, value) => (/token|secret/i.test(key) ? '[redacted]' : value), 2) + '\n',
  );
}
function retainDebug(stage) {
  const homes = [
    ['client', clientHome],
    ['host', hostHome],
  ];
  const sessionRoot = join(hostHome, 'device-host', 'sessions');
  for (const entry of existsSync(sessionRoot) ? readdirSync(sessionRoot, { withFileTypes: true }) : [])
    if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      homes.push([entry.name, join(sessionRoot, entry.name, 'home')]);
  for (const [name, home] of homes) {
    for (const file of ['cli.ndjson', 'cli.ndjson.1', 'server.ndjson', 'server.ndjson.1']) {
      const path = join(home, 'logs', 'debug', file);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      assert(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'Debug capture must be a bounded regular file.');
      const target = join(evidence, 'debug', stage, name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, file), redact(readFileSync(path, 'utf8')));
    }
  }
}
async function run(label, file, args, options = {}) {
  const prefix = join(evidence, `${String(++serial).padStart(3, '0')}-${label}`);
  const start = Date.now();
  let out;
  try {
    out = await exec(file, args, {
      cwd: options.cwd ?? app,
      env: options.env ?? env,
      timeout: options.timeout ?? 60_000,
      killSignal: 'SIGINT',
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    out = { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
    throw new Error(`${label} failed; see ${prefix}.stderr`, { cause: error });
  } finally {
    if (out) {
      writeFileSync(`${prefix}.stdout`, redact(out.stdout));
      writeFileSync(`${prefix}.stderr`, redact(out.stderr));
    }
    summary.steps.push({ label, durationMs: Date.now() - start });
    console.error(`[hosted-xcode] ${label}: ${Date.now() - start}ms`);
  }
  return out.stdout;
}
const stim = async (label, args, options) =>
  JSON.parse(await run(label, process.execPath, [cli, ...args, '--json'], options));
const inventory = async (label) =>
  Object.values(
    JSON.parse(await run(label, 'xcrun', ['simctl', 'list', 'devices', '--json'], { cwd: source })).devices,
  ).flat();
async function pid(label, device, bundleId) {
  const rows = await run(label, 'xcrun', ['simctl', 'spawn', device.udid, 'launchctl', 'list']);
  const row = rows.split('\n').find((line) => line.includes(`UIKitApplication:${bundleId}[`));
  const value = Number(row?.trim().split(/\s+/)[0]);
  assert(Number.isSafeInteger(value) && value > 0, 'The exact hosted app must already be running.');
  return value;
}
async function agent(label, facts, args) {
  assert.equal(facts.host.agent.driver, 'agent-device');
  const config = JSON.parse(readFileSync(facts.host.agent.remoteConfig, 'utf8'));
  secrets.add(config.daemonAuthToken);
  return run(
    label,
    env.STIM_AGENT_DEVICE_BIN,
    [...args, '--remote-config', facts.host.agent.remoteConfig, '--session', `hosted-native-acceptance-${facts.slot}`],
    { timeout: 5 * 60_000 },
  );
}
async function frame(label, session) {
  const since = Date.now();
  const subscription = (await observer.rpc('device-host.frames.subscribe', { session, fps: 2, maxEdge: 800 }))
    .subscription;
  let failure;
  try {
    const image = await observer.frame(subscription, since, 720);
    assert.equal(image.platform, 'ios');
    assert.equal(image.mime, 'image/jpeg');
    assert.equal(image.subscription, subscription);
    assert(Date.parse(image.capturedAt) >= since);
    assert(image.width > 0 && image.height > 0);
    assert(Math.max(image.width, image.height) > 720);
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
    save(`${label}-frame`, {
      subscription,
      since,
      capturedAt: image.capturedAt,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
    });
    const file = join(evidence, `${label}.jpg`);
    writeFileSync(file, bytes);
    const decoded = await run(`${label}-decode`, 'sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    assert.match(decoded, new RegExp(`pixelWidth: ${image.width}\\b`));
    assert.match(decoded, new RegExp(`pixelHeight: ${image.height}\\b`));
  } catch (error) {
    failure = error;
  }
  try {
    await observer.rpc('device-host.unsubscribe', { subscription });
  } catch (error) {
    if (failure) summary.diagnostics.push(`${label} frame unsubscribe: ${error.message}`);
    else failure = error;
  }
  if (failure) throw failure;
}
async function verify(label, facts, revision, interact) {
  const session = await observer.rpc('device-host.attach', { session: facts.host.session });
  assert.equal(session.state, 'ready');
  assert.equal(session.platform, 'ios');
  assert.equal(session.client, readDeviceHostMachines()[0].deviceId);
  assert.equal(session.metroPort, undefined);
  assert(session.appAttempt);
  assertHostedDeviceLedger(join(hostHome, 'device-host', 'sessions', session.id, 'home'), session.device.udid);
  cleanup.recordBuild({ udid: session.device.udid });
  const beforePid = await pid(`${label}-pid-before-ui`, session.device, facts.bundleId);
  save(`${label}-session`, session);
  const receipt = JSON.parse(
    readFileSync(
      join(hostHome, 'device-host', 'sessions', session.id, 'apps', session.appAttempt, 'receipt.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.mode, 'process');
  assert.equal(receipt.state, 'installed');
  assert.equal(receipt.launched, true);
  save(`${label}-receipt`, receipt);
  const subscription = (
    await observer.rpc('device-host.frames.subscribe', { session: session.id, fps: 2, maxEdge: 720 })
  ).subscription;
  try {
    await frame(`${label}-before-ui`, session.id);
    const connection = JSON.parse(await agent(`${label}-connect`, facts, ['connect', '--force', '--json']));
    assert.equal(connection.success, true);
    assert.equal(connection.data.connected, true);
    assert.equal(connection.data.session, `hosted-native-acceptance-${facts.slot}`);
    assert.equal(connection.data.remoteConfig, facts.host.agent.remoteConfig);
    assert.equal(connection.data.tenant, `stim.${session.id}`);
    assert.equal(connection.data.runId, session.id);
    assert.equal(connection.data.leaseBackend, 'ios-instance');
    await agent(`${label}-open`, facts, ['open', facts.bundleId, '--platform', 'ios', '--foreground']);
    assert.equal(await pid(`${label}-pid-after-open`, session.device, facts.bundleId), beforePid);
    await agent(`${label}-revision`, facts, ['wait', 'text', revision, '30000']);
    await agent(`${label}-counter`, facts, ['wait', 'text', 'Count: 0', '30000']);
    if (interact) {
      const control = await observer.rpc('device-host.control.begin', { session: session.id });
      const clickedAt = Date.now();
      try {
        assert.equal(control.platform, 'ios');
        await observer.rpc('device-host.input.touch', { session: control.session, phase: 'down', x: 0.5, y: 0.5 });
        await observer.rpc('device-host.input.touch', { session: control.session, phase: 'up', x: 0.5, y: 0.5 });
      } finally {
        await observer.rpc('device-host.control.end', { session: control.session });
      }
      await agent(`${label}-clicked`, facts, ['wait', 'text', 'Count: 1', '30000']);
      await agent(`${label}-snapshot`, facts, ['snapshot', '-i']);
      await frame(`${label}-after-click`, session.id);
      let records = [];
      const deadline = Date.now() + 30_000;
      do {
        records = (
          await run(`${label}-click-logs`, process.execPath, [
            cli,
            'logs',
            '--source',
            'device',
            '--slot',
            facts.slot,
            '--grep',
            `native-acceptance-click:${revision}:1`,
            '--json',
          ])
        )
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (records.some((record) => record.ts >= clickedAt)) break;
        await sleep(1000);
      } while (Date.now() < deadline);
      assert(
        records.some((record) => record.ts >= clickedAt),
        'The hosted log path must return the actual input effect.',
      );
    }
    assert.equal(await pid(`${label}-pid-after-control`, session.device, facts.bundleId), beforePid);
  } finally {
    await observer.rpc('device-host.unsubscribe', { subscription });
  }
  assert.equal(
    (await run(`${label}-errors`, process.execPath, [cli, 'logs', '--errors', '--slot', facts.slot, '--json'])).trim(),
    '',
  );
  sessions.set(facts.slot, { session, facts, pid: beforePid });
  return session;
}
async function lifecycle(configuration, phase, hit, revision, slot = 'primary') {
  const label = `${slot}-${configuration}-${phase}`;
  let facts;
  try {
    facts = await stim(
      label,
      ['ios', '--scheme', 'NativeAcceptance', '--configuration', configuration, '--remote', machine, '--slot', slot],
      { timeout: 15 * 60_000 },
    );
  } finally {
    cleanup.recordWorkspace(app);
  }
  assert.equal(facts.platform, 'ios');
  assert.equal(facts.configuration, configuration);
  assert.equal(facts.launched, true);
  assert.equal(facts.metroPort, null);
  assert.equal(typeof facts.fingerprint, 'string');
  assert(facts.fingerprint.length > 0);
  assert.equal(typeof facts.cacheKey, 'string');
  assert(facts.cacheKey.length > 0);
  assert.equal(facts.cacheHit, hit);
  assert.equal(facts.cacheSkipped, false);
  assert.equal(facts.host.machine, machine);
  assert.equal(facts.bundleId, 'dev.stim.native.acceptance');
  const previous = sessions.get(slot);
  if (previous) assert.equal(facts.host.session, previous.session.id);
  const session = await verify(label, { ...facts, slot }, revision, phase === 'cold');
  if (previous) {
    assert.equal(session.device.udid, previous.session.device.udid);
    assert.notEqual(session.appAttempt, previous.session.appAttempt);
  }
  const status = await stim(`${label}-status`, ['status']);
  const current = status.environments.find((entry) => entry.path === app);
  assert(current);
  assert.equal(current.metro, null);
  assert.equal(current.supervisor, null);
  summary.runs.push({
    configuration,
    phase,
    slot,
    session: session.id,
    attempt: session.appAttempt,
    cacheKey: facts.cacheKey,
    cacheHit: facts.cacheHit,
  });
  return facts;
}
try {
  writeFileSync(
    join(root, 'bin', 'tailscale'),
    `#!/usr/bin/env node\nconst [command, , ip] = process.argv.slice(2);\nif (command === 'status') console.log(JSON.stringify({BackendState:'Running', Self:{ID:'ci-client',HostName:'CI client',DNSName:'ci-client.invalid.'}, Peer:{host:{ID:'ci-host',DNSName:'localhost.',TailscaleIPs:['127.0.0.1']}}}));\nelse if (command === 'whois' && ip === '100.64.0.11') console.log(JSON.stringify({Node:{ID:11,StableID:'ci-client',Name:'ci-client.invalid.'},UserProfile:{LoginName:'ci@example.invalid'}}));\nelse process.exit(1);\n`,
    { mode: 0o700 },
  );
  cpSync(fileURLToPath(new URL('./fixtures/xcode', import.meta.url)), source, { recursive: true });
  writeFileSync(
    join(source, 'NativeAcceptance.swift'),
    `import SwiftUI\n@main struct NativeAcceptance: App { var body: some Scene { WindowGroup { AcceptanceView() } } }\nstruct AcceptanceView: View {\n @State private var count = 0\n private let revision = "native-revision-one"\n var body: some View {\n  GeometryReader { geometry in\n   Button { count += 1; NSLog("native-acceptance-click:%@:%d", revision, count) } label: {\n    VStack(spacing: 24) { Text(revision); Text("Count: \\(count)"); Text("Increment") }\n     .frame(width: geometry.size.width, height: geometry.size.height).contentShape(Rectangle())\n   }.buttonStyle(.plain).accessibilityIdentifier("increment")\n  }.ignoresSafeArea().onAppear { NSLog("native-acceptance-ready:%@", revision) }\n }\n}\n`,
  );
  writeFileSync(join(source, '.stim.json'), JSON.stringify({ optimizations: { releaseBundleSwap: false } }) + '\n');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Stim hosted acceptance'],
    ['config', 'user.email', 'ci@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-m', 'Native hosted fixture'],
    ['worktree', 'add', '--detach', app, 'HEAD'],
  ])
    await run('fixture-git', 'git', args, { cwd: source });
  createdWorktree = true;
  for (const setupEnv of [env, hostEnv]) {
    for (const [key, value] of [
      ['iosSimulatorApp', 'stim-desktop'],
      ['androidEmulatorApp', 'stim-desktop'],
    ])
      await run('viewer-setting', process.execPath, [cli, 'settings', 'set', key, value], { env: setupEnv });
  }
  await run('host-agent-setting', process.execPath, [cli, 'settings', 'set', 'hosting.agentDriver', 'agent-device'], {
    env: hostEnv,
  });
  await run('warm', process.execPath, [cli, 'worktree', 'warm']);
  initialDevices = await inventory('initial-devices');
  host = fork(fileURLToPath(new URL('./hosted-xcode-server.mjs', import.meta.url)), [], {
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
      throw new Error('Host exited before listening.');
    }),
    sleep(240_000, undefined, { ref: false }).then(() => {
      throw new Error('Host startup did not finish.');
    }),
  ]);
  machine = ready.machine;
  assert.match(machine, /^localhost:\d+$/);
  await run('configure-host', process.execPath, [cli, 'settings', 'set', 'remote.machines', JSON.stringify([machine])]);
  const pending = await inspectDeviceHostMachines({ fix: true });
  save('pending-request', pending);
  assert.equal(pending.machines.length, 1);
  assert.equal(pending.machines[0].state, 'pending');
  const credential = readDeviceHostMachines()[0];
  secrets.add(credential.deviceToken);
  assert.equal(credential.nodeId, 'ci-host');
  const listed = JSON.parse(
    await run('host-pending', process.execPath, [serverCli, 'devices', '--json'], { env: hostEnv }),
  );
  const request = listed.devices.find((device) => device.id === credential.deviceId);
  assert.equal(request.identity.nodeId, 'ci-client');
  assert.equal(request.requestedCapability, 'device-host');
  assert.deepEqual(request.capabilities, []);
  await run('grant-request', process.execPath, [serverCli, 'devices', 'grant', credential.deviceId, '--device-host'], {
    env: hostEnv,
  });
  const confirmed = await inspectDeviceHostMachines({ fix: false });
  save('confirmed-request', confirmed);
  assert.equal(confirmed.machines[0].state, 'approved');
  observer = await openObserver(readDeviceHostMachines()[0]);
  const cold = await lifecycle('Debug', 'cold', false, 'native-revision-one');
  const warm = await lifecycle('Debug', 'warm', 'local', 'native-revision-one');
  assert.equal(warm.cacheKey, cold.cacheKey);
  const primary = sessions.get('primary');
  observer.drop();
  observer = await openObserver(readDeviceHostMachines()[0]);
  const reattached = await observer.rpc('device-host.attach', { session: primary.session.id });
  assert.equal(reattached.appAttempt, primary.session.appAttempt);
  assert.deepEqual(reattached.device, primary.session.device);
  const attachedApp = await observer.rpc('device-host.app.attach', {
    session: reattached.id,
    attempt: reattached.appAttempt,
  });
  save('reattached-app', attachedApp);
  assert.equal(attachedApp.launched, true);
  assert.equal(await pid('reconnect-pid', reattached.device, primary.facts.bundleId), primary.pid);
  const subscription = (
    await observer.rpc('device-host.frames.subscribe', { session: reattached.id, fps: 2, maxEdge: 720 })
  ).subscription;
  try {
    await frame('reconnect', reattached.id);
  } finally {
    await observer.rpc('device-host.unsubscribe', { subscription });
  }
  save('reconnect-witness', { session: reattached.id, attempt: reattached.appAttempt, pid: primary.pid });
  await lifecycle('Debug', 'warm', 'local', 'native-revision-one', 'sibling');
  const sibling = sessions.get('sibling');
  assert.notEqual(primary.session.device.udid, sibling.session.device.udid);
  assert.equal((await stim('stop-primary', ['stop', '--slot', 'primary'])).ok, true);
  assert.equal((await observer.rpc('device-host.attach', { session: primary.session.id })).state, 'stopped');
  assert(!(await inventory('after-primary-stop')).some((device) => device.udid === primary.session.device.udid));
  assert.equal((await observer.rpc('device-host.attach', { session: sibling.session.id })).state, 'ready');
  assert.equal(await pid('sibling-survives', sibling.session.device, sibling.facts.bundleId), sibling.pid);
  const methods = readFileSync(join(evidence, 'host-requests.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(!methods.some((event) => event.method === 'device-host.metro.open'));
  save('scoped-cleanup-witness', {
    primary: primary.session.id,
    removed: primary.session.device.udid,
    sibling: sibling.session.id,
    retained: sibling.session.device.udid,
    pid: sibling.pid,
  });
} catch (error) {
  summary.failure = redact(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  const failures = [];
  try {
    retainDebug('before-cleanup');
  } catch (error) {
    summary.diagnostics.push(`Debug capture before cleanup: ${error.message}`);
  }
  if (createdWorktree && existsSync(app)) {
    try {
      await run('final-logs', process.execPath, [cli, 'logs', '--source', 'all', '--json']);
    } catch (error) {
      summary.diagnostics.push(error.message);
    }
    try {
      assert.equal((await stim('cleanup-stop', ['stop'])).ok, true);
      for (const { session } of sessions.values())
        assert.equal((await observer.rpc('device-host.attach', { session: session.id })).state, 'stopped');
      await run('cleanup-remove', process.execPath, [cli, 'worktree', 'remove', '--force', app], {
        cwd: source,
        timeout: 5 * 60_000,
      });
      assert(!existsSync(app));
      assert.deepEqual(cleanup.remainingDevices(), []);
      await cleanup.verifyProcesses();
      const after = await inventory('final-devices');
      for (const { session } of sessions.values()) assert(!after.some((device) => device.udid === session.device.udid));
      for (const before of initialDevices ?? [])
        assert.equal(
          after.find((device) => device.udid === before.udid)?.state,
          before.state,
          'Unrelated simulator inventory must be preserved.',
        );
    } catch (error) {
      failures.push(error.message);
    }
  }
  observer?.close();
  if (host) {
    try {
      if (host.connected) host.send('close');
      const [code] = await Promise.race([
        hostExit,
        sleep(180_000, undefined, { ref: false }).then(() => {
          throw new Error('Owned host close did not settle.');
        }),
      ]);
      assert.equal(code, 0);
    } catch (error) {
      failures.push(error.message);
      if (host.connected) host.disconnect();
      host.unref();
    }
  }
  try {
    const journalPath = join(hostHome, 'server', 'device-host-sessions', 'sessions.json');
    if (existsSync(journalPath)) {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      save('final-host-sessions', journal);
      const remaining = await inventory('after-host-close');
      for (const session of journal.sessions) {
        assert.equal(session.state, 'stopped');
        assert.equal(session.parked, undefined);
        if (session.device) {
          assert(!remaining.some((device) => device.udid === session.device.udid));
          assert.equal(
            assertHostedDeviceLedger(
              join(hostHome, 'device-host', 'sessions', session.id, 'home'),
              session.device.udid,
              'ios',
              { allowEmpty: true },
            ),
            'empty',
          );
        }
      }
    }
  } catch (error) {
    failures.push(error.message);
  }
  try {
    retainDebug('after-cleanup');
  } catch (error) {
    summary.diagnostics.push(`Debug capture after cleanup: ${error.message}`);
  }
  summary.cleanup = { ok: failures.length === 0, failures };
  save('summary', summary);
  if (failures.length) {
    process.exitCode = 1;
    console.error(`Retained owned state at ${root}: ${failures.join('; ')}`);
  } else rmSync(root, { recursive: true, force: true });
}
if (summary.failure) console.error(summary.failure);
