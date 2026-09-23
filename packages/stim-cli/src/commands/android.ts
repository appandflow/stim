import { isEasBuildFailure, resolveEasDevelopmentBuild } from '../engine/eas-build.ts';
import { deviceSlotFileKey, validateDeviceSlot } from '../devices/device-slots.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { type Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { loadCacheProvider } from '@stim-cli/cache';
import { formatDuration, phaseLine, SLOW_STEP_MS, stepClock, stepTimer } from '../command-output.ts';
import type { CcacheActivity } from '../engine/build-facts.ts';
import type { RemoteDeviceBackend } from '../engine/device-remote.ts';
import {
  appProjectProblem,
  findProjectRoot,
  detectAndroidPackage,
  detectBundleId,
  projectShortcut,
} from '../workspace/project.ts';
import {
  REMOTE_DEVICE_BACKENDS,
  resolveCacheProviderConfig,
  resolveSettings,
  metroWarmupUrlSetting,
  publicUrlSetting,
  tunnelModeSetting,
} from '../workspace/settings.ts';
import {
  waitFlagConflict,
  acquireRunLease,
  releaseLeaseOnSignal,
  runLease,
  leaseExpiryText,
  type RunLease,
} from '../engine/device-lease-run.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../workspace/config.ts';
import {
  fingerprintProject,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  untrackedNativeFiles,
} from '../cache/build-cache.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild as waitForOtherBuild } from '../engine/build-lock.ts';
import { claimFailure } from '../ownership-claim.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { pidExists, resolveProjectMetro } from '../metro.ts';
import { warmMetro } from '../engine/metro-warmup.ts';
import {
  ensureWorkspaceStorageSafely,
  resolveMetroWithRetry,
  noMetroMessage,
  noMetroRemedy,
} from './native-runtime.ts';
import {
  readRunEstimates,
  recordRunStats,
  createRunRecorder,
  statsProjectKey,
  type RunEstimates,
} from '../engine/stats.ts';
import { writeWorkspaceLaunch } from '../supervisor/state.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import {
  installAndroidApp,
  launchAndroidApp,
  launchAndroidReleaseApp,
  verifyAndroidReleaseLaunch,
  verifyLaunch,
  ADB_INSTALL_TIMEOUT_MS,
  DEFAULT_METRO_PORT,
} from '../engine/app-install.ts';
import {
  androidDeviceAbi,
  listAdbDevices,
  listInstalledSystemImages,
  physicalDeviceModel,
  probeEmulatorSerial,
  resolveOwnedAvdSerial,
  resolvePhysicalDevice,
  waitForBoot,
} from '../devices/android.ts';
import {
  checkDeviceCapacity,
  ensureBooted,
  ensureOwnedDevice,
  AvdRecoveryError,
  AvdBootError,
  type OwnedDeviceRecord,
} from '../engine/device.ts';
import {
  ensureRemoteBootOwned,
  ensureMetroReachable as ensureRemoteMetroReachable,
  remoteAndroidDeps,
  resolveRemoteContext,
  REMOTE_SESSION_ERROR,
  binOnPath,
} from '../engine/device-remote.ts';
import { detectProviders } from '../engine/metro-reach.ts';
import { selectFromPool } from '../engine/device-pool.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import { buildAndroid } from '../engine/gradle.ts';
import { CCACHE_NOT_RUN, resolveCcache } from '../engine/ccache.ts';
import { swapApkBundle } from '../engine/apk-swap.ts';
import { captureAssetManifest } from '../engine/asset-manifest.ts';
import {
  checkEasAuth,
  resolveEasCliBin,
  loadProjectProvider,
  resolveRemote,
  uploadRemote,
} from '../engine/remote-cache.ts';
import {
  androidDevClientScheme,
  dumpApkManifest,
  apkPackage,
  PLATFORM,
  NO_METRO,
  NO_DEVICE,
  noDeviceDiagnostic,
  displayPath,
  pooledAndroidDevice,
} from './android/support.ts';
import { getExecutor } from '../exec.ts';
import { emulatorLogFile, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import type { SupervisorLike, FailExtra, AndroidRecord, RunAndroidResult, AndroidBootLike } from './android/types.ts';
import { acquireAndroidArtifact } from './android/artifact.ts';
import { persistLastBuild } from './android/result.ts';
import { finishAndroidRun } from './android/launch.ts';
import { resolveAndroidRunPlan } from './android/plan.ts';

export { androidFacts, lastBuildRecord } from './android/result.ts';

export { collectorLogFile, killPreviousCollector, startCollector } from './android/collector.ts';

export {
  androidVariantSetting,
  resolveVariant,
  androidSystemImageSetting,
  resolveSystemImage,
  isReleaseVariant,
  NO_METRO,
  NO_FINGERPRINT,
  NO_DEVICE,
  findAapt,
  dumpApkManifest,
  parseXmltree,
  apkPackage,
  apkDevClientFacts,
  androidDevClientScheme,
  noDeviceDiagnostic,
  displayPath,
} from './android/support.ts';

export { formatDuration, phaseLine, shortHash } from '../command-output.ts';

interface AndroidCommandOptions {
  easProfile?: string;
  slot?: string;
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  variant?: string;
  systemImage?: string;
  remote?: RemoteDeviceBackend;
  device?: string | boolean;
  wait?: string | boolean;
}

export default function androidCommand(program: Command): void {
  registerAndroid(program);
}

export function registerAndroid(program: Command): void {
  program
    .command('android')
    .description(
      "Build (or install from the shared cache), install and launch this workspace's Android app on its owned " +
        'emulator, wired to the reserved Metro port. Never starts the bundler -- run `stim start` first.',
    )
    .option(
      '--eas-profile <name>',
      'Download a matching EAS development build; on a miss, print the build command without running it',
    )
    .option('--slot <name>', 'Reusable device slot within this workspace (default: default)', validateDeviceSlot)
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option(
      '--no-metro-check',
      'Skip the reserved-port Metro health check (the app will load no bundle unless something else serves it)',
    )
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .option(
      '--variant <name>',
      'Gradle variant to assemble and install (e.g. productionDebug on a flavored project); overrides the android.variant setting. A variant ending in Release embeds the JS bundle and skips Metro entirely. Default: debug',
    )
    .option(
      '--system-image <id>',
      "Android system image to create this workspace's owned AVD from, as the sdkmanager package id " +
        '(e.g. "system-images;android-36;google_apis;arm64-v8a"). Overrides the android.systemImage setting for this ' +
        'invocation. An unknown id refuses with STIM_BAD_ARG and prints the installed images.',
    )
    .option(
      '--device [serial]',
      "Install and launch on a connected physical device instead of this workspace's owned emulator. " +
        'With no serial, the first connected device this workspace can lease is used. Stim never creates, boots, or deletes a physical device.',
    )
    .option(
      '--remote <backend>',
      'Install and launch on a remote device with proxy or EAS. Builds are local unless --eas-profile selects an existing EAS build.',
      (value) => {
        if ((REMOTE_DEVICE_BACKENDS as readonly string[]).includes(value)) return value as RemoteDeviceBackend;
        throw new InvalidArgumentError(`expected one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}`);
      },
    )
    .option(
      '--wait <seconds>',
      'How long to wait for another workspace to release the device it leases, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once). Only with --device.',
    )
    .option(
      '--no-wait',
      "Install on a device another workspace leases instead of waiting: this run takes no lease and, when both workspaces build the same app id, the install terminates the holder's running app. Only with --device.",
    )
    .action(async (opts: AndroidCommandOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
        return;
      }
      const result = await withWorkspaceProcessLock(
        workspaceDir(root),
        'native-run',
        () =>
          runAndroid({
            root,
            slot: opts.slot,
            easProfile: opts.easProfile,
            json: Boolean(opts.json),
            metroCheck: opts.metroCheck !== false,
            useBuildCache: opts.buildCache !== false,
            variant: opts.variant ?? null,
            systemImage: opts.systemImage ?? null,
            remoteDevice: opts.remote ?? null,
            device: opts.device ?? null,
            wait: opts.wait,
            waitConflict: waitFlagConflict(process.argv),
          }),
        { external: true, waitMs: 30 * 60_000, declareSpawns: true },
      );
      if (!result.ok) process.exit(1);
    });
}

