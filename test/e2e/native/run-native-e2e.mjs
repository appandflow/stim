#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEvidenceMessage, noCompileEvidenceMessage } from './assertions.mjs';
import {
  FIXTURE_COMMANDS,
  assert,
  buildLog,
  cleanupTmp,
  createCleanupTracker,
  createFixture,
  createHarness,
  createWarmWorktree,
  dumpDiagnostics,
  lastLines,
  preflight,
  prepareIosDevices,
  quote,
  verifyCleanup,
  workspaceLogsDir,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CLI = join(REPO, 'packages', 'stim-cli', 'dist', 'cli.mjs');

const args = parseArgs(process.argv.slice(2));
const FRAMEWORK = args.framework;
const PLATFORM = args.platform;
const VARIANT = `${FRAMEWORK}-${PLATFORM}`;
const EXPECTED_MODE = FRAMEWORK === 'expo' ? 'expo-child' : 'bare-inproc';
const ARTIFACT_EXT = PLATFORM === 'ios' ? '.app' : '.apk';
const COMPILE_SIGNS =
  PLATFORM === 'ios' ? [/xcodebuild/i, /CompileC\b/i, /Ld /] : [/gradlew/i, /:app:compile/i, /Task :app:/i];

const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `stim-native-${VARIANT}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `stim-native-${VARIANT}-`));
const ENV = {
  ...process.env,
  STIM_HOME: HOME_DIR,
  CI: '1',
  STIM_POOL_IOS_PARKED_MAX: '0',
  STIM_POOL_ANDROID_PARKED_MAX: '0',
};
process.env.STIM_HOME = HOME_DIR;
const WARM_CACHE = process.env.STIM_E2E_WARM_CACHE === '1';

const h = createHarness({ env: ENV, cliPath: CLI, label: `native-e2e ${VARIANT}` });
const cleanup = createCleanupTracker({ h, platform: PLATFORM });
const { cli, cliJson, sh, log, banner, die } = h;

const created = [];

async function main() {
  preflight(h, PLATFORM);

  const appDir = args.appDir
    ? resolve(args.appDir)
    : createFixture({ framework: FRAMEWORK, platform: PLATFORM, workDir: WORK_DIR, h });
  if (args.fixtureOnly) {
    log(`fixture-only: app created at ${appDir}. Stopping before any build.`);
    return;
  }

  const wt1 = worktreeCreate('e2e-1', appDir);
  const wt2 = worktreeCreate('e2e-2', appDir);
  const flags = [];
  if (PLATFORM === 'ios') {
    const inventory = JSON.parse(sh('xcrun', ['simctl', 'list', '--json'], { timeout: 30000 }).stdout);
    const supported = new Set(
      inventory.runtimes
        .filter((runtime) => runtime.isAvailable && runtime.identifier.includes('.iOS-'))
        .flatMap((runtime) => runtime.supportedDeviceTypes.map((type) => type.identifier)),
    );
    const tablet = inventory.devicetypes.find(
      (type) => type.name.startsWith('iPad Pro') && supported.has(type.identifier),
    );
    assert(tablet, 'native slot QA requires an iPad device type supported by an available iOS runtime');
    flags.push('--device-type', tablet.name);
  }
  prepareIosDevices({
    h,
    platform: PLATFORM,
    cleanup,
    targets: [
      { cwd: wt1 },
      { cwd: wt1, slot: 'second' },
      { cwd: wt1, slot: 'third', deviceType: flags[1] },
      { cwd: wt2 },
    ],
  });
  const start1 = startAndAssertMode(wt1);
  log(`wt1 start mode: ${start1.mode}`);
  const build1 = buildAndAssert(wt1, { expectCacheHit: false });
  if (WARM_CACHE) {
    log(
      build1.cacheHit
        ? `wt1 warm-started from the cross-run cache (${build1.cacheHit}) -- cross-run cache path exercised`
        : 'wt1 cold build: the restored cross-run cache held no matching fingerprint',
    );
  } else {
    assert(build1.cacheHit === false, `cold build must be a cache MISS, got ${JSON.stringify(build1.cacheHit)}`);
  }
  assertArtifact(build1.appPath);
  handleLaunch(build1, 'wt1');

  const start2 = startAndAssertMode(wt2);
  log(`wt2 start mode: ${start2.mode}`);
  const build2 = buildAndAssert(wt2, { expectCacheHit: true });
  assert(
    build2.cacheHit === 'local' || build2.cacheHit === 'remote',
    `second worktree must HIT the cache, got ${JSON.stringify(build2.cacheHit)}`,
  );
  assertArtifact(build2.appPath);
  assertNoCompile(wt2);
  handleLaunch(build2, 'wt2');
  log('CACHE PROOF: second worktree installed from cache without compiling.');

  cleanup.recordWorkspace(wt2);
  cli(['stop'], { cwd: wt2 });
  verifyDeviceSlots(wt1, build1, flags);
  cleanup.recordWorkspace(wt1);
  cli(['stop'], { cwd: wt1 });
  worktreeRemove(wt2);
  worktreeRemove(wt1);
  await verifyCleanup({ h, cleanup, appDir, created });
}

function verifyDeviceSlots(cwd, original, thirdFlags) {
  banner('named slots: distinct devices, cached installs, reuse and scoped stop');
  const deviceId = (facts) => (PLATFORM === 'ios' ? facts.udid : facts.avdName);
  const runSlot = (slot, flags = []) => {
    const facts = cliJson([PLATFORM, '--slot', slot, ...flags, '--json'], { cwd, timeout: 40 * 60 * 1000 });
    cleanup.recordBuild(facts);
    cleanup.recordWorkspace(cwd);
    assert(facts.slot === slot, `launch facts did not identify ${slot}`);
    assert(facts.cacheHit === 'local' || facts.cacheHit === 'remote', `slot ${slot} did not reuse the native build`);
    const records = cli(['logs', '--slot', slot, '--source', 'build', '--json'], { cwd })
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(records.length && records.every((record) => record.slot === slot), `build records escaped slot ${slot}`);
    return facts;
  };
  const second = runSlot('second');
  assert(deviceId(second) !== deviceId(original), 'two same-model slots shared a device');
  const repeated = runSlot('second');
  assert(deviceId(repeated) === deviceId(second), 'repeated slot did not reuse its device');
  const third = runSlot('third', thirdFlags);
  assert(new Set([original, second, third].map(deviceId)).size === 3, 'three slots did not get distinct devices');
  if (PLATFORM === 'ios') {
    const inventory = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 30000 }).stdout);
    const booted = new Set(
      Object.values(inventory.devices)
        .flat()
        .filter((device) => device.state === 'Booted')
        .map((device) => device.udid),
    );
    assert(
      [original, second, third].every((facts) => booted.has(facts.udid)),
      'all three slots must be booted simultaneously',
    );
  }
  const status = () =>
    cliJson(['status', '--json'], { cwd }).environments.find((environment) => environment.path === cwd);
  const before = status();
  assert(before?.slots?.length === 2, 'status omitted named slots');
  const stopped = cliJson(['stop', '--slot', 'second', '--json'], { cwd });
  assert(stopped.ok && stopped.port.status === 'kept', 'slot stop failed or released the shared port');
  const after = status();
  assert(after?.metro?.running && after.metro.port === before.metro.port, 'slot stop disturbed Metro');
  const sibling = after.slots.find((slot) => slot.slot === 'third');
  assert(
    PLATFORM === 'ios' ? sibling?.ios?.state === 'Booted' : sibling?.android?.serial === third.serial,
    'slot stop disturbed its sibling',
  );
  const resumed = runSlot('second');
  assert(deviceId(resumed) === deviceId(second), 'stopped slot lost its assignment');
  log('SLOT PROOF: three assignments, reuse, cache hits, attributed logs and isolated stop.');
}

function worktreeCreate(name, sourceDir) {
  return createWarmWorktree({ h, sourceDir, workDir: WORK_DIR, name, created });
}

function startAndAssertMode(cwd) {
  const r = cli(['start', '--json', '--wait', '240'], { cwd, allowFail: true });
  if (r.code !== 0) {
    const supLog = join(workspaceLogsDir(cwd), 'supervisor.log');
    if (existsSync(supLog)) {
      log(`--- supervisor.log (tail) ---\n${lastLines(readFileSync(supLog, 'utf-8'), 80)}`);
    }
    die(`stim start failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  }
  const line = r.stdout.trim().split('\n').findLast(Boolean);
  const facts = JSON.parse(line);
  cleanup.recordWorkspace(cwd);
  assert(
    facts.mode === EXPECTED_MODE,
    `start mode for a ${FRAMEWORK} app must be ${EXPECTED_MODE}, got ${JSON.stringify(facts.mode)} ` +
      '(this is exactly the detectIsExpo path a field test caught misfiring)',
  );
  return facts;
}

