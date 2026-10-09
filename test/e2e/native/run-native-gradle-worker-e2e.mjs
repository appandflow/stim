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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert(process.env.CI === '1' || process.env.CI === 'true');
assert.equal(process.platform, 'darwin');
const exec = promisify(execFile);
const evidence = resolve(process.env.STIM_NATIVE_GRADLE_WORKER_EVIDENCE ?? 'artifacts/native-gradle-worker');
mkdirSync(evidence, { recursive: true });
if (!process.env.STIM_HOSTED_XCODE_ROOT) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-gradle-worker-')));
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
      STIM_NATIVE_GRADLE_WORKER_EVIDENCE: evidence,
      NODE_EXTRA_CA_CERTS: join(root, 'tls.crt'),
    },
    execArgv: ['--experimental-transform-types'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const [code] = await once(child, 'exit');
  process.exit(code ?? 1);
}
const root = realpathSync(process.env.STIM_HOSTED_XCODE_ROOT);
assert(root.startsWith(realpathSync(tmpdir()) + '/stim-native-gradle-worker-'));
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
  GRADLE_USER_HOME: join(root, 'fixture-gradle-home'),
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
const { readClaimSet, processGroupAlive } = await import('../../../packages/core/ownership-claim.ts');
const { workspaceName } = await import('../../../packages/core/index.ts');
const { captureProcessIdentity, inspectProcessIdentity, sameProcessRecord } =
  await import('../../../packages/core/process-identity.ts');