interface RunAndroidOptions {
  easProfile?: string;
  resolveEasDevelopmentBuild?: typeof resolveEasDevelopmentBuild;
  slot?: string;
  root: string;
  json?: boolean;
  metroCheck?: boolean;
  useBuildCache?: boolean;
  variant?: string | null;
  systemImage?: string | null;
  listSystemImages?: typeof listInstalledSystemImages;
  device?: string | boolean | null;
  wait?: string | boolean;
  waitConflict?: boolean;
  acquireLease?: typeof acquireRunLease;
  makeRunLease?: typeof runLease;
  selectPool?: typeof selectFromPool;
  onLeaseSignal?: typeof releaseLeaseOnSignal;
  listDevices?: typeof listAdbDevices;
  deviceModel?: typeof physicalDeviceModel;
  deviceAbi?: typeof androidDeviceAbi;
  isEmulatorDevice?: typeof probeEmulatorSerial;
  readApkPackage?: (apkPath: string | null) => string | null;
  remoteDevice?: RemoteDeviceBackend | null;
  resolveSettingsFor?: typeof resolveSettings;
  resolveRemoteDeviceContext?: typeof resolveRemoteContext;
  remoteDeviceDeps?: typeof remoteAndroidDeps;
  resolveEasBin?: typeof resolveEasCliBin;
  ensureMetroReachable?: typeof ensureRemoteMetroReachable;
  ensureRemoteBootOwned?: typeof ensureRemoteBootOwned;
  detectRemoteProviders?: typeof detectProviders;
  getLimits?: typeof getConcurrencyLimits;
  checkCapacity?: typeof checkDeviceCapacity;
  acquireSlot?: typeof acquireBuildSlot;
  releaseSlot?: typeof releaseBuildSlot;
  ensureDevice?: typeof ensureOwnedDevice;
  ensureDeviceBooted?: typeof ensureBooted;
  resolveAvdSerial?: typeof resolveOwnedAvdSerial;
  waitForDeviceBoot?: typeof waitForBoot;
  resolveMetro?: typeof resolveProjectMetro;
  warmMetro?: typeof warmMetro;
  resolveMetroRetrying?: typeof resolveMetroWithRetry;
  readState?: typeof readWorkspaceState;
  pidAlive?: typeof pidExists;
  verifyCollector?: typeof verifyCollectorOwnership;
  verifyLaunched?: typeof verifyLaunch;
  ensureStorage?: typeof ensureWorkspaceStorageSafely;
  fingerprint?: typeof fingerprintProject;
  untracked?: typeof untrackedNativeFiles;
  resolveCached?: typeof resolveBuild;
  storeCached?: typeof storeBuild;
  storedAssets?: typeof storedAssetManifest;
  captureAssets?: typeof captureAssetManifest;
  acquireLock?: typeof acquireBuildLock;
  releaseLock?: typeof releaseBuildLock;
  waitForBuild?: typeof waitForOtherBuild;
  loadProvider?: typeof loadProjectProvider;
  easAuth?: typeof checkEasAuth;
  resolveRemoteBuild?: typeof resolveRemote;
  uploadRemoteBuild?: typeof uploadRemote;
  resolveCacheProvider?: typeof resolveCacheProviderConfig;
  loadCacheProviderModule?: typeof loadCacheProvider;
  needsPrebuildFor?: typeof needsPrebuild;
  prebuild?: typeof runPrebuild;
  build?: typeof buildAndroid;
  ccacheFor?: typeof resolveCcache;
  install?: typeof installAndroidApp;
  launch?: typeof launchAndroidApp;
  launchRelease?: typeof launchAndroidReleaseApp;
  verifyReleaseLaunched?: typeof verifyAndroidReleaseLaunch;
  swapApk?: typeof swapApkBundle;
  resolveDevClientScheme?: typeof androidDevClientScheme;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  createWriter?: typeof createNdjsonWriter;
  writeLaunch?: typeof writeWorkspaceLaunch;
  writeState?: typeof writeWorkspaceState;
  recordStats?: typeof recordRunStats;
  readEstimates?: typeof readRunEstimates;
  now?: () => number;
  out?: (line: string) => void;
  emit?: (line: string) => void;
}