function buildAndAssert(cwd, { expectCacheHit }) {
  log(`building ${PLATFORM} in ${cwd} (expect cache ${expectCacheHit ? 'HIT' : 'MISS'})...`);
  const facts = cliJson([PLATFORM, '--json'], { cwd, timeout: 40 * 60 * 1000 });
  cleanup.recordBuild(facts);
  cleanup.recordWorkspace(cwd);
  log(
    `build facts: cacheHit=${JSON.stringify(facts.cacheHit)} launched=${JSON.stringify(facts.launched)} ` +
      `waitedForBuild=${JSON.stringify(facts.waitedForBuild)} durationMs=${facts.durationMs}`,
  );
  return facts;
}

function assertArtifact(appPath) {
  assert(
    typeof appPath === 'string' && appPath.endsWith(ARTIFACT_EXT),
    `appPath should be a ${ARTIFACT_EXT}, got ${JSON.stringify(appPath)}`,
  );
  assert(existsSync(appPath), `the built artifact does not exist on disk: ${appPath}`);
  log(`artifact ok: ${appPath}`);
}

function handleLaunch(facts, label) {
  log(launchEvidenceMessage(facts.launched, label));
}

function assertNoCompile(cwd) {
  const logPath = buildLog(cwd);
  const text = logPath ? readFileSync(logPath, 'utf-8') : '';
  log(noCompileEvidenceMessage({ cwd, logPath, text, compileSigns: COMPILE_SIGNS }));
}

