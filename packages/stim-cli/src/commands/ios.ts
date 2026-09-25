import { acquireIosArtifact, type PreparedIosArtifact } from './ios/artifact.ts';
import { isEasBuildFailure } from '../engine/eas-build.ts';
import { deviceSlotFileKey, parseDeviceSlotOption, validateDeviceSlot } from '../devices/device-slots.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { NO_BUILD_PROGRESS, startBuildProgress, type BuildProgress } from '../engine/build-progress.ts';
import { join } from 'node:path';
import {
  resolveOptimizations,
  artifactCachePolicy,
  optimizationBuildProfile,
  type Optimizations,
} from '../optimizations.ts';
import { type Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { formatDuration, phaseLine, SLOW_STEP_MS, stepClock, stepTimer } from '../command-output.ts';
import { waitFlagConflict, leaseExpiryText, parseDeviceWait, type RunLease } from '../engine/device-lease-run.ts';
import type { RemoteDeviceBackend } from '../engine/device-remote.ts';
import type { CompilationCacheActivity, DevServerStart } from '../engine/build-facts.ts';
import { exitAfterFlush } from '../engine/remote-cache.ts';
import {
  REMOTE_DEVICE_BACKENDS,
  cacheProviderSettingError,
  iosLanHostSetting,
  iosLanHostSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  metroWarmupUrlSetting,
  publicUrlSetting,
  remoteIosSetting,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
  unknownSettingKeys,
} from '../workspace/settings.ts';
import type { IosCommandOptions, IosBootLike, FailArgs } from './ios/types.ts';
import { type IosDeps, DEFAULT_DEPS } from './ios/dependencies.ts';
import { DEFAULT_METRO_PORT } from '../engine/app-install.ts';
import { ensureOwnedDevice } from '../engine/device.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../devices/sim-pool.ts';
import { REMOTE_SESSION_ERROR, binOnPath } from '../engine/device-remote.ts';
import {
  iosDeviceBounds,
  iosPoolCandidates,
  isWirelessIosDevice,
  iosPoolNoCandidatesRefusal,
  resolveIosPhysicalDevice,
} from '../engine/ios-device.ts';
import { chooseLanAddress, lanOriginUrlFor } from '../engine/ios-lan.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import { createRunRecorder, statsProjectKey, type RunEstimates } from '../engine/stats.ts';
import { COMPILATION_CACHE_NOT_RUN } from '../engine/xcode.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { ReclaimedStep } from '../budget.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { appProjectProblem, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { ensureDevServer, isPhysicalDeviceRequest } from './native-runtime.ts';
import {
  PLATFORM,
  buildLogFile,
  deviceLabel,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  resolveSimulatorAppFlag,
  deviceModelRefusal,
  isReleaseConfiguration,
} from './ios/support.ts';
import { lastBuildRecord, writeLastBuild } from './ios/result.ts';
import { finishIosRun, type IosRunCompletion } from './ios/launch.ts';

export { lastBuildRecord, iosFacts, writeLastBuild, cacheDescription } from './ios/result.ts';

export { devClientScheme, schemesFromInfoPlist, pickDevClientScheme } from './dev-client.ts';

export { collectorEntry, replaceCollector } from './ios/collector.ts';

export { ensureWorkspaceStorageSafely } from './native-runtime.ts';

export {
  buildLogFile,
  deviceLabel,
  appNameFromPath,
  iosConfigurationSetting,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  isReleaseConfiguration,
  podAction,
} from './ios/support.ts';

export { formatDuration, phaseLine, shortHash, shortUdid } from '../command-output.ts';

function writeNote(line: string): void {
  console.error(line);
}

function writePhase(name: unknown, text: string): void {
  console.error(phaseLine(name, text));
}

export default function iosCommand(program: Command): void {
  registerIos(program);
}

export function registerIos(program: Command, deps: Partial<IosDeps> = {}): void {
  program
    .command('ios')
    .description(
      "Build (or restore from the fingerprint cache), install and launch this workspace's app on its owned " +
        'simulator, wired to the reserved Metro port. Requires a running dev server (`stim start`).',
    )
    .option(
      '--eas-profile <name>',
      'Download a matching EAS development build; on a miss, print the build command without running it',
    )
    .option('--slot <name>', 'Reusable device slot within this workspace (default: default)', parseDeviceSlotOption)
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option(
      '--scheme <name>',
      'Shared Xcode app scheme to build; overrides automatic scheme selection, not the app URL scheme',
    )
    .option('--no-metro-check', 'Skip the "is this workspace\'s dev server running?" gate and build anyway')
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .option(
      '--configuration <name>',
      'Xcode configuration to build (e.g. Release). A non-Debug configuration embeds the JS bundle and skips Metro entirely. Overrides the ios.configuration setting. Default: Debug',
    )
    .option(
      '--device-type <name>',
      "Simulator model to create this workspace's owned sim as, exactly as `xcrun simctl list devicetypes` names it " +
        '(e.g. "iPad Pro 13-inch (M5)"). Overrides the ios.deviceType setting for this invocation. A model no installed ' +
        'runtime can create refuses with STIM_BAD_ARG and prints the models they do offer.',
    )
    .option(
      '--runtime <version>',
      'Simulator runtime to create this workspace\'s owned sim on, as a version ("18.5") or a runtime\'s full name ' +
        '("iOS 18.5"); nothing else matches. Overrides the ios.runtime setting for this invocation. An unknown version ' +
        'refuses with STIM_BAD_ARG and prints the installed runtimes.',
    )
    .option(
      '--simulator-app <app>',
      'Open the owned simulator in xcode, siniulator, or stim-desktop for this run, overriding the machine iosSimulatorApp setting. Also opens an already running simulator; local simulators only.',
    )
    .option(
      '--device [udid]',
      "Build the iphoneos slice for a connected iPhone, install it, and launch it, instead of using this workspace's " +
        'owned simulator. The phone can be cabled or paired over Wi-Fi. With no UDID, the first cabled device this workspace can lease ' +
        'is used, waiting for one that is busy; a Wi-Fi device is used only when no cabled one is connected and ready. In Debug the app is wired to this ' +
        "workspace's Metro over the LAN. Stim never creates, boots, or deletes a physical device.",
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
      'How long to wait for another workspace to release the phone it leases, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once). Only with --device.',
    )
    .option(
      '--no-wait',
      "Install on a phone another workspace leases instead of waiting: this run takes no lease and, when both workspaces build the same app id, the install terminates the holder's running app. Only with --device.",
    )
    .action(async (opts: IosCommandOptions) => {
      const root = (deps.findProjectRoot ?? DEFAULT_DEPS.findProjectRoot)(process.cwd());
      const run = (progress?: BuildProgress) =>
        runIos({ ...opts, waitConflict: waitFlagConflict(process.argv) }, deps, progress);
      const completion = root
        ? await withWorkspaceProcessLock(
            workspaceDir(root),
            'native-run',
            async (claim) => {
              recordWorkspaceUse(root);
              const progress = startBuildProgress({
                root,
                platform: PLATFORM,
                slot: opts.slot ?? 'default',
                claim,
                note: (line) => writeNote(chalk.dim(line)),
              });
              try {
                return await run(progress);
              } finally {
                progress.clear();
              }
            },
            {
              external: true,
              waitMs: 30 * 60_000,
              declareSpawns: true,
            },
          )
        : await run();
      if (!completion) process.exit(1);
      else if (completion.uploadsAbandoned) exitAfterFlush(0);
    });
}

function explicitSchemeRefusal(root: string, scheme: string | undefined, isExpo: boolean, d: IosDeps): FailArgs | null {
  if (scheme === undefined) return null;
  if (!scheme.trim()) {
    return {
      code: 'STIM_BAD_ARG',
      message: '--scheme must name a non-empty shared Xcode app scheme.',
      remedy: 'Pass the exact scheme name shown by xcodebuild -list.',
    };
  }
  // An Expo project's ios/ can be regenerated before the build; that check runs in
  // acquireIosArtifact, after regeneration, instead of against this possibly-stale read.
  if (isExpo) return null;
  const project = d.discoverXcodeProject(root);
  if (project.error) return project.error;
  return d.resolveScheme(project, { scheme }).error ?? null;
}

function iosSlotLogFile(root: string, slot: string): string {
  return slot === 'default'
    ? buildLogFile(root)
    : join(workspaceLogsDir(root), `build-${deviceSlotFileKey('ios', slot)}.ndjson`);
}

function iosSlotDeps(d: IosDeps, slot: string): IosDeps {
  if (slot !== 'default') {
    const base = d;
    d = {
      ...base,
      ensureOwnedDevice: (args) => base.ensureOwnedDevice({ ...args, slot }),
      checkDeviceCapacity: (args) => base.checkDeviceCapacity({ ...args, slot }),
      selectFromPool: (args) => base.selectFromPool({ ...args, slot }),
      acquireRunLease: (args) => base.acquireRunLease({ ...args, slot }),
      runLease: (args) => base.runLease({ ...args, slot }),
      replaceCollector: (args) => base.replaceCollector({ ...args, slot }),
      stopPreviousCollector: (args) => base.stopPreviousCollector({ ...args, slot }),
      clearIosAdoptionPending: (root) => base.clearIosAdoptionPending(root, slot),
      writeWorkspaceLaunch: (root, platform, record) => base.writeWorkspaceLaunch(root, platform, record, slot),
      createWriter: (file, options) => base.createWriter(file, { ...options, fields: { slot } }),
    };
  }
  return d;
}

async function runIos(
  opts: IosCommandOptions = {},
  overrides: Partial<IosDeps> = {},
  progress: BuildProgress = NO_BUILD_PROGRESS,
): Promise<IosRunCompletion | null> {
  const slot = validateDeviceSlot(opts.slot);
  let d = iosSlotDeps({ ...DEFAULT_DEPS, ...overrides }, slot);
  const json = Boolean(opts.json);
  const metroCheck = opts.metroCheck !== false;
  let useBuildCache = opts.buildCache !== false;

  const phase = writePhase;
  const note = writeNote;

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const refuseProject = ({ message, remedy }: { message: string; remedy: string }): null => {
    note(chalk.red(phaseLine('error', message)));
    note(chalk.dim(phaseLine('remedy', remedy)));
    note(chalk.red(phaseLine('failed', 'STIM_NO_PROJECT')));
    if (json) console.log(JSON.stringify({ code: 'STIM_NO_PROJECT', message, remedy }));
    process.exitCode = 1;
    return null;
  };
  const foundRoot = d.findProjectRoot(process.cwd());
  if (!foundRoot) return refuseProject(NO_PROJECT_REFUSAL);
  const root = foundRoot;
  const projectProblem = appProjectProblem(root);
  if (projectProblem) return refuseProject(projectProblem);

  try {
    await d.ensureWorkspaceStorage(root, { note });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'STIM_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's Stim state: ${(error as Error)?.message || error}`;
    note(chalk.red(`${code}: ${message}`));
    note(
      chalk.dim(
        'Check that STIM_HOME is writable and has free space. An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (`stim guide errors sandbox`).',
      ),
    );
    if (json)
      console.log(JSON.stringify({ code, message, remedy: 'Check that STIM_HOME is writable and has free space.' }));
    process.exitCode = 1;
    return null;
  }

  const logsDir = workspaceLogsDir(root);
  const logFile = iosSlotLogFile(root, slot);
  let writer = null as NdjsonWriter | null;
  const logWriter = () => (writer ||= d.createWriter(logFile, { truncate: true }));

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
    } catch (e) {
      note(chalk.dim(`Could not release this run's device lease: ${(e as Error)?.message || e}`));
    }
  };

  const stats = createRunRecorder({
    platform: PLATFORM,
    write: (statsRun, at) => d.recordStats(statsRun, at),
    now: () => d.now(),
    note: (line) => note(chalk.dim(line)),
    phases: () => progress.durations(),
  });
  const recordRun = stats.record;

  let compilationCache: CompilationCacheActivity = COMPILATION_CACHE_NOT_RUN;
  let reclaimed: ReclaimedStep[] = [];

  const fail = ({ code, message, remedy = null, lines = [], logPath = null, build = null, lease }: FailArgs): null => {
    releaseLease();
    if (message) note(chalk.red(phaseLine('error', message)));
    for (const line of lines) note(chalk.dim(phaseLine('', line)));
    if (remedy) note(chalk.dim(phaseLine('remedy', remedy)));
    if (logPath) note(chalk.dim(phaseLine('log', logPath)));
    if (build)
      writeLastBuild(
        root,
        lastBuildRecord({ ...build, startedAt, status: 'failed', errorCode: code, durationMs: elapsed() }),
        { write: d.writeWorkspaceState },
      );
    note(chalk.red(phaseLine('failed', code)));
    recordRun({ failed: true, durationMs: elapsed() });
    if (json) {
      console.log(
        JSON.stringify({
          code,
          message: message ?? null,
          remedy: remedy ?? null,
          ...(compilationCache.status === 'not-run' ? {} : { compilationCache }),
          ...(lease === undefined ? {} : { lease }),
          ...(reclaimed.length ? { reclaimed } : {}),
        }),
      );
    }
    writer?.close?.();
    process.exitCode = 1;
    return null;
  };

  const settingsRepoRoot = d.repoRoot(root);
  const settingsContext = {
    projectPath: root,
    gitCommonDir: d.gitCommonDir(root),
    repoRoot: settingsRepoRoot,
  };
  const projectKey = statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsRepoRoot });
  stats.setProject(projectKey);
  let estimatesRead: RunEstimates | null = null;
  const estimates = (): RunEstimates => (estimatesRead ??= d.readEstimates({ projectKey, platform: PLATFORM }));
  const settings = d.resolveSettings(settingsContext);
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: shapeError,
      lines: moreShapeErrors,
      remedy: SETTING_SHAPE_REMEDY,
    });
  }
  let optimizations: Optimizations;
  try {
    optimizations = resolveOptimizations(settings);
  } catch (error) {
    return fail({ code: 'STIM_BAD_ARG', message: (error as Error).message, remedy: SETTING_SHAPE_REMEDY });
  }
  const buildProfile = optimizationBuildProfile('ios', optimizations);
  const cacheProviderConfig = d.resolveCacheProviderConfig(settingsContext);
  for (const key of unknownSettingKeys(settings)) {
    note(phaseLine('setting', chalk.yellow(`Warning: setting "${key}" is not read by Stim and will be ignored.`)));
  }
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) note(chalk.yellow(phaseLine('cache', `${cacheProviderError} Using the local cache.`)));

  const poolError = parkedMaxSetting('ios').error;
  if (poolError) return fail({ code: 'STIM_BAD_ARG', message: poolError, remedy: POOL_SETTING_REMEDY });

  for (const settingError of [
    iosSigningIdentitySettingError(settings),
    iosSigningIdentitySha1SettingError(settings),
    iosLanHostSettingError(settings),
  ]) {
    if (settingError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: settingError,
        remedy: SETTING_SHAPE_REMEDY,
      });
    }
  }

  const configuration = opts.easProfile !== undefined ? null : resolveConfiguration(opts.configuration, settings);
  const buildScheme = opts.scheme;
  const release = isReleaseConfiguration(configuration);
  const cachePolicy = artifactCachePolicy(optimizations, useBuildCache, release);
  useBuildCache = cachePolicy.read;

  const deviceType = resolveDeviceType(opts.deviceType, settings);
  const runtime = resolveRuntime(opts.runtime, settings);

  const deviceFlag = opts.device;
  const physical = isPhysicalDeviceRequest(deviceFlag);
  if (physical && deviceFlag === '') {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--device was given an empty UDID.',
      remedy:
        'Pass `--device` on its own to take the first connected device this workspace can lease, or ' +
        '`--device <udid>` to name one.',
    });
  }
  if (physical && opts.remote) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--device builds for a phone connected to this machine, and --remote installs on a remote one.',
      remedy: 'Pass only one of --device and --remote.',
    });
  }

  const noWait = opts.wait === false;
  const waitFlagged = opts.wait !== undefined;
  if (opts.waitConflict) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--wait and --no-wait ask for opposite things.',
      remedy: 'Pass `--wait <seconds>` to wait for the lease, or `--no-wait` to install without one.',
    });
  }
  if (waitFlagged && !physical) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--wait and --no-wait only apply to a `--device` run.',
      remedy: 'This workspace owns its simulator, so nothing contends for it. Drop the flag, or pass `--device`.',
    });
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : opts.wait);
  if ('error' in waitParsed) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: waitParsed.error,
      remedy: 'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a leased device at once.',
    });
  }
  const waitSeconds = waitParsed.seconds;

  const isExpo = d.detectIsExpo(root);
  const schemeRefusal = explicitSchemeRefusal(root, buildScheme, isExpo, d);
  if (schemeRefusal) return fail(schemeRefusal);
  const remoteBackend = physical ? null : (opts.remote ?? remoteIosSetting(settings));
  const viewer = resolveSimulatorAppFlag(opts.simulatorApp, physical, remoteBackend);
  if ('refusal' in viewer) return fail(viewer.refusal);
  const { simulatorApp } = viewer;
  const modelRefusal = deviceModelRefusal({
    slot,
    deviceTypeFlag: opts.deviceType,
    runtimeFlag: opts.runtime,
    deviceType,
    runtime,
    physical,
    remoteBackend,
    listRuntimes: d.listIosRuntimes,
  });
  if (modelRefusal) return fail(modelRefusal);
  const budget = await d.budgetGate({ root, note });
  reclaimed = budget.reclaimed;
  if (budget.refusal) return fail(budget.refusal);
  let remoteDevice: ReturnType<typeof d.remoteIosDeps> | null = null;
  if (remoteBackend) {
    const resolved = await d.resolveRemoteContext({
      root,
      backend: remoteBackend,
      easBin: d.resolveEasCliBin(root)?.file ?? null,
    });
    if ('failed' in resolved) {
      return fail({ code: resolved.code ?? REMOTE_SESSION_ERROR, message: resolved.failed, remedy: resolved.remedy });
    }
    remoteDevice = d.remoteIosDeps(resolved.ctx);
    d = {
      ...d,
      checkDeviceCapacity: remoteDevice.checkDeviceCapacity,
      ensureOwnedDevice: remoteDevice.ensureOwnedDevice,
      ensureBooted: remoteDevice.ensureBooted,
      installIosApp: remoteDevice.installIosApp,
      launchIosApp: remoteDevice.launchIosApp,
    };
  }

  const easBuild = await d.resolveEasDevelopmentBuild({
    root,
    platform: PLATFORM,
    profile: opts.easProfile,
    note,
    isExpo,
    physical,
    selectors: [opts.scheme, opts.configuration],
    buildCache: opts.buildCache,
  });
  if (isEasBuildFailure(easBuild)) return fail(easBuild);
  const registerProject = () => d.upsertProject(root, { bundleId: d.detectBundleId(root) ?? undefined, isExpo });
  if (remoteBackend !== 'eas') registerProject();
  const proj = d.getProject(root);

  const limits = d.getConcurrencyLimits();

  let physicalDevice: { udid: string; name: string } | null = null;
  let wireless = false;
  if (physical && typeof deviceFlag !== 'string') {
    const pooled = await d.selectFromPool({
      root,
      platform: PLATFORM,
      idLabel: 'udid',
      list: () =>
        iosPoolCandidates(d.listIosDevices()).map((entry) => ({
          id: entry.udid,
          name: entry.name,
          fallback: isWirelessIosDevice(entry),
        })),
      noCandidates: () => {
        const resolved = iosPoolNoCandidatesRefusal(d.listIosDevices());
        return { message: resolved.error as string, remedy: resolved.remedy as string };
      },
      waitSeconds,
      noWait,
      now: d.now,
      warn: (line: string) => note(chalk.yellow(phaseLine('lease', line))),
    });
    if (pooled.status === 'refused') {
      return fail({
        code: pooled.refusal.code,
        message: pooled.refusal.message,
        remedy: pooled.refusal.remedy,
        ...(pooled.refusal.lease === null ? {} : { lease: pooled.refusal.lease }),
      });
    }
    physicalDevice = { udid: pooled.candidate.id, name: pooled.candidate.name ?? pooled.candidate.id };
    wireless = pooled.candidate.fallback === true;
  } else if (physical) {
    const resolved = resolveIosPhysicalDevice(typeof deviceFlag === 'string' ? deviceFlag : null, d.listIosDevices());
    if (!resolved.udid) {
      return fail({ code: 'STIM_NO_DEVICE', message: resolved.error!, remedy: resolved.remedy! });
    }
    physicalDevice = { udid: resolved.udid, name: resolved.name ?? resolved.udid };
    wireless = resolved.wireless === true;
  }
  if (!physical) {
    const capacity = d.checkDeviceCapacity({
      platform: PLATFORM,
      project: proj,
      max: limits.maxDevices,
    });
    if (capacity) return fail(capacity);
  }

  let metroPort = proj?.metroPort ?? null;
  let lanAddress: string | null = null;
  let lanOriginUrl: string | null = null;
  let devServer: DevServerStart | null = null;
  if (!(await resolveMetroPort())) return null;

  let device: Awaited<ReturnType<typeof ensureOwnedDevice>>;
  if (physicalDevice) {
    device = { deviceUdid: physicalDevice.udid, deviceName: physicalDevice.name, owned: false } as Awaited<
      ReturnType<typeof ensureOwnedDevice>
    >;
  } else {
    const prepare = stepClock(d.now);
    try {
      device = await d.ensureOwnedDevice({
        platform: PLATFORM,
        project: proj,
        projectPath: root,
        settingsRoot: root,
        settings,
        flags: { deviceType, runtime, simulatorApp },
        note,
        out: note,
      });
    } catch (e) {
      return fail({
        code: 'STIM_NO_DEVICE',
        message: `Could not ensure an owned iOS simulator: ${(e as Error)?.message || e}`,
        remedy: 'Run `stim doctor` to check the simulator toolchain, then try again.',
      });
    }
    const prepareMs = prepare();
    if (device.created || prepareMs >= SLOW_STEP_MS) {
      phase(
        'device',
        `${deviceLabel(device, device.deviceUdid)} ${device.created ? 'created' : 'prepared'} (${formatDuration(prepareMs)})`,
      );
    }
  }

  let bootDuration = '';
  let bootPromise!: Promise<{ ok?: boolean; reason?: string; udid?: string } | null | undefined>;
  let udid = '';
  async function resolveMetroPort(): Promise<boolean> {
    if (release) {
      metroPort = null;
      phase('metro', `skipped (${configuration}: the JS bundle is embedded, no dev server is used)`);
    } else if (metroCheck) {
      const gate = await ensureDevServer({
        root,
        port: metroPort,
        settings,
        remote: Boolean(remoteDevice),
        note,
        resolve: d.resolveProjectMetro,
        start: d.startDevServer,
        readState: d.readWorkspaceState,
      });
      reclaimed = [...reclaimed, ...gate.reclaimed];
      if (!gate.ok) {
        fail({ code: gate.code, message: gate.message, remedy: gate.remedy, lines: gate.lines });
        return false;
      }
      metroPort = gate.port;
      devServer = gate.devServer;
    } else if (!metroPort) {
      metroPort = DEFAULT_METRO_PORT;
      note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${metroPort}.`));
    }
    if (physical && metroPort !== null && !(await resolveLanOrigin())) return false;
    if (remoteDevice && metroPort !== null) {
      const reachable = await d.ensureMetroReachable({
        ctx: remoteDevice.ctx,
        metroPort,
        isExpo,
        tunnelMode: tunnelModeSetting(settings) ?? undefined,
        publicUrl: publicUrlSetting(settings),
        available: d.detectProviders(binOnPath),
      });
      if ('failed' in reachable) {
        fail({
          code: reachable.code ?? REMOTE_SESSION_ERROR,
          message: reachable.failed,
          remedy: reachable.remedy,
        });
        return false;
      }
    }
    if (!release && metroCheck && optimizations.metroWarmup)
      void d.warmMetro({
        port: metroPort as number,
        platform: 'ios',
        isExpo,
        appId: proj?.bundleId,
        bundleUrl: metroWarmupUrlSetting(settings, 'ios'),
      });
    return true;
  }

  async function resolveLanOrigin(): Promise<boolean> {
    const port = metroPort as number;
    const pinned = iosLanHostSetting(settings);
    const candidates = d.hostLanCandidates();
    const chosen = chooseLanAddress({ pinned, candidates });
    if (!chosen) {
      fail({
        code: 'STIM_NO_LAN_ADDRESS',
        message:
          'A Debug run on a phone needs an address the phone can reach, and this Mac has no non-internal IPv4 interface.',
        remedy:
          'The phone reaches Metro over the network you share, because USB carries no reverse forward. ' +
          'Join a Wi-Fi or Ethernet network, or connect this Mac by cable, then run the command again.',
      });
      return false;
    }
    lanAddress = chosen.address;
    lanOriginUrl = lanOriginUrlFor(chosen.address, port);
    const source = chosen.pinned
      ? 'ios.lanHost'
      : `${chosen.interfaceName ?? 'interface'}${chosen.candidates > 1 ? ` of ${chosen.candidates} candidates` : ''}`;
    phase('lan', `${lanOriginUrl} (${source})`);
    if (publicUrlSetting(settings) || tunnelModeSetting(settings)) {
      note(
        chalk.dim(
          phaseLine(
            'lan',
            'metro.publicUrl and metro.tunnel are ignored on --device: neither channel to a phone carries a URL, ' +
              'only a host and a port. They still apply to --remote.',
          ),
        ),
      );
    }
    if (!metroCheck) return true;
    const reachable = await d.ensureLanReachable({
      origin: lanOriginUrl,
      metroPort: port,
      root,
      isExpo,
      logsDir,
    });
    if ('failed' in reachable) {
      fail({ code: 'STIM_LAN_METRO_UNREACHABLE', message: reachable.failed, remedy: reachable.remedy });
      return false;
    }
    phase('lan', `gated: ${lanOriginUrl} answered as this workspace's Metro`);
    return true;
  }

  let artifact: PreparedIosArtifact | null = null;
  try {
    const bootTimer = stepTimer(d.now);
    const boot = (): Promise<IosBootLike> =>
      physicalDevice
        ? Promise.resolve({ ok: true, udid: physicalDevice.udid })
        : Promise.resolve(d.ensureBooted({ platform: PLATFORM, device, simulatorApp, out: note })).catch((e) => ({
            ok: false,
            reason: String((e as Error)?.message || e),
          }));
    bootPromise = (
      remoteDevice?.ctx.backend === 'eas'
        ? d.ensureRemoteBootOwned({
            root,
            platform: PLATFORM,
            sessionName: ownedSessionName(remoteDevice.ctx.label),
            startedAt,
            boot,
            createdSessionId: remoteDevice.createdSessionId,
            abandonCreatedSession: remoteDevice.abandonCreatedSession,
            webPreviewUrl: remoteDevice.webPreviewUrl,
            writeState: d.writeWorkspaceState,
            register: registerProject,
          })
        : boot()
    ).then((result) => {
      bootDuration = bootTimer();
      return result;
    });
    udid = (device.deviceUdid as string | undefined) ?? (await bootPromise)?.udid ?? '';
    const acquiredArtifact = await acquireIosArtifact(
      {
        root,
        logFile,
        udid,
        configuration,
        buildScheme,
        buildProfile,
        isExpo,
        remoteDestination: Boolean(remoteDevice),
        device: physical
          ? {
              lanAddress,
              metroPort,
              signingName: iosSigningIdentitySetting(settings),
              signingSha1: iosSigningIdentitySha1Setting(settings),
            }
          : null,
        optimizations: optimizations.ios,
        cache: { policy: cachePolicy, providerConfig: cacheProviderConfig, disabledByFlag: opts.buildCache === false },
        easBuild,
        easProfile: opts.easProfile,
        maxBuilds: limits.maxBuilds,
        progress: { phase, note, logWriter, estimates, stats, step: progress.step },
      },
      d,
    );
    if (!acquiredArtifact.ok) {
      compilationCache = acquiredArtifact.compilationCache;
      return fail(acquiredArtifact.failure);
    }
    artifact = acquiredArtifact.artifact;
    compilationCache = artifact.cache.compilation;

    if (physicalDevice) {
      const acquired = await d.acquireRunLease({
        root,
        platform: PLATFORM,
        id: physicalDevice.udid,
        deviceName: physicalDevice.name,
        idLabel: 'udid',
        waitSeconds,
        noWait,
        installBoundMs: iosDeviceBounds(wireless).installMs,
        appId: artifact.bundleId ?? proj?.bundleId ?? null,
        holderAppId: (holder: string) => d.getProject(holder)?.bundleId ?? null,
        now: d.now,
        warn: (line: string) => note(chalk.yellow(phaseLine('lease', line))),
      });
      if (acquired.status === 'refused') {
        return fail({
          code: acquired.refusal.code,
          message: acquired.refusal.message,
          remedy: acquired.refusal.remedy,
          lease: acquired.refusal.lease,
        });
      }
      leaseHandle = d.runLease({
        root,
        platform: PLATFORM,
        kind: acquired.status === 'leased' ? acquired.kind : null,
        expiresAt: acquired.status === 'leased' ? acquired.expiresAt : null,
      });
      if (acquired.status === 'leased') {
        stopLeaseSignals = d.releaseLeaseOnSignal(releaseLease);
        phase(
          'lease',
          `${acquired.kind} lease on ${physicalDevice.udid} until ${leaseExpiryText(acquired.expiresAt, d.now())}`,
        );
      }
    }

    try {
      return await finishIosRun({
        slot,
        d,
        root,
        json,
        release,
        configuration,
        buildScheme,
        isExpo,
        metroCheck,
        metroPort,
        logsDir,
        logFile,
        device,
        udid,
        physical,
        wireless,
        lanAddress,
        lanOriginUrl,
        remoteDevice,
        bootPromise,
        bootDuration: () => bootDuration,
        artifact,
        fail,
        phase,
        note,
        logWriter,
        elapsed,
        startedAt,
        closeWriter: () => writer?.close?.(),
        lease: leaseHandle,
        releaseLease,
        recordRun,
        reclaimed,
        devServer,
        enterPhase: progress.step,
      });
    } finally {
      releaseLease();
    }
  } catch (error) {
    recordRun({ failed: true, durationMs: elapsed() });
    throw error;
  } finally {
    artifact?.release();
  }
}