function resolveRunAndroidOptions(
  {
    root,
    json = false,
    remoteDevice: commandRemoteBackend = null,
    resolveSettingsFor = resolveSettings,
    resolveRemoteDeviceContext = resolveRemoteContext,
    remoteDeviceDeps: makeRemoteDeviceDeps = remoteAndroidDeps,
    resolveEasBin = resolveEasCliBin,
    ensureMetroReachable: ensureRemoteMetro = ensureRemoteMetroReachable,
    ensureRemoteBootOwned: ensureRemoteOwned = ensureRemoteBootOwned,
    detectRemoteProviders = detectProviders,
    metroCheck = true,
    useBuildCache = true,
    easProfile,
    resolveEasDevelopmentBuild: resolveEasBuild = resolveEasDevelopmentBuild,
    variant: variantFlag = null,
    systemImage: systemImageFlag = null,
    device: deviceFlag = null,
    wait: waitFlag = undefined,
    waitConflict = false,
    acquireLease = acquireRunLease,
    makeRunLease = runLease,
    selectPool = selectFromPool,
    onLeaseSignal = releaseLeaseOnSignal,
    listDevices = listAdbDevices,
    deviceModel = physicalDeviceModel,
    deviceAbi = androidDeviceAbi,
    isEmulatorDevice = probeEmulatorSerial,
    readApkPackage = (apkPath: string | null) => apkPackage(dumpApkManifest(apkPath)),
    getLimits = getConcurrencyLimits,
    checkCapacity = checkDeviceCapacity,
    acquireSlot = acquireBuildSlot,
    releaseSlot = releaseBuildSlot,
    ensureDevice = ensureOwnedDevice,
    listSystemImages = listInstalledSystemImages,
    ensureDeviceBooted = ensureBooted,
    resolveAvdSerial = resolveOwnedAvdSerial,
    waitForDeviceBoot = waitForBoot,
    resolveMetro = resolveProjectMetro,
    warmMetro: prewarmMetro = warmMetro,
    resolveMetroRetrying = resolveMetroWithRetry,
    readState = readWorkspaceState,
    pidAlive = pidExists,
    verifyCollector = verifyCollectorOwnership,
    verifyLaunched = verifyLaunch,
    ensureStorage = ensureWorkspaceStorageSafely,
    fingerprint = fingerprintProject,
    untracked = untrackedNativeFiles,
    resolveCached = resolveBuild,
    storeCached = storeBuild,
    storedAssets = storedAssetManifest,
    captureAssets = captureAssetManifest,
    acquireLock = acquireBuildLock,
    releaseLock = releaseBuildLock,
    waitForBuild = waitForOtherBuild,
    loadProvider = loadProjectProvider,
    easAuth = checkEasAuth,
    resolveRemoteBuild = resolveRemote,
    uploadRemoteBuild = uploadRemote,
    resolveCacheProvider = resolveCacheProviderConfig,
    loadCacheProviderModule = loadCacheProvider,
    needsPrebuildFor = needsPrebuild,
    prebuild = runPrebuild,
    build = buildAndroid,
    ccacheFor = resolveCcache,
    install = installAndroidApp,
    launch = launchAndroidApp,
    launchRelease = launchAndroidReleaseApp,
    verifyReleaseLaunched = verifyAndroidReleaseLaunch,
    swapApk = swapApkBundle,
    resolveDevClientScheme = androidDevClientScheme,
    spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
    kill = (pid, signal) => process.kill(pid, signal),
    createWriter = createNdjsonWriter,
    writeLaunch = writeWorkspaceLaunch,
    writeState = writeWorkspaceState,
    recordStats = recordRunStats,
    readEstimates = readRunEstimates,
    now = Date.now,
    out = (line) => console.error(line),
    emit = (line) => console.log(line),
  }: RunAndroidOptions = {} as RunAndroidOptions,
) {
  return {
    root,
    json,
    commandRemoteBackend,
    resolveSettingsFor,
    resolveRemoteDeviceContext,
    makeRemoteDeviceDeps,
    resolveEasBin,
    ensureRemoteMetro,
    ensureRemoteOwned,
    detectRemoteProviders,
    metroCheck,
    useBuildCache,
    easProfile,
    resolveEasBuild,
    variantFlag,
    systemImageFlag,
    deviceFlag,
    waitFlag,
    waitConflict,
    acquireLease,
    makeRunLease,
    selectPool,
    onLeaseSignal,
    listDevices,
    deviceModel,
    deviceAbi,
    isEmulatorDevice,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    listSystemImages,
    ensureDeviceBooted,
    resolveAvdSerial,
    waitForDeviceBoot,
    resolveMetro,
    prewarmMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyCollector,
    verifyLaunched,
    ensureStorage,
    fingerprint,
    untracked,
    resolveCached,
    storeCached,
    storedAssets,
    captureAssets,
    acquireLock,
    releaseLock,
    waitForBuild,
    loadProvider,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    resolveCacheProvider,
    loadCacheProviderModule,
    needsPrebuildFor,
    prebuild,
    build,
    ccacheFor,
    install,
    launch,
    launchRelease,
    verifyReleaseLaunched,
    swapApk,
    resolveDevClientScheme,
    spawn,
    kill,
    createWriter,
    writeLaunch,
    writeState,
    recordStats,
    readEstimates,
    now,
    out,
    emit,
  };
}

