import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
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

assert(process.env.CI === '1' || process.env.CI === 'true');
assert.equal(process.platform, 'darwin');
const exec = promisify(execFile);
const evidence = resolve(process.env.STIM_NATIVE_WORKER_EVIDENCE ?? 'artifacts/native-worker');
mkdirSync(evidence, { recursive: true });
if (!process.env.STIM_HOSTED_XCODE_ROOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-worker-')));
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
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: {
      ...process.env,
      CI: '1',
      STIM_HOSTED_XCODE_ROOT: root,
      STIM_NATIVE_WORKER_EVIDENCE: evidence,
      NODE_EXTRA_CA_CERTS: join(root, 'tls.crt'),
    },
    execArgv: ['--experimental-transform-types'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
const root = realpathSync(process.env.STIM_HOSTED_XCODE_ROOT);
assert(root.startsWith(realpathSync(tmpdir()) + '/stim-native-worker-'));
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
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  PATH: `${join(root, 'bin')}:${process.env.PATH}`,
};
const hostEnv = {
  ...env,
  STIM_HOME: hostHome,
  STIM_BUILD_CACHE: join(root, 'worker-cache'),
  STIM_NATIVE_WORKER_ONLY: '1',
  STIM_HOSTED_XCODE_EVIDENCE: evidence,
};
for (const path of [source, home, hostHome, join(root, 'bin')]) mkdirSync(path, { recursive: true });
Object.assign(process.env, env);
const { createStim } = await import('../../../packages/stim-cli/dist/api.mjs');
const { inspectBuildMachines, pinnedEndpoint } =
  await import('../../../packages/stim-cli/src/offload/build-machines.ts');
const { BuildConnection } = await import('../../../packages/stim-cli/src/offload/client.ts');
const { readBuildMachines, readWorkspaceState } = await import('../../../packages/core/state/index.ts');
const { readClaimSet } = await import('../../../packages/core/ownership-claim.ts');
const { fingerprintNativeInputs } = await import('../../../packages/stim-cli/src/integrations/native-inputs.ts');
let host;
let hostExit;
let machine;
let credential;
let worktree = false;
let workerArea;
const secrets = new Set();
const summary = {
  source: process.env.GITHUB_SHA,
  transport: 'synthetic Tailnet identity over verified loopback TLS',
  runs: [],
  failure: null,
  cleanup: null,
};
const redact = (value) => {
  for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
  return value;
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
let serial = 0;
async function run(label, file, args, options = {}) {
  const prefix = join(evidence, `${String(++serial).padStart(3, '0')}-${label}`);
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
function workerAreas() {
  if (!credential) return [];
  const repos = join(hostHome, 'build-worker', credential.deviceId, 'repos');
  if (!existsSync(repos)) return [];
  return readdirSync(repos, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.claims'))
    .map((entry) => join(repos, entry.name));
}
function workerState() {
  const areas = workerAreas();
  assert.equal(areas.length, 1);
  workerArea = areas[0];
  const previous = process.env.STIM_HOME;
  process.env.STIM_HOME = join(workerArea, 'home');
  try {
    return readWorkspaceState(join(workerArea, 'src'));
  } finally {
    process.env.STIM_HOME = previous;
  }
}
function claimsFree() {
  const areas = workerAreas();
  const paths = areas.map((area) => `${area}.claims`);
  for (const directory of [join(hostHome, 'build-slots'), ...areas.map((area) => join(area, 'home', 'build-slots'))])
    for (const entry of existsSync(directory) ? readdirSync(directory) : []) paths.push(join(directory, entry));
  for (const path of paths) assert.deepEqual(readClaimSet(path), { live: [], dead: [], unresolved: [], orphans: [] });
}
async function waitForWorkerCapacity(label) {
  const target = pinnedEndpoint(credential);
  assert.notEqual(typeof target, 'string');
  const connection = await BuildConnection.open(target, credential.deviceToken, 10_000);
  assert(connection instanceof BuildConnection, 'Approved worker must accept the capacity connection.');
  const samples = [];
  const deadline = Date.now() + 5 * 60_000;
  try {
    assert(connection.supports('native-xcode-build'));
    while (Date.now() < deadline) {
      const reply = await connection.request(
        'build.offer',
        { repo: 'native-worker-capacity' },
        Math.min(20_000, Math.max(1, deadline - Date.now())),
      );
      assert('result' in reply, JSON.stringify(reply));
      const capacity = reply.result.capacity;
      samples.push({ at: new Date().toISOString(), ...capacity });
      assert(Date.now() <= deadline, 'Worker capacity observation exceeded its deadline.');
      if (capacity.declined === null) return;
      assert.match(capacity.declined, /^load at or above /);
      await sleep(Math.min(15_000, Math.max(0, deadline - Date.now())));
    }
    assert.fail('Worker load did not settle within the capacity observation window.');
  } finally {
    connection.close();
    save(`${label}-capacity`, samples);
  }
}
async function build(label, revision, workerHit) {
  await waitForWorkerCapacity(label);
  const output = [];
  let parentClaim;
  const api = createStim({
    projectRoot: app,
    home,
    buildCache: join(root, `client-cache-${label}`),
    onProgress: (event) => {
      output.push(event.message);
      if (!parentClaim)
        for (const area of workerAreas()) {
          const claim = readClaimSet(`${area}.claims`).live.find((holder) => holder.child?.pid > 0);
          if (claim) parentClaim = claim;
        }
    },
  });
  let result;
  let buildFailed = false;
  try {
    result = await api.build({
      platform: 'ios',
      configuration: 'Debug',
      scheme: 'NativeAcceptance',
      arch: 'arm64',
      remoteBuild: machine,
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (error) {
    buildFailed = true;
    throw error;
  } finally {
    const failures = [];
    try {
      writeFileSync(join(evidence, `${label}.log`), redact(output.join('')));
    } catch (error) {
      failures.push(`progress evidence: ${error.message}`);
    }
    try {
      save(`${label}-diagnostics`, await api.diagnostics({ tail: 2000, signal: AbortSignal.timeout(30_000) }));
    } catch (error) {
      failures.push(`client diagnostics: ${error.message}`);
    }
    try {
      const areas = workerAreas();
      assert.equal(areas.length, 1);
      const directory = areas[0];
      save(`${label}-worker-state`, workerState());
      save(`${label}-worker-mirror`, JSON.parse(readFileSync(join(directory, 'mirror.json'), 'utf8')));
      const src = join(directory, 'src');
      save(
        `${label}-worker-inputs`,
        fingerprintNativeInputs([{ name: 'repository', path: src }], {
          excluded: [join(src, '.git')],
          parameters: null,
        }),
      );
    } catch (error) {
      failures.push(`worker evidence: ${error.message}`);
    }
    try {
      save(`${label}-evidence-status`, { ok: failures.length === 0, failures });
    } catch (error) {
      failures.push(`evidence status: ${error.message}`);
    }
    if (failures.length) console.error(redact(`Build evidence failed: ${failures.join('; ')}`));
    if (!buildFailed) assert.deepEqual(failures, []);
  }
  save(`${label}-result`, result);
  assert.equal(result.platform, 'ios');
  const facts = result.facts;
  assert.equal(facts.buildMachine, machine);
  assert.equal(facts.builtOn, machine);
  assert.equal(facts.cacheSkipped, false);
  assert.equal(facts.cacheHit, false);
  assert.equal(facts.bundleId, 'dev.stim.native.acceptance');
  assert.equal(typeof facts.cacheKey, 'string');
  assert(facts.cacheKey.length > 0);
  assert(parentClaim, 'A real server-owned claim must remain live while the worker reports progress.');
  assert.equal(parentClaim.owner.pid, host.pid);
  save(`${label}-parent-claim`, parentClaim);
  const state = workerState();
  save(`${label}-worker-state`, state);
  assert.equal(state.lastBuild.status, 'ok');
  assert.equal(state.lastBuild.cacheHit, workerHit);
  assert.equal(state.lastBuild.cacheKey, facts.cacheKey);
  assert.equal(state.activeBuild, undefined);
  assert.equal(state.supervisor, undefined);
  assert.equal(readWorkspaceState(app).supervisor, undefined);
  const strings = await run(`${label}-binary-strings`, '/usr/bin/strings', [
    '-a',
    join(facts.appPath, 'NativeAcceptance'),
  ]);
  assert(strings.includes(revision), 'Returned app must contain the current source revision.');
  const binaryHash = createHash('sha256')
    .update(readFileSync(join(facts.appPath, 'NativeAcceptance')))
    .digest('hex');
  claimsFree();
  const requests = readFileSync(join(evidence, 'host-requests.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(!requests.some((event) => event.method.startsWith('device-host.')));
  assert.equal(requests.filter((event) => event.method === 'build.start').length, summary.runs.length + 1);
  summary.runs.push({ label, cacheKey: facts.cacheKey, binaryHash, workerHit });
  return facts;
}
try {
  writeFileSync(
    join(root, 'bin', 'tailscale'),
    `#!/usr/bin/env node\nconst [command, , ip] = process.argv.slice(2);\nif (command === 'status') console.log(JSON.stringify({BackendState:'Running', Self:{ID:'ci-client',HostName:'CI client',DNSName:'ci-client.invalid.'}, Peer:{host:{ID:'ci-host',DNSName:'localhost.',TailscaleIPs:['127.0.0.1']}}}));\nelse if (command === 'whois' && ip === '100.64.0.11') console.log(JSON.stringify({Node:{ID:11,StableID:'ci-client',Name:'ci-client.invalid.'},UserProfile:{LoginName:'ci@example.invalid'}}));\nelse process.exit(1);\n`,
    { mode: 0o700 },
  );
  cpSync(fileURLToPath(new URL('./fixtures/xcode', import.meta.url)), source, { recursive: true });
  writeFileSync(join(source, '.stim.json'), JSON.stringify({ optimizations: { releaseBundleSwap: false } }) + '\n');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Stim worker acceptance'],
    ['config', 'user.email', 'ci@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-m', 'Native worker fixture'],
    ['worktree', 'add', '--detach', app, 'HEAD'],
  ])
    await run('git', 'git', args, { cwd: source });
  worktree = true;
  for (const setupEnv of [env, hostEnv])
    for (const key of ['iosSimulatorApp', 'androidEmulatorApp'])
      await run('viewer-setting', process.execPath, [cli, 'settings', 'set', key, 'stim-desktop'], { env: setupEnv });
  await run('worker-capacity', process.execPath, [cli, 'settings', 'set', 'concurrency.maxBuilds', '1'], {
    env: hostEnv,
  });
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
      throw new Error('Host exited before ready');
    }),
    sleep(240_000, undefined, { ref: false }).then(() => {
      throw new Error('Host startup did not settle');
    }),
  ]);
  machine = ready.machine;
  assert.match(machine, /^localhost:\d+$/);
  await run('configure-worker', process.execPath, [
    cli,
    'settings',
    'set',
    'remote.machines',
    JSON.stringify([machine]),
  ]);
  const pending = await inspectBuildMachines({ fix: true });
  save('build-request', pending);
  assert.equal(pending.machines.length, 1);
  assert.equal(pending.machines[0].state, 'pending');
  credential = readBuildMachines()[0];
  secrets.add(credential.deviceToken);
  assert.equal(credential.nodeId, 'ci-host');
  const listed = JSON.parse(
    await run('host-pending', process.execPath, [serverCli, 'devices', '--json'], { env: hostEnv }),
  );
  const request = listed.devices.find((entry) => entry.id === credential.deviceId);
  assert.equal(request.requestedCapability, 'build');
  assert.deepEqual(request.capabilities, []);
  await run('grant-build', process.execPath, [serverCli, 'devices', 'grant', credential.deviceId, '--build'], {
    env: hostEnv,
  });
  const confirmed = await inspectBuildMachines({ fix: false });
  save('build-confirmation', confirmed);
  assert.equal(confirmed.machines[0].state, 'approved');
  const cold = await build('cold', 'native-revision-one', false);
  const warm = await build('worker-warm', 'native-revision-one', 'local');
  assert.equal(warm.cacheKey, cold.cacheKey);
  assert.equal(summary.runs[1].binaryHash, summary.runs[0].binaryHash);
  const swift = join(app, 'NativeAcceptance.swift');
  writeFileSync(swift, readFileSync(swift, 'utf8').replaceAll('native-revision-one', 'native-revision-two'));
  const edited = await build('source-edit', 'native-revision-two', false);
  assert.notEqual(edited.cacheKey, cold.cacheKey);
  assert.notEqual(summary.runs[2].binaryHash, summary.runs[0].binaryHash);
} catch (error) {
  summary.failure = redact(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  const failures = [];
  try {
    if (worktree) {
      const stopped = JSON.parse(await run('stop', process.execPath, [cli, 'stop', '--json']));
      assert.equal(stopped.ok, true);
      await run('remove', process.execPath, [cli, 'worktree', 'remove', '--force', app], { cwd: source });
      assert(!existsSync(app));
    }
  } catch (error) {
    failures.push(error.message);
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
      failures.push(error.message);
      if (host.connected) host.disconnect();
      host.unref();
    }
  }
  try {
    claimsFree();
  } catch (error) {
    failures.push(error.message);
  }
  summary.cleanup = { ok: failures.length === 0, failures };
  let recorded = false;
  try {
    save('summary', summary);
    recorded = true;
  } catch (error) {
    console.error(redact(`Summary evidence failed: ${error.message}`));
  }
  if (failures.length || !recorded) {
    process.exitCode = 1;
    console.error(`Retained task state at ${root}: ${failures.join('; ')}`);
  } else rmSync(root, { recursive: true, force: true });
}
if (summary.failure) console.error(summary.failure);