function worktreeRemove(path) {
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a clean worktree:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

function parseArgs(argv) {
  const out = {
    framework: null,
    platform: null,
    appDir: null,
    keep: false,
    fixtureOnly: false,
    dryRun: false,
    home: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--framework') out.framework = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--app-dir') out.appDir = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--fixture-only') out.fixtureOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else {
      process.stderr.write(`[native-e2e] ERROR: unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function plan() {
  log(`framework=${FRAMEWORK} platform=${PLATFORM} expectedMode=${EXPECTED_MODE} artifact=*${ARTIFACT_EXT}`);
  log(`STIM_HOME=${HOME_DIR}`);
  log(`work dir=${WORK_DIR}`);
  log(
    args.appDir
      ? `using existing app: ${resolve(args.appDir)}`
      : `fixture: ${FIXTURE_COMMANDS[FRAMEWORK]('<appDir>').map(quote).join(' ')}`,
  );
}

if (!['bare', 'expo'].includes(FRAMEWORK) || !['ios', 'android'].includes(PLATFORM)) {
  die(
    'usage: run-native-e2e.mjs --framework <bare|expo> --platform <ios|android> [--app-dir P] [--keep] [--fixture-only] [--dry-run]',
  );
}

banner(`native e2e: ${VARIANT} (expected start mode: ${EXPECTED_MODE})`);
plan();
if (args.dryRun) {
  log('dry run: no side effects. Exiting.');
  process.exit(0);
}

main().then(
  () => {
    log(`PASS ${VARIANT}`);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(0);
  },
  (err) => {
    log(`FAIL ${VARIANT}: ${err?.message || err}`);
    dumpDiagnostics(h, created);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR], err);
    process.exit(1);
  },
);