function androidSlotOptions(options: RunAndroidOptions) {
  const base = resolveRunAndroidOptions(options);
  const slot = validateDeviceSlot(options.slot);
  if (slot === 'default') return base;
  return {
    ...base,
    ensureDevice: (args: Parameters<typeof base.ensureDevice>[0]) => base.ensureDevice({ ...args, slot }),
    checkCapacity: (args: Parameters<typeof base.checkCapacity>[0]) => base.checkCapacity({ ...args, slot }),
    selectPool: (args: Parameters<typeof base.selectPool>[0]) => base.selectPool({ ...args, slot }),
    acquireLease: (args: Parameters<typeof base.acquireLease>[0]) => base.acquireLease({ ...args, slot }),
    makeRunLease: (args: Parameters<typeof base.makeRunLease>[0]) => base.makeRunLease({ ...args, slot }),
    writeLaunch: ((projectRoot, platform, record) =>
      base.writeLaunch(projectRoot, platform, record, slot)) as typeof base.writeLaunch,
  };
}

function avdSetupFailure(
  error: unknown,
  root: string,
  logFile: string,
): { code: string; message: string; remedy: string; extra?: FailExtra } {
  const refusal = claimFailure(error, 'stim android');
  if (refusal) return refusal;
  const diag = noDeviceDiagnostic({
    reason: `Could not ensure an owned Android emulator: ${(error as Error)?.message || error}`,
    logFile,
    localEmulator: !(error instanceof AvdRecoveryError),
    remedy:
      error instanceof AvdBootError
        ? error.remedy
        : 'Check that JAVA_HOME and ANDROID_HOME are set correctly, and that an arm64 system image is installed (`sdkmanager "system-images;android-36;google_apis;arm64-v8a"`).',
  });
  return {
    code: NO_DEVICE,
    message: diag.message,
    remedy: diag.remedy,
    extra: { lines: diag.lines, logPath: diag.logPath ? displayPath(root, diag.logPath) : null },
  };
}