const { nativeGradleTransfer } = await import('../../../packages/stim-cli/src/integrations/native-gradle-inputs.ts');
let host;
let hostExit;
let machine;
let credential;
let worktree = false;
let workerArea;
const daemons = new Map();
let expectedStarts = 0;
const secrets = new Set();
const summary = {
  source: process.env.GITHUB_SHA,
  transport: 'synthetic Tailnet identity over verified loopback TLS',
  runs: [],
  cancelled: null,
  compileFailure: null,
  debugLogs: [],
  diagnostics: [],
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
  let failure;
  try {
    output = await exec(file, args, {
      cwd: options.cwd ?? app,
      env: options.env ?? env,
      timeout: options.timeout ?? 60_000,
      killSignal: 'SIGINT',
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    failure = error;
    output = { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
  try {
    writeFileSync(`${prefix}.stdout`, redact(output.stdout));
    writeFileSync(`${prefix}.stderr`, redact(output.stderr));
  } catch (error) {
    console.error(redact(`Command evidence failed: ${error.message}`));
    failure ??= error;
  }
  if (failure) throw failure;
  return output.stdout;
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
    assert(connection.supports('native-gradle-build'));
    while (Date.now() < deadline) {
      const reply = await connection.request(
        'build.offer',
        {
          repo: 'native-gradle-worker-capacity',
          native: 'gradle',
        },
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
const declaration = {
  complete: true,
  ignored: ['mobile/src/main/assets/generated.txt'],
  outputs: ['build', 'mobile/build'],
};
function buildTool(name) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  assert(sdk, 'The CI runner must supply an Android SDK.');
  const file = join(sdk, 'build-tools', '36.0.0', name);
  assert(existsSync(file), `Pinned Android build tool is missing: ${file}`);
  return file;
}
async function captureDaemons() {
  const privateHome = join(hostHome, 'build-worker', credential.deviceId, 'cache/gradle');
  const directory = join(privateHome, 'daemon');
  const candidates = [];
  for (const version of existsSync(directory) ? readdirSync(directory) : []) {
    const path = join(directory, version);
    if (!statSync(path).isDirectory()) continue;
    for (const name of readdirSync(path)) {
      const match = /^daemon-(\d+)\.out\.log$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      const identity = captureProcessIdentity(pid);
      if (identity.ok) candidates.push({ pid, processToken: identity.token });
    }
  }
  if (!candidates.length) return [];
  const processes = await run(
    'private-gradle-processes',
    '/bin/ps',
    ['-ww', '-p', candidates.map((record) => record.pid).join(','), '-o', 'pid=,command='],
    { cwd: root, timeout: 5000 },
  );
  const current = candidates.filter((record) =>
    processes.split('\n').some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return (
        match &&
        Number(match[1]) === record.pid &&
        match[2].includes(privateHome + '/') &&
        match[2].includes('org.gradle.launcher.daemon.bootstrap.GradleDaemon') &&
        inspectProcessIdentity(record) === 'same'
      );
    }),
  );
  for (const record of current) daemons.set(`${record.pid}:${record.processToken}`, record);
  return current;
}
const cancellationProbe = `abstract class WorkerCancellationProbe extends DefaultTask {
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
def probe = tasks.register('workerCancellationProbe', WorkerCancellationProbe) {
  started = layout.buildDirectory.file('cancel-started')
  completed = layout.buildDirectory.file('cancel-completed')
}
tasks.matching { it.name == 'compileFreeDebugKotlin' }.configureEach { dependsOn(probe) }
`;
async function failedBuild() {
  await waitForWorkerCapacity('compile-failure');
  const output = [];
  const api = createStim({
    projectRoot: app,
    home,
    buildCache: join(root, 'client-cache-failure'),
    onProgress: (event) => output.push(event.message),
  });
  expectedStarts += 1;
  let failure;
  try {
    await api.build({
      platform: 'android',
      variant: 'freeDebug',
      abi: 'all',
      remoteBuild: machine,
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (error) {
    failure = error;
  }
  writeFileSync(join(evidence, 'compile-failure.log'), redact(output.join('')));
  assert.equal(failure?.code, 'STIM_OFFLOAD_REFUSED');
  assert.equal(workerState().lastBuild.status, 'failed');
  assert.equal(workerState().activeBuild, undefined);
  assert.equal(readWorkspaceState(app).activeBuild, undefined);
  claimsFree();
  const workerLog = readFileSync(
    join(workerArea, 'home', 'workspaces', workspaceName(join(workerArea, 'src')), 'logs/build-android.ndjson'),
    'utf8',
  );
  writeFileSync(join(evidence, 'compile-failure-worker.ndjson'), redact(workerLog));
  assert.match(workerLog, /MainActivity\.kt/);
  summary.compileFailure = { code: failure.code, message: failure.message };
}

async function build(label, revision, generated, deleted = false) {
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
    expectedStarts += 1;
    result = await api.build({
      platform: 'android',
      variant: 'freeDebug',
      abi: 'all',
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
      save(`${label}-worker-retention`, JSON.parse(readFileSync(join(directory, 'gradle-outputs.json'), 'utf8')));
      save(`${label}-transfer`, nativeGradleTransfer(app, declaration));
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
  assert.equal(result.platform, 'android');
  const facts = result.facts;
  assert.equal(facts.buildMachine, machine);
  assert.equal(facts.builtOn, machine);
  assert.equal(facts.cacheSkipped, true);
  assert.equal(facts.cacheHit, false);
  assert.equal(facts.androidPackage, 'org.example.stim.free.debug');
  assert.equal(facts.cacheKey, null);
  assert(parentClaim, 'A real server-owned claim must remain live while the worker reports progress.');
  assert.equal(parentClaim.owner.pid, host.pid);
  save(`${label}-parent-claim`, parentClaim);
  const state = workerState();
  save(`${label}-worker-state`, state);
  assert.equal(state.lastBuild.status, 'ok');
  assert.equal(state.lastBuild.cacheHit, false);
  assert.equal(state.lastBuild.cacheSkipped, true);
  assert.equal(state.lastBuild.cacheKey, null);
  assert.equal(state.activeBuild, undefined);
  assert.equal(state.supervisor, undefined);
  assert.equal(readWorkspaceState(app).supervisor, undefined);
  await run(`${label}-signature`, buildTool('apksigner'), ['verify', '--print-certs', facts.apkPath]);
  const metadata = await run(`${label}-package`, buildTool('aapt2'), ['dump', 'badging', facts.apkPath]);
  assert.match(metadata, /package: name='org\.example\.stim\.free\.debug'/);
  const marker = await run(`${label}-ignored-asset`, '/usr/bin/unzip', ['-p', facts.apkPath, 'assets/generated.txt']);
  assert.equal(marker, generated);
  const dexDir = join(root, label);
  await run(`${label}-dex`, '/usr/bin/unzip', ['-o', facts.apkPath, 'classes*.dex', '-d', dexDir]);
  const dexFiles = readdirSync(dexDir)
    .filter((name) => /^classes(?:\d+)?\.dex$/.test(name))
    .toSorted();
  assert(dexFiles.length > 0);
  const strings = (
    await Promise.all(
      dexFiles.map((name) => run(`${label}-${name}-strings`, '/usr/bin/strings', ['-a', join(dexDir, name)])),
    )
  ).join('\n');
  assert(strings.includes(revision), 'Returned APK must contain the current source revision.');
  assert.equal(strings.includes('native-deletable-marker'), !deleted);
  const binary = createHash('sha256');
  for (const file of dexFiles) binary.update(readFileSync(join(dexDir, file)));
  const binaryHash = binary.digest('hex');
  const workerLog = readFileSync(
    join(workerArea, 'home', 'workspaces', workspaceName(join(workerArea, 'src')), 'logs', 'build-android.ndjson'),
    'utf8',
  );
  writeFileSync(join(evidence, `${label}-worker-build.ndjson`), redact(workerLog));
  assert(!existsSync(join(workerArea, 'src', 'secret.txt')));
  if (label === 'worker-warm') {
    assert.match(workerLog, /Reusing configuration cache|Configuration cache entry reused/);
    const messages = workerLog
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).msg);
    assert(
      messages.some(
        (message) =>
          typeof message === 'string' &&
          /(?:^|\s):mobile:compileFreeDebugKotlin\s+(?:UP-TO-DATE|FROM-CACHE)(?:\s|$)/.test(message),
      ),
      'Warm build must reuse the actual Kotlin compile task output.',
    );
  }
  const daemonRecords = await captureDaemons();
  assert(daemonRecords.length > 0, 'A warm Gradle daemon must be observable in the private client home.');
  save(`${label}-daemon-identities`, daemonRecords);
  if (label === 'worker-warm')
    assert(
      daemonRecords.some((record) => sameProcessRecord(record, summary.runs[0].daemon)),
      'Warm build did not reuse the observed Gradle daemon.',
    );
  claimsFree();
  const requests = readFileSync(join(evidence, 'host-requests.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(!requests.some((event) => event.method.startsWith('device-host.')));
  assert.equal(requests.filter((event) => event.method === 'build.start').length, expectedStarts);
  summary.runs.push({
    label,
    cacheKey: facts.cacheKey,
    binaryHash,
    transferDigest: nativeGradleTransfer(app, declaration).digest,
    daemon: daemonRecords[0],
  });
  return facts;
}
async function cancelBuild() {
  await waitForWorkerCapacity('cancel');
  const output = [];
  const api = createStim({
    projectRoot: app,
    home,
    buildCache: join(root, 'client-cache-cancel'),
    onProgress: (event) => output.push(event.message),
  });
  const clientLock = join(home, 'workspaces', workspaceName(app), 'native-run.lock');
  const workerLock = join(workerArea, 'home', 'workspaces', workspaceName(join(workerArea, 'src')), 'native-run.lock');
  let settled = false;
  expectedStarts += 1;
  const outcome = api
    .build({
      platform: 'android',
      variant: 'freeDebug',
      abi: 'all',
      remoteBuild: machine,
      signal: AbortSignal.timeout(20 * 60_000),
    })
    .then(
      (result) => {
        settled = true;
        return { result };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
  let failure;
  try {
    const deadline = Date.now() + 120_000;
    let parent;
    let compiler;
    let task;
    const marker = join(workerArea, 'src/mobile/build/cancel-started');
    while (Date.now() < deadline) {
      if (settled) break;
      parent = readClaimSet(`${workerArea}.claims`).live.find((holder) => holder.child?.pid > 0);
      compiler = readClaimSet(workerLock).live.find(
        (holder) => holder.child?.pid > 0 && sameProcessRecord(holder.owner, parent?.child),
      );
      if (compiler && existsSync(marker)) {
        const pid = Number(readFileSync(marker, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          const identity = captureProcessIdentity(pid);
          if (identity.ok) {
            task = { pid, processToken: identity.token };
            break;
          }
        }
      }
      await sleep(50);
    }
    assert(compiler && parent && task, 'Cancellation must observe the live Gradle invocation and running task JVM.');
    assert.equal(parent.owner.pid, host.pid);
    assert.equal(inspectProcessIdentity(parent.child), 'same');
    assert.equal(inspectProcessIdentity(compiler.child), 'same');
    const observed = await run(
      'cancel-compiler',
      '/bin/ps',
      ['-p', String(compiler.child.pid), '-o', 'ppid=,pgid=,comm='],
      { timeout: 5000 },
    );
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(observed);
    assert(match, 'The exact claimed compiler must still be inspectable.');
    assert.equal(Number(match[1]), parent.child.pid);
    assert.equal(Number(match[2]), parent.child.pid);
    assert.match(basename(match[3]), /^(?:java|gradlew|sh)$/);
    assert.equal(inspectProcessIdentity(task), 'same');
    const client = readClaimSet(clientLock).live[0];
    assert(client);
    save('cancel-identities', { parent, compiler, task, client, process: observed });
    const stopped = await api.stop({ signal: AbortSignal.timeout(30_000) });
    save('cancel-stop', stopped);
    assert.equal(stopped.ok, true);
    const result = await Promise.race([
      outcome,
      sleep(30_000, undefined, { ref: false }).then(() => {
        throw new Error('Cancelled build did not settle.');
      }),
    ]);
    assert.equal(result.error?.code, 'STIM_CANCELLED');
    const records = [client.owner, parent.child, compiler.child, task];
    const gone = (record) => ['gone', 'different'].includes(inspectProcessIdentity(record));
    const settlementDeadline = Date.now() + 30_000;
    while (
      Date.now() < settlementDeadline &&
      (!records.every(gone) || processGroupAlive(parent.child.pid) || readClaimSet(`${workerArea}.claims`).live.length)
    )
      await sleep(100);
    assert(records.every(gone), 'Every exact observed run/compiler identity must be gone.');
    assert.equal(processGroupAlive(parent.child.pid), false);
    assert.deepEqual(readClaimSet(`${workerArea}.claims`), {
      live: [],
      dead: [],
      unresolved: [],
      orphans: [],
    });
    const paths = [clientLock, workerLock];
    for (const directory of [join(hostHome, 'build-slots'), join(workerArea, 'home', 'build-slots')])
      for (const entry of existsSync(directory) ? readdirSync(directory) : []) paths.push(join(directory, entry));
    const claims = paths.map((path) => Object.assign({ path }, readClaimSet(path)));
    save('cancel-settlement', {
      records: records.map((record) => ({
        pid: record.pid,
        processToken: record.processToken,
        status: inspectProcessIdentity(record),
      })),
      claims,
    });
    for (const claim of claims) {
      assert.deepEqual(claim.live, []);
      assert.deepEqual(claim.unresolved, []);
      assert.deepEqual(claim.orphans, []);
      for (const holder of claim.dead) assert(gone(holder.owner));
      if (claim.path === clientLock || claim.path.startsWith(join(hostHome, 'build-slots')))
        assert.deepEqual(claim.dead, []);
    }
    assert.equal(readWorkspaceState(app).lastBuild.errorCode, 'STIM_CANCELLED');
    assert.equal(readWorkspaceState(app).activeBuild, undefined);
    assert(!existsSync(join(workerArea, 'src/mobile/build/cancel-completed')));
    summary.cancelled = {
      code: result.error.code,
      workerPid: parent.child.pid,
      compilerPid: compiler.child.pid,
      taskPid: task.pid,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      writeFileSync(join(evidence, 'cancel.log'), redact(output.join('')));
    } catch (error) {
      console.error(redact(`Cancellation evidence failed: ${error.message}`));
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

try {
  writeFileSync(
    join(root, 'bin', 'tailscale'),
    `#!/usr/bin/env node\nconst [command, , ip] = process.argv.slice(2);\nif (command === 'status') console.log(JSON.stringify({BackendState:'Running', Self:{ID:'ci-client',HostName:'CI client',DNSName:'ci-client.invalid.'}, Peer:{host:{ID:'ci-host',DNSName:'localhost.',TailscaleIPs:['127.0.0.1']}}}));\nelse if (command === 'whois' && ip === '100.64.0.11') console.log(JSON.stringify({Node:{ID:11,StableID:'ci-client',Name:'ci-client.invalid.'},UserProfile:{LoginName:'ci@example.invalid'}}));\nelse process.exit(1);\n`,
    { mode: 0o700 },
  );
  await run(
    'prepare-fixture',
    process.execPath,
    [fileURLToPath(new URL('./run-gradle-e2e.mjs', import.meta.url)), 'prepare', join(root, 'fixture')],
    {
      cwd: source,
      timeout: 10 * 60_000,
      env: { ...env, GRADLE_OPTS: `${env.GRADLE_OPTS ?? ''} -Dorg.gradle.daemon=false` },
    },
  );
  cpSync(join(root, 'fixture/project'), source, { recursive: true });
  cpSync(join(root, 'fixture/evidence/pins.json'), join(evidence, 'pins.json'));
  writeFileSync(
    join(source, '.gitignore'),
    '.gradle/\n.kotlin/\n**/build/\nmobile/src/main/assets/generated.txt\nsecret.txt\nlocal.properties\n',
  );
  writeFileSync(
    join(source, '.stim.json'),
    JSON.stringify({
      android: { offloadInputs: declaration },
      optimizations: { android: { compilerCache: 'none', gradleBuildCache: true } },
    }) + '\n',
  );
  const properties = join(source, 'gradle.properties');
  writeFileSync(
    properties,
    readFileSync(properties, 'utf8').replace('org.gradle.daemon=false', 'org.gradle.daemon=true'),
  );
  writeFileSync(
    join(source, 'mobile/src/main/java/org/example/stim/Deletable.kt'),
    'package org.example.stim\nclass Deletable { fun marker() = "native-deletable-marker" }\n',
  );
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
  mkdirSync(join(app, 'mobile/src/main/assets'), { recursive: true });
  writeFileSync(join(app, 'mobile/src/main/assets/generated.txt'), 'ignored-one');
  writeFileSync(join(app, 'secret.txt'), 'must not transfer');
  for (const setupEnv of [env, hostEnv])
    for (const key of ['iosSimulatorApp', 'androidEmulatorApp'])
      await run('viewer-setting', process.execPath, [cli, 'settings', 'set', key, 'stim-desktop'], {
        env: setupEnv,
      });
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
  const cold = await build('cold', 'Native QA initial', 'ignored-one');
  const warm = await build('worker-warm', 'Native QA initial', 'ignored-one');
  assert.equal(warm.cacheKey, cold.cacheKey);
  assert.equal(summary.runs[1].binaryHash, summary.runs[0].binaryHash);
  assert.equal(summary.runs[1].transferDigest, summary.runs[0].transferDigest);
  const kotlin = join(app, 'mobile/src/main/java/org/example/stim/MainActivity.kt');
  writeFileSync(kotlin, readFileSync(kotlin, 'utf8').replaceAll('Native QA initial', 'Native QA edited'));
  await build('source-edit', 'Native QA edited', 'ignored-one');
  assert.notEqual(summary.runs[2].binaryHash, summary.runs[0].binaryHash);
  assert.notEqual(summary.runs[2].transferDigest, summary.runs[0].transferDigest);
  writeFileSync(join(app, 'mobile/src/main/assets/generated.txt'), 'ignored-two');
  await build('ignored-edit', 'Native QA edited', 'ignored-two');
  assert.notEqual(summary.runs[3].transferDigest, summary.runs[2].transferDigest);
  rmSync(join(app, 'mobile/src/main/java/org/example/stim/Deletable.kt'));
  await build('source-deletion', 'Native QA edited', 'ignored-two', true);
  assert(!existsSync(join(workerArea, 'src/mobile/src/main/java/org/example/stim/Deletable.kt')));
  const validSource = readFileSync(kotlin, 'utf8');
  writeFileSync(kotlin, validSource + '\nthis is deliberately invalid Kotlin\n');
  await failedBuild();
  writeFileSync(kotlin, validSource);
  const gradleFile = join(app, 'mobile/build.gradle.kts');
  const originalGradle = readFileSync(gradleFile, 'utf8');
  writeFileSync(join(app, 'cancel-qa.gradle'), cancellationProbe);
  writeFileSync(gradleFile, originalGradle + '\napply(from = "../cancel-qa.gradle")\n');
  await cancelBuild();
  writeFileSync(gradleFile, originalGradle);
  rmSync(join(app, 'cancel-qa.gradle'));
  await build('cancel-recovery', 'Native QA edited', 'ignored-two', true);
  const workerLock = join(workerArea, 'home', 'workspaces', workspaceName(join(workerArea, 'src')), 'native-run.lock');
  assert.deepEqual(readClaimSet(workerLock), { live: [], dead: [], unresolved: [], orphans: [] });
} catch (error) {
  summary.failure = redact(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  const failures = [];
  try {
    if (worktree) {
      const stopped = JSON.parse(await run('stop', process.execPath, [cli, 'stop', '--json']));
      assert.equal(stopped.ok, true);
      await run('remove', process.execPath, [cli, 'worktree', 'remove', '--force', app], {
        cwd: source,
      });
      assert(!existsSync(app));
    }
  } catch (error) {
    failures.push(error.message);
  }
  try {
    if (workerArea && credential) {
      await captureDaemons();
      const wrapper = join(workerArea, 'src/gradlew');
      if (existsSync(wrapper))
        await run('stop-private-gradle', wrapper, ['--stop'], {
          cwd: join(workerArea, 'src'),
          env: {
            ...hostEnv,
            GRADLE_USER_HOME: join(hostHome, 'build-worker', credential.deviceId, 'cache/gradle'),
          },
        });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && [...daemons.values()].some((record) => inspectProcessIdentity(record) === 'same'))
        await sleep(100);
      const settled = [...daemons.values()].map((record) =>
        Object.assign({}, record, { status: inspectProcessIdentity(record) }),
      );
      save('gradle-daemon-settlement', settled);
      assert(
        settled.every((record) => ['gone', 'different'].includes(record.status)),
        'Private Gradle daemon settlement is unproven.',
      );
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
  for (const [label, directory] of [
    ['client', home],
    ['host', hostHome],
  ]) {
    try {
      const logs = join(directory, 'logs', 'debug');
      assert(existsSync(join(logs, 'cli.ndjson')), `${label} CLI debug log is missing.`);
      for (const name of ['cli.ndjson', 'cli.ndjson.1', 'server.ndjson', 'server.ndjson.1']) {
        const file = join(logs, name);
        if (!existsSync(file)) continue;
        assert(statSync(file).size <= 10 * 1024 * 1024, `${label}/${name} exceeds the evidence limit.`);
        const destination = `${label}-${name}`;
        writeFileSync(join(evidence, destination), redact(readFileSync(file, 'utf8')));
        summary.debugLogs.push(destination);
      }
    } catch (error) {
      summary.diagnostics.push(`${label} debug evidence: ${error.message}`);
    }
  }
  summary.cleanup = { ok: failures.length === 0, failures };
  let recorded = false;
  try {
    save('summary', summary);
    recorded = true;
  } catch (error) {
    console.error(redact(`Summary evidence failed: ${error.message}`));
  }
  if (failures.length || summary.diagnostics.length || !recorded) {
    process.exitCode = 1;
    console.error(`Retained task state at ${root}: ${[...failures, ...summary.diagnostics].join('; ')}`);
  } else {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      process.exitCode = 1;
      console.error(redact(`Task directory cleanup failed: ${error.message}`));
    }
  }
}
if (summary.failure) console.error(summary.failure);
