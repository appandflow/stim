import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRunnerHome, spawnStamped } from './runner.mjs';
import { benchmarkEnvironment, isolatedShellEnvironment } from './shell-environment.mjs';
import { isolatedRunnerInvocation, prepareRunnerIsolation, runnerIsolationPolicy } from './runner-isolation.mjs';
import { reconstructCommandEvidence } from './command-evidence.mjs';
import { verifyNativeCompatibilityTools, probeNativeCompatibility } from './native-compat.mjs';
import { nativeSourceProof, nativeTaskPrompt } from './native-task.mjs';

if (!process.env.STIM_BENCH_ROOT) throw new Error('STIM_BENCH_ROOT is required');
const root = resolve(process.env.STIM_BENCH_ROOT);
const [command, platform, arm, model] = process.argv.slice(2);
if (!['ios', 'android', 'macos'].includes(platform)) throw new Error('Expected ios, android or macos');
const directory = join(root, 'native', platform);
const fixture = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
const stimPackage = process.env.STIM_BENCH_STIM_PACKAGE;
const stimCli = join(stimPackage, 'dist', 'cli.mjs');
const pins = Object.fromEntries(
  readFileSync(join(root, 'pins.env'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const env = benchmarkEnvironment(process.env);
if (platform === 'android') {
  env.ANDROID_USER_HOME = join(directory, 'android');
  env.ANDROID_AVD_HOME = join(directory, 'android');
  env.ANDROID_EMULATOR_HOME = join(directory, 'android');
  env.GRADLE_USER_HOME = join(directory, 'golden-gradle');
  env.ANDROID_ADB_SERVER_PORT = '5051';
  env.ADB_SERVER_SOCKET = 'tcp:127.0.0.1:5051';
  env.ADB_VENDOR_KEYS = join(directory, 'android', 'adbkey');
  env.ADB_MDNS_AUTO_CONNECT = '';
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const coordinatorHashes = () =>
  Object.fromEntries(
    [
      'native-driver.mjs',
      'native-task.mjs',
      'runner.mjs',
      'stamp.mjs',
      'shell-environment.mjs',
      'runner-isolation.mjs',
      'native-compat.mjs',
      'command-evidence.mjs',
    ].map((name) => [name, sha256(fileURLToPath(new URL(name, import.meta.url)))]),
  );
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    cwd: fixture.fixtureDirectory,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })?.trim() ?? '';
const git = (...args) => run('git', args);

function provenance() {
  const xcode = run('xcodebuild', ['-version']).split('\n');
  const actual = {
    nodeVersion: process.version.slice(1),
    macosVersion: run('sw_vers', ['-productVersion']),
    macosBuild: run('sw_vers', ['-buildVersion']),
    xcodeVersion: xcode[0].replace(/^Xcode /, ''),
    xcodeBuild: xcode[1].replace(/^Build version /, ''),
    fixtureCommit: git('rev-parse', 'HEAD'),
    stimVersion: JSON.parse(readFileSync(join(stimPackage, 'package.json'), 'utf8')).version,
    stimCliSha256: sha256(stimCli),
    codexVersion: run(process.env.STIM_BENCH_CODEX_BIN, ['--version']).replace(/^codex-cli /, ''),
  };
  if (actual.fixtureCommit !== fixture.fixtureCommit || git('status', '--short'))
    throw new Error('Native fixture changed');
  for (const [field, pin] of Object.entries({
    nodeVersion: 'NODE_VERSION',
    macosVersion: 'MACOS_VERSION',
    macosBuild: 'MACOS_BUILD',
    xcodeVersion: 'XCODE_VERSION',
    xcodeBuild: 'XCODE_BUILD',
    stimVersion: 'STIM_VERSION',
    codexVersion: 'CODEX_VERSION',
  })) {
    if (actual[field] !== pins[pin]) throw new Error(`Native benchmark pin changed: ${pin}`);
  }
  return actual;
}

async function loadGate() {
  const samples = [];
  let consecutive = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const load = Number(run('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).match(/[\d.]+/)[0]);
    samples.push({ at: new Date().toISOString(), load });
    consecutive = load <= 3 ? consecutive + 1 : 0;
    if (consecutive === 2) return samples;
    await new Promise((done) => setTimeout(done, 15_000));
  }
  throw new Error('Native benchmark load gate failed');
}

function prepare() {
  const before = provenance();
  const readyPath = join(directory, 'READY.json');
  if (existsSync(readyPath)) throw new Error('Native golden already prepared; retain its provenance');
  const home = join(directory, 'golden-stim-home');
  const seed = join(directory, 'seed');
  if (existsSync(home) || existsSync(seed))
    throw new Error('Partial native preparation exists; inspect before retrying');
  mkdirSync(home, { recursive: true });
  if (platform === 'android') {
    mkdirSync(env.ANDROID_AVD_HOME, { recursive: true });
    mkdirSync(env.GRADLE_USER_HOME, { recursive: true });
  }
  save(join(home, 'config.json'), {
    version: 2,
    projects: {},
    repos: {},
    pool: { iosParkedMax: 1, androidParkedMax: 1 },
  });
  const seedEnv = { ...env, STIM_HOME: home, STIM_POOL_IOS_PARKED_MAX: '1', STIM_POOL_ANDROID_PARKED_MAX: '1' };
  git('worktree', 'add', '--detach', seed, 'HEAD');
  const invoke = (args) =>
    run(process.execPath, [stimCli, ...args], { cwd: seed, env: seedEnv, timeout: 20 * 60_000, stdio: 'inherit' });
  invoke(['worktree', 'warm']);
  const selector =
    platform === 'ios'
      ? ['--device-type', pins.IOS_DEVICE_TYPE, '--runtime', pins.IOS_RUNTIME]
      : platform === 'android'
        ? ['--system-image', pins.ANDROID_SYSTEM_IMAGE]
        : [];
  const output = run(process.execPath, [stimCli, platform, ...selector, '--json'], {
    cwd: seed,
    env: seedEnv,
    timeout: 20 * 60_000,
  });
  const launch = JSON.parse(output);
  save(join(directory, 'seed-launch.json'), launch);
  invoke(['stop']);
  invoke(['worktree', 'remove', '--force']);
  const controlArgs =
    platform === 'ios'
      ? [
          '-project',
          'NativeAcceptance.xcodeproj',
          '-scheme',
          'NativeAcceptance',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          '.build-control',
          'CODE_SIGNING_ALLOWED=NO',
          'build',
        ]
      : platform === 'android'
        ? [':mobile:assembleDebug', '--console=plain']
        : ['build', '--disable-sandbox', '--product', fixture.product, '--configuration', 'debug'];
  run(platform === 'ios' ? 'xcodebuild' : platform === 'android' ? './gradlew' : 'swift', controlArgs, {
    timeout: 20 * 60_000,
    stdio: 'inherit',
  });
  const ready = {
    ...before,
    platform,
    framework: fixture.framework,
    preparedAt: new Date().toISOString(),
    launch,
    sourceSha256: sha256(join(fixture.fixtureDirectory, fixture.source)),
  };
  save(readyPath, ready);
  process.stdout.write(JSON.stringify(ready, null, 2) + '\n');
}

async function dispatch() {
  if (!['stim', 'control'].includes(arm) || !model) throw new Error('dispatch <platform> <stim|control> <model>');
  const actual = provenance();
  const ready = JSON.parse(readFileSync(join(directory, 'READY.json'), 'utf8'));
  for (const key of Object.keys(actual))
    if (actual[key] !== ready[key]) throw new Error(`Native golden pin mismatch: ${key}`);
  if (ready.sourceSha256 !== sha256(join(fixture.fixtureDirectory, fixture.source)))
    throw new Error('Prepared native source changed');
  const compatibility = verifyNativeCompatibilityTools(
    process.env.STIM_BENCH_NATIVE_COMPAT_MANIFEST,
    pins.NATIVE_COMPAT_SHA256,
    process.env.STIM_BENCH_AGENT_DEVICE_BIN,
  );
  const toolBin = join(directory, `tools-${coordinatorHashes()['native-driver.mjs'].slice(0, 12)}`);
  mkdirSync(toolBin, { recursive: true });
  const swiftWrapper = join(toolBin, 'swift');
  const swiftScript =
    '#!/bin/sh\nif [ "$1" = build ]; then shift; exec /usr/bin/swift build --disable-sandbox -Xswiftc -disable-sandbox "$@"; fi\nexec /usr/bin/swift "$@"\n';
  writeFileSync(swiftWrapper, swiftScript, { mode: 0o755 });
  if (platform === 'android' && compatibility.emulatorProcess && !existsSync(join(toolBin, 'ps')))
    symlinkSync(join(compatibility.directory, 'emulator-process', 'ps'), join(toolBin, 'ps'));
  const macosProcessSource = fileURLToPath(new URL('./compat/macos-processes.c', import.meta.url));
  if (platform === 'macos') {
    const adapterManifest = join(toolBin, 'process-adapter.json');
    if (!existsSync(join(toolBin, 'ps'))) {
      run('/usr/bin/clang', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        macosProcessSource,
        '-o',
        join(toolBin, 'ps'),
      ]);
      save(adapterManifest, { sourceSha256: sha256(macosProcessSource), binarySha256: sha256(join(toolBin, 'ps')) });
    }
    const expectedAdapter = JSON.parse(readFileSync(adapterManifest, 'utf8'));
    if (
      expectedAdapter.sourceSha256 !== sha256(macosProcessSource) ||
      expectedAdapter.binarySha256 !== sha256(join(toolBin, 'ps'))
    )
      throw new Error('Native macOS process adapter changed');
  }
  const samples = await loadGate();
  const runId = `native-${platform}-${arm}-${Date.now()}`;
  const runDir = join(directory, 'results', runId);
  const worktree = join(directory, 'worktrees', runId);
  const proofDirectory = join(runDir, 'proof');
  const stateDirectory = join(runDir, 'agent-device');
  for (const path of [proofDirectory, stateDirectory, join(runDir, 'tmp'), join(directory, 'worktrees')])
    mkdirSync(path, { recursive: true });
  const { codexHome } = makeRunnerHome({
    runDir,
    arm,
    codexAuthPath: process.env.STIM_BENCH_CODEX_AUTH,
    agentSkillsRoot: process.env.STIM_BENCH_SKILLS_ROOT,
    stimPackage,
  });
  const runnerEnv = isolatedShellEnvironment(
    {
      ...env,
      CODEX_HOME: codexHome,
      STIM_HOME: join(runDir, 'stim-home'),
      TMPDIR: join(runDir, 'tmp'),
      AGENT_DEVICE_STATE_DIR: stateDirectory,
      AGENT_DEVICE_CLAIMS_DIR: join(stateDirectory, 'claims'),
      AGENT_DEVICE_SESSION: runId,
      AGENT_DEVICE_MACOS_APP_BACKEND: 'native',
      ...(platform === 'android' ? { GRADLE_USER_HOME: join(runDir, 'gradle') } : {}),
      PATH: `${arm === 'stim' ? join(root, 'bin') + ':' : ''}${toolBin}:${join(root, 'allowed-bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    runDir,
  );
  mkdirSync(runnerEnv.STIM_HOME, { recursive: true });
  if (platform === 'android') run('cp', ['-cR', env.GRADLE_USER_HOME, runnerEnv.GRADLE_USER_HOME]);
  const devicesBefore =
    platform === 'ios'
      ? JSON.parse(run('xcrun', ['simctl', 'list', 'devices', '--json']))
      : platform === 'android'
        ? { avds: run('emulator', ['-list-avds']), transports: run('adb', ['devices', '-l']) }
        : run('ps', ['-axo', 'pid=,lstart=,command=']);
  save(join(runDir, 'devices-before.json'), devicesBefore);
  if (arm === 'stim') run('cp', ['-cR', join(directory, 'golden-stim-home') + '/.', runnerEnv.STIM_HOME]);
  const resolved = run('/bin/zsh', ['-lc', 'command -v stim || true'], { env: runnerEnv });
  if (arm === 'control' && resolved) throw new Error('Control resolved Stim');
  if (arm === 'stim' && resolved !== join(root, 'bin', 'stim')) throw new Error('Stim shim mismatch');
  const isolation = prepareRunnerIsolation({
    policy: runnerIsolationPolicy({
      protectedRoots: [root],
      reservedRoots: [join(directory, 'results'), join(directory, 'worktrees'), join(directory, 'golden-stim-home')],
      readPaths: [
        fixture.fixtureDirectory,
        toolBin,
        join(root, 'allowed-bin'),
        dirname(process.env.STIM_BENCH_NATIVE_COMPAT_MANIFEST),
        ...(arm === 'stim' ? [join(root, 'bin'), join(root, 'runtime')] : []),
      ],
      writePaths: [join(fixture.fixtureDirectory, '.git'), runnerEnv.ANDROID_AVD_HOME].filter(Boolean),
      scopedAccess: {
        writePaths: [
          worktree,
          join(runDir, 'runner-home'),
          join(runDir, 'shell-home'),
          proofDirectory,
          stateDirectory,
          runnerEnv.STIM_HOME,
          runnerEnv.TMPDIR,
          ...(platform === 'android' ? [runnerEnv.GRADLE_USER_HOME] : []),
        ],
      },
    }),
    profilePath: join(runDir, 'isolation.sb'),
    probeRoots: [root, join(directory, 'results'), join(directory, 'golden-stim-home')],
    probeParent: runnerEnv.TMPDIR,
    execute: (file, args) => run(file, args, { env: runnerEnv }),
  });
  if (platform === 'macos') {
    const processProbe = isolatedRunnerInvocation(isolation, join(toolBin, 'ps'), ['-axww', '-o', 'pid=,comm=']);
    if (
      !run(processProbe.command, processProbe.args, { env: runnerEnv })
        .split('\n')
        .some((line) => line.startsWith(`${process.pid} `))
    )
      throw new Error('Native macOS process adapter cannot see coordinator');
  }
  const compatibilityProbe = probeNativeCompatibility(compatibility, (file, args) => {
    const call = isolatedRunnerInvocation(isolation, file, args);
    return run(call.command, call.args, { env: runnerEnv });
  });
  const profileInvocation = isolatedRunnerInvocation(isolation, process.env.STIM_BENCH_CODEX_BIN, [
    'debug',
    'prompt-input',
    'native benchmark profile',
  ]);
  const profile = JSON.parse(run(profileInvocation.command, profileInvocation.args, { env: runnerEnv }));
  save(join(runDir, 'prompt-input.json'), profile);
  const skillText =
    profile
      .flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .find((text) => text.includes('<skills_instructions>')) ?? '';
  const skills = [...skillText.matchAll(/^- ([a-zA-Z0-9:_-]+):/gm)].map((match) => match[1]).toSorted();
  if (JSON.stringify(skills) !== JSON.stringify(arm === 'stim' ? ['agent-device', 'stim'] : ['agent-device']))
    throw new Error('Native runner skill mismatch');
  const device =
    platform === 'ios'
      ? `${pins.IOS_DEVICE_TYPE}, iOS ${pins.IOS_RUNTIME}${arm === 'control' ? `; create a simulator named ${runId}` : '; use a Stim-owned simulator'}`
      : platform === 'android'
        ? `${pins.ANDROID_SYSTEM_IMAGE}${arm === 'control' ? `; create an AVD named ${runId}` : '; use a Stim-owned emulator'}`
        : 'this Mac; use an app bundle owned by this worktree, without stopping unrelated apps';
  const marker = `revision-${runId}`;
  const prompt = nativeTaskPrompt({
    arm,
    platform,
    fixture: fixture.fixtureDirectory,
    worktree,
    branch: `bench/${runId}`,
    marker,
    device,
    proofDirectory,
    session: runId,
    stateDirectory,
  });
  writeFileSync(join(runDir, 'prompt.txt'), prompt);
  const meta = {
    schemaVersion: 1,
    cohort: 'standalone-native-v1',
    runId,
    platform,
    arm,
    model,
    reasoningEffort: 'high',
    serviceTier: 'priority',
    fixture,
    provenance: actual,
    compatibility,
    compatibilityProbe,
    toolBin,
    swiftWrapperSha256: sha256(swiftWrapper),
    coordinatorHashes: coordinatorHashes(),
    processAdapter:
      platform === 'macos'
        ? { sourceSha256: sha256(macosProcessSource), binarySha256: sha256(join(toolBin, 'ps')) }
        : null,
    isolation,
    loadGate: samples,
    worktree,
    marker,
    stateDirectory,
    dispatchAt: new Date().toISOString(),
  };
  save(join(runDir, 'meta.json'), meta);
  const invocation = isolatedRunnerInvocation(isolation, process.env.STIM_BENCH_CODEX_BIN, [
    '--ask-for-approval',
    'never',
    'exec',
    '--strict-config',
    '--ignore-rules',
    '--json',
    '--model',
    model,
    '--sandbox',
    'danger-full-access',
    '--add-dir',
    runDir,
    '--cd',
    fixture.fixtureDirectory,
    '-',
  ]);
  meta.runnerResult = await spawnStamped(
    invocation.command,
    invocation.args,
    join(runDir, 'events.jsonl'),
    { cwd: fixture.fixtureDirectory, env: runnerEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    prompt,
    15 * 60_000,
  );
  meta.finishedAt = new Date().toISOString();
  save(join(runDir, 'meta.json'), meta);
  process.stdout.write(runDir + '\n');
}

function collect(runDir) {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const evidence = reconstructCommandEvidence('codex', events);
  save(join(runDir, 'commands.json'), evidence);
  const changedPaths = run('git', ['diff', '--name-only', 'HEAD'], { cwd: meta.worktree }).split('\n').filter(Boolean);
  const source = nativeSourceProof({
    before: readFileSync(join(meta.fixture.fixtureDirectory, meta.fixture.source), 'utf8'),
    after: readFileSync(join(meta.worktree, meta.fixture.source), 'utf8'),
    marker: meta.marker,
    changedPaths,
    source: meta.fixture.source,
  });
  const usage =
    events
      .map((record) => {
        try {
          return JSON.parse(record.line);
        } catch {
          return null;
        }
      })
      .findLast((event) => event?.type === 'turn.completed')?.usage ?? null;
  const invalidReasons = [];
  if (!source) invalidReasons.push('source-change-mismatch');
  if (meta.runnerResult?.code !== 0 || meta.runnerResult?.signal || meta.runnerResult?.timedOut)
    invalidReasons.push('runner-failed-or-timed-out');
  if (!usage) invalidReasons.push('missing-completed-turn');
  if (!existsSync(join(runDir, 'proof', 'screen.png'))) invalidReasons.push('missing-screenshot');
  if (!existsSync(join(runDir, 'proof', 'snapshot.txt'))) invalidReasons.push('missing-snapshot');
  if (!existsSync(join(runDir, 'proof', 'target.json'))) invalidReasons.push('missing-target');
  if (JSON.stringify(meta.coordinatorHashes) !== JSON.stringify(coordinatorHashes()))
    invalidReasons.push('coordinator-changed');
  if (
    meta.processAdapter &&
    (meta.processAdapter.sourceSha256 !==
      sha256(fileURLToPath(new URL('./compat/macos-processes.c', import.meta.url))) ||
      meta.processAdapter.binarySha256 !== sha256(join(meta.toolBin, 'ps')))
  )
    invalidReasons.push('process-adapter-changed');
  if (meta.swiftWrapperSha256 !== sha256(join(meta.toolBin, 'swift'))) invalidReasons.push('swift-wrapper-changed');
  try {
    verifyNativeCompatibilityTools(
      process.env.STIM_BENCH_NATIVE_COMPAT_MANIFEST,
      pins.NATIVE_COMPAT_SHA256,
      process.env.STIM_BENCH_AGENT_DEVICE_BIN,
    );
  } catch {
    invalidReasons.push('compatibility-tools-changed');
  }
  const result = {
    schemaVersion: 1,
    cohort: meta.cohort,
    runId: meta.runId,
    platform: meta.platform,
    arm: meta.arm,
    elapsedSeconds: (Date.parse(meta.finishedAt) - Date.parse(meta.dispatchAt)) / 1000,
    usage,
    source,
    runnerResult: meta.runnerResult,
    status: invalidReasons.length ? 'invalid' : 'pending-independent-ui-and-command-audit',
    invalidReasons,
    eventsSha256: sha256(join(runDir, 'events.jsonl')),
    screenshotSha256: existsSync(join(runDir, 'proof', 'screen.png'))
      ? sha256(join(runDir, 'proof', 'screen.png'))
      : null,
  };
  save(join(runDir, 'run.json'), result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (command === 'prepare') prepare();
else if (command === 'dispatch') await dispatch();
else if (command === 'collect') collect(resolve(arm));
else throw new Error('Expected prepare, dispatch or collect');