export async function runAndroid(options: RunAndroidOptions = {} as RunAndroidOptions): Promise<RunAndroidResult> {
  let {
    root,
    json,
    commandRemoteBackend,
    resolveSettingsFor,
    resolveRemoteDeviceContext,
    makeRemoteDeviceDeps,
    resolveEasBin,
    ensureRemoteMetro,
    ensureRemoteOwned,
    detectRemoteProviders,
    metroCheck,
    useBuildCache: requestedBuildCache,
    easProfile,
    resolveEasBuild,
    variantFlag,
    systemImageFlag,
    deviceFlag,
    waitFlag,
    waitConflict,
    acquireLease,
    makeRunLease,
    selectPool,
    onLeaseSignal,
    listDevices,
    deviceModel,
    deviceAbi,
    isEmulatorDevice,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    listSystemImages,
    ensureDeviceBooted,
    resolveAvdSerial,
    waitForDeviceBoot,
    resolveMetro,
    prewarmMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyCollector,
    verifyLaunched,
    ensureStorage,
    fingerprint,
    untracked,
    resolveCached,
    storeCached,
    storedAssets,
    captureAssets,
    acquireLock,
    releaseLock,
    waitForBuild,
    loadProvider,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    resolveCacheProvider,
    loadCacheProviderModule,
    needsPrebuildFor,
    prebuild,
    build,
    ccacheFor,
    install,
    launch,
    launchRelease,
    verifyReleaseLaunched,
    swapApk,
    resolveDevClientScheme,
    spawn,
    kill,
    createWriter,
    writeLaunch,
    writeState,
    recordStats,
    readEstimates,
    now,
    out,
    emit,
  } = androidSlotOptions(options);
  const slot = validateDeviceSlot(options.slot);
  const started = now();
  const startedAt = new Date(started).toISOString();
  const projectProblem = appProjectProblem(root);
  if (projectProblem) {
    const { message, remedy } = projectProblem;
    out(phaseLine('error', chalk.red(`STIM_NO_PROJECT: ${message}`)));
    out(phaseLine('remedy', remedy));
    if (json) emit(JSON.stringify({ code: 'STIM_NO_PROJECT', message, remedy }));
    return { ok: false, error: { code: 'STIM_NO_PROJECT', message, remedy } };
  }
  try {
    await ensureStorage(root, { note: out });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'STIM_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's Stim state: ${(error as Error)?.message || error}`;
    const remedy =
      'Check that STIM_HOME is writable and has free space. An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (`stim guide errors sandbox`).';
    out(phaseLine('error', chalk.red(`${code}: ${message}`)));
    out(phaseLine('remedy', remedy));
    if (json) emit(JSON.stringify({ code, message, remedy }));
    return { ok: false, error: { code, message, remedy } };
  }
  const logsDir = workspaceLogsDir(root);
  const buildLog = join(logsDir, `build-${deviceSlotFileKey('android', slot)}.ndjson`);
  const writer = createWriter(buildLog, { truncate: true, fields: { slot } });

  const record: AndroidRecord = {
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    appPath: null,
    bundleId: null,
    avdName: null,
    deviceName: null,
  };

  const phase = (label: unknown, text: string) => out(phaseLine(label, text));

  const stats = createRunRecorder({
    platform: PLATFORM,
    write: recordStats,
    now,
    note: (line) => out(phaseLine('stats', chalk.dim(line))),
  });
  const recordRun = stats.record;

  let ccacheActivity: CcacheActivity = CCACHE_NOT_RUN;

  const fail = (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    { lastBuildStatus = false, diagnostics = [], lines = [], logPath = null, lease }: FailExtra = {},
  ): RunAndroidResult => {
    if (lastBuildStatus) {
      persistLastBuild({
        writeState,
        root,
        record,
        startedAt,
        durationMs: now() - started,
        status: 'failed',
        errorCode: code,
        out,
      });
    }
    out(phaseLine('error', chalk.red(`${code}: ${message}`)));
    for (const diagnostic of diagnostics) out(phaseLine('error', chalk.red(diagnostic)));
    for (const line of lines) out(phaseLine('', chalk.dim(line)));
    if (remedy) out(phaseLine('remedy', remedy));
    if (logPath) out(phaseLine('log', logPath));
    recordRun({ failed: true, durationMs: now() - started });
    if (json) {
      emit(
        JSON.stringify({
          code,
          message,
          remedy: remedy ?? null,
          ...(ccacheActivity.status === 'not-run' ? {} : { ccache: ccacheActivity }),
          ...(lease === undefined ? {} : { lease }),
        }),
      );
    }
    writer.close();
    return { ok: false, error: { code, message, remedy: remedy ?? null } };
  };

  const settingsRepoRoot = repoRoot(root);
  const settingsRoot = root;
  const settingsContext = {
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: settingsRepoRoot,
  };
  const projectKey = statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsRepoRoot });
  stats.setProject(projectKey);
  let estimatesRead: RunEstimates | null = null;
  const estimates = (): RunEstimates => (estimatesRead ??= readEstimates({ projectKey, platform: PLATFORM }));
  const settings = resolveSettingsFor(settingsContext);
  const planned = resolveAndroidRunPlan(
    {
      settings,
      settingsContext,
      slot,
      easProfile,
      variant: variantFlag,
      systemImage: systemImageFlag,
      device: deviceFlag,
      wait: waitFlag,
      waitConflict,
      remote: commandRemoteBackend,
      buildCache: requestedBuildCache,
    },
    { resolveCacheProvider, listSystemImages, warn: (label, message) => out(phaseLine(label, chalk.yellow(message))) },
  );
  if (!planned.ok) return fail(planned.code, planned.message, planned.remedy, { lines: planned.lines });
  const { plan } = planned;
  const { build: buildPlan, target, isExpo, cacheProviderConfig } = plan;
  const { variant, release, cache: cachePolicy } = buildPlan;
  const useBuildCache = cachePolicy.read;
  const physical = target.kind === 'physical';
  const remoteBackend = target.kind === 'remote' ? target.backend : null;
  const easBuild = await resolveEasBuild({
    root,
    platform: PLATFORM,
    profile: easProfile,
    note: out,
    isExpo,
    physical,
    selectors: [variantFlag],
    buildCache: requestedBuildCache,
  });
  if (isEasBuildFailure(easBuild)) return fail(easBuild.code, easBuild.message, easBuild.remedy);
  let androidPackage = detectAndroidPackage(root);
  record.bundleId = androidPackage;
  const registerProject = () =>
    upsertProject(root, {
      bundleId: detectBundleId(root) ?? undefined,
      androidPackage: androidPackage ?? undefined,
      isExpo,
    });
  if (remoteBackend !== 'eas') registerProject();
  const project = getProject(root);
  const label = projectShortcut(root, project);

  let remoteDevice: ReturnType<typeof makeRemoteDeviceDeps> | null = null;

  const reservedPort = project?.metroPort ?? null;
  let metroPort: number | null = null;
  let phaseFailure: RunAndroidResult | null = null;

  async function resolveMetroPort(): Promise<boolean> {
    if (release) {
      phase('metro', `skipped (${variant}: the JS bundle is embedded, no dev server is used)`);
    } else if (metroCheck) {
      if (!reservedPort) {
        phaseFailure = fail(
          NO_METRO,
          'No Metro port is reserved for this workspace.',
          'Run `stim start` first, or pass --no-metro-check.',
        );
        return false;
      }
      const held = await resolveMetroRetrying(resolveMetro, reservedPort, root, {
        onRetry: ({ delayMs }) =>
          phase(
            'metro',
            `port ${reservedPort} did not verify yet; retrying in ${Math.round(delayMs / 1000)}s (Metro may still be indexing)`,
          ),
      });
      if (!held.metro) {
        const supervisor = (readState(root)?.supervisor ?? null) as SupervisorLike | null;
        const supervisorAlive = Boolean(supervisor?.pid && pidAlive(supervisor.pid));
        phaseFailure = fail(
          NO_METRO,
          noMetroMessage({ port: reservedPort, resolution: held, supervisor, supervisorAlive }),
          noMetroRemedy({ port: reservedPort, supervisor, supervisorAlive }),
        );
        return false;
      }
      phase('metro', `port ${reservedPort} (pid ${held.metro?.pid})`);
    } else {
      phase(
        'metro',
        reservedPort
          ? `port ${reservedPort} (not checked)`
          : `no reservation; using ${DEFAULT_METRO_PORT} (not checked)`,
      );
    }
    metroPort = release ? null : (reservedPort ?? DEFAULT_METRO_PORT);
    return true;
  }

  if (!(await resolveMetroPort())) return phaseFailure!;

  if (remoteBackend) {
    const resolved = await resolveRemoteDeviceContext({
      root,
      label,
      platform: PLATFORM,
      backend: remoteBackend,
      easBin: resolveEasBin(root)?.file ?? null,
    });
    if ('failed' in resolved) return fail(resolved.code ?? REMOTE_SESSION_ERROR, resolved.failed, resolved.remedy);
    remoteDevice = makeRemoteDeviceDeps(resolved.ctx);

    if (metroPort !== null) {
      const reachable = await ensureRemoteMetro({
        ctx: remoteDevice.ctx,
        metroPort,
        isExpo,
        tunnelMode: tunnelModeSetting(settings) ?? undefined,
        publicUrl: publicUrlSetting(settings),
        available: detectRemoteProviders(binOnPath),
      });
      if ('failed' in reachable) {
        return fail(reachable.code ?? REMOTE_SESSION_ERROR, reachable.failed, reachable.remedy);
      }
    }

    checkCapacity = remoteDevice.checkCapacity;
    ensureDevice = remoteDevice.ensureDevice;
    ensureDeviceBooted = remoteDevice.ensureDeviceBooted;
    install = remoteDevice.install;
    launch = remoteDevice.launch;
  }

  const emuLog = emulatorLogFile(root);
  const limits = getLimits();
  let device: OwnedDeviceRecord;
  let bootDuration = '';
  let bootPromise: Promise<AndroidBootLike>;

  if (target.kind === 'physical' && !target.serial) {
    const pooled = await pooledAndroidDevice({
      root,
      selectPool,
      listDevices,
      isEmulatorDevice,
      deviceModel,
      waitSeconds: target.lease.waitSeconds,
      noWait: target.lease.noWait,
      now,
      warn: (line: string) => out(phaseLine('lease', chalk.yellow(line))),
    });
    if ('code' in pooled) return fail(pooled.code, pooled.message, pooled.remedy, pooled.extra);
    device = pooled.device;
    bootPromise = Promise.resolve({ ok: true, serial: pooled.device.serial });
  } else if (target.kind === 'physical') {
    const resolved = resolvePhysicalDevice(target.serial, listDevices(), isEmulatorDevice);
    if (!resolved.serial) return fail(NO_DEVICE, resolved.error!, resolved.remedy!);
    device = {
      serial: resolved.serial,
      deviceName: deviceModel(resolved.serial) ?? resolved.serial,
      owned: false,
    };
    bootPromise = Promise.resolve({ ok: true, serial: resolved.serial });
  } else {
    const capacity = checkCapacity({
      platform: PLATFORM,
      project,
      max: limits.maxDevices,
    });
    if (capacity) return fail(capacity.code, capacity.message, capacity.remedy);

    const prepare = stepClock(now);
    try {
      device = await ensureDevice({
        platform: PLATFORM,
        project,
        projectPath: root,
        settingsRoot,
        settings,
        flags: { systemImage: target.systemImage },
        note: out,
        out,
        logFile: emuLog,
      });
    } catch (err) {
      const failure = avdSetupFailure(err, root, emuLog);
      return fail(failure.code, failure.message, failure.remedy, failure.extra);
    }
    const prepareMs = prepare();
    if (device.created || prepareMs >= SLOW_STEP_MS) {
      phase(
        'device',
        `${device.avdName || device.deviceName || label} ${device.created ? 'created' : 'prepared'} (${formatDuration(prepareMs)})`,
      );
    }

    const bootTimer = stepTimer(now);
    const boot = (): Promise<AndroidBootLike> =>
      Promise.resolve(ensureDeviceBooted({ platform: PLATFORM, device, out, logFile: emuLog })).catch((e) => ({
        failed: true as const,
        reason: String((e as Error)?.message || e),
        serial: undefined,
      }));
    bootPromise = (
      remoteDevice?.ctx.backend === 'eas'
        ? ensureRemoteOwned({
            root,
            platform: PLATFORM,
            sessionName: ownedSessionName(remoteDevice.ctx.label),
            startedAt,
            boot,
            createdSessionId: remoteDevice.createdSessionId,
            abandonCreatedSession: remoteDevice.abandonCreatedSession,
            writeState,
            register: registerProject,
          })
        : boot()
    ).then((result) => {
      bootDuration = bootTimer();
      return result;
    });
  }

  if (remoteDevice) {
    const booted = await bootPromise;
    if (booted.failed) {
      if (booted.code) {
        return fail(booted.code, booted.reason ?? 'The remote device did not boot.', booted.remedy ?? null);
      }
      const diag = noDeviceDiagnostic({
        reason: booted.reason ?? 'The remote device did not boot.',
        logFile: emuLog,
        remedy: 'Run `stim status` to inspect the remote device, then retry the command.',
        localEmulator: false,
      });
      return fail(NO_DEVICE, diag.message, diag.remedy, {
        lines: diag.lines,
        logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
      });
    }
  }
  record.avdName = device.avdName ?? null;
  record.deviceName = device.deviceName ?? device.avdName ?? null;
  record.systemImage = device.systemImage;

  const runFromFingerprint = async (): Promise<RunAndroidResult> => {
    if (metroCheck && metroPort !== null && plan.metroWarmup)
      void prewarmMetro({
        port: metroPort,
        platform: 'android',
        isExpo,
        appId: androidPackage,
        bundleUrl: metroWarmupUrlSetting(settings, 'android'),
      });
    const acquiredArtifact = await acquireAndroidArtifact(
      {
        root,
        buildLog,
        writer,
        settings,
        isExpo,
        device,
        physical,
        buildPlan,
        cacheProviderConfig,
        requestedBuildCache,
        easBuild,
        androidPackage,
        record,
        maxBuilds: limits.maxBuilds,
        progress: { phase, out, estimates, stats },
      },
      {
        deviceAbi,
        fingerprint,
        untracked,
        resolveCached,
        storeCached,
        storedAssets,
        captureAssets,
        acquireLock,
        releaseLock,
        waitForBuild,
        loadProvider,
        easAuth,
        resolveRemoteBuild,
        uploadRemoteBuild,
        loadCacheProviderModule,
        acquireSlot,
        releaseSlot,
        needsPrebuildFor,
        prebuild,
        build,
        ccacheFor,
        swapApk,
        readState,
        now,
      },
    );
    if (!acquiredArtifact.ok) {
      ccacheActivity = acquiredArtifact.ccache;
      const { failure } = acquiredArtifact;
      return fail(failure.code, failure.message, failure.remedy, failure.extra);
    }
    const { artifact } = acquiredArtifact;
    const { apkPath } = artifact;
    ccacheActivity = artifact.ccache;
    androidPackage = artifact.androidPackage;
    record.appPath = apkPath;

    let leaseHandle: RunLease | null = null;
    let stopLeaseSignals: (() => void) | null = null;
    const releaseLease = () => {
      const held = leaseHandle;
      const stopSignals = stopLeaseSignals;
      leaseHandle = null;
      stopLeaseSignals = null;
      stopSignals?.();
      try {
        held?.release();
      } catch (err) {
        out(phaseLine('lease', chalk.dim(`could not release this run's lease: ${(err as Error)?.message || err}`)));
      }
    };
    if (physical) {
      const acquired = await acquireLease({
        root,
        platform: PLATFORM,
        id: device.serial!,
        deviceName: device.deviceName ?? null,
        idLabel: 'serial',
        waitSeconds: target.lease.waitSeconds,
        noWait: target.lease.noWait,
        installBoundMs: ADB_INSTALL_TIMEOUT_MS,
        appId: androidPackage,
        holderAppId: (holder: string) => getProject(holder)?.androidPackage ?? null,
        now,
        warn: (line: string) => out(phaseLine('lease', chalk.yellow(line))),
      });
      if (acquired.status === 'refused') {
        return fail(acquired.refusal.code, acquired.refusal.message, acquired.refusal.remedy, {
          lease: acquired.refusal.lease,
        });
      }
      leaseHandle = makeRunLease({
        root,
        platform: PLATFORM,
        kind: acquired.status === 'leased' ? acquired.kind : null,
        expiresAt: acquired.status === 'leased' ? acquired.expiresAt : null,
      });
      if (acquired.status === 'leased') {
        stopLeaseSignals = onLeaseSignal(releaseLease);
        phase(
          'lease',
          `${acquired.kind} lease on ${device.serial} until ${leaseExpiryText(acquired.expiresAt, now())}`,
        );
      }
    }

    try {
      return await finishAndroidRun({
        slot,
        lease: leaseHandle,
        releaseLease,
        root,
        json,
        metroCheck,
        useBuildCache,
        variant,
        release,
        isExpo,
        metroPort,
        logsDir,
        emuLog,
        device,
        physical,
        remoteDevice,
        bootPromise,
        resolveAvdSerial,
        waitForDeviceBoot,
        bootDuration: () => bootDuration,
        apkPath,
        androidPackage,
        swapDir: artifact.swapDir,
        record,
        waitedForBuild: artifact.waitedForBuild,
        ccache: ccacheActivity,
        uploadPending: artifact.uploadPending,
        providerUpload: artifact.providerUpload,
        providerName: artifact.providerName,
        remote: artifact.remote,
        abandonedRemote: artifact.abandonedRemote,
        started,
        startedAt,
        writer,
        phase,
        fail,
        readApkPackage,
        install,
        launch,
        launchRelease,
        resolveDevClientScheme,
        verifyLaunched,
        verifyReleaseLaunched,
        spawn,
        kill,
        pidAlive,
        verifyCollector,
        writeLaunch,
        writeState,
        now,
        out,
        emit,
        recordRun,
      });
    } finally {
      releaseLease();
    }
  };

  try {
    return await runFromFingerprint();
  } catch (error) {
    recordRun({ failed: true, durationMs: now() - started });
    throw error;
  }
}
