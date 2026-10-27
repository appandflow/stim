import type { IosArtifactContext, IosProject } from '../integrations/ios-project.ts';
import { simulatorRuntime } from '../offload/client.ts';
import type { RuntimePreparationError, RuntimePreparationResult } from '../engine/runtime-plan.ts';
import { writeDevicePlacementAsync } from '../device-host/ios-state.ts';
import type { DevicePlacement } from '@stim-cli/core/state';
import { hostedMetroSettings } from '../device-host/metro-request.ts';
import { devClientPortBusy } from '../device-host/hosted-native.ts';
import { type StimContext, workspaceId } from '@stim-cli/core';
import { exitAfterFlush, runProcessOperation } from '../cli-operation.ts';
import { acquireIosArtifact, type PreparedIosArtifact } from './ios/artifact.ts';
import { isEasBuildFailure } from '../engine/eas-build.ts';
import { deviceSlotFileKey, parseDeviceSlotOption, validateDeviceSlot } from '../devices/device-slots.ts';
import { cancelledFailure, runCancellation, runCancellationSignal, withNativeBuildRun } from '../engine/native-run.ts';
import {
  NO_BUILD_PROGRESS,
  runFailureRecord,
  startBuildProgress,
  tapBuildLog,
  thrownRunFailureRecord,
  type BuildProgress,
} from '../engine/build-progress.ts';
import { join } from 'node:path';
import { artifactCachePolicy, optimizationBuildProfile } from '../optimizations.ts';
import { type Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { formatDuration, phaseLine, SLOW_STEP_MS, stepClock, stepTimer } from '../command-output.ts';
import { waitFlagConflict, leaseExpiryText, type RunLease } from '../engine/device-lease-run.ts';
import { parseMachine } from '@stim-cli/core/state';
import {
  connectIosBackend,
  deviceRemoteConflict,
  iosPlacementBudget,
  hostedIosMetroNote,
  connectIosTarget,
  hostedIosSelectors,
  selectIosPlacement,
} from './ios/remote.ts';
import { finishHostedIosRun } from './ios/hosted.ts';
import type { CompilationCacheActivity, DevServerStart } from '../engine/build-facts.ts';
import {
  deviceReclaimIdleMinutesSetting,
  iosLanHostSetting,
  iosLanHostSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  metroWarmupUrlSetting,
  publicUrlSetting,
  SETTING_SHAPE_REMEDY,
  metroPortSetting,
  projectSettingsContextAsync,
  tunnelModeSetting,
} from '../workspace/settings.ts';
import type { IosCommandOptions, IosBootLike, FailArgs, BuildFailureFields } from './ios/types.ts';
import { type IosDeps, DEFAULT_DEPS } from './ios/dependencies.ts';
import { DEFAULT_METRO_PORT } from '../engine/app-install.ts';
import { createIosSimSnapshot } from '../devices/ios.ts';
import { didSetUpDevice, ensureOwnedDevice } from '../engine/device.ts';
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
import { setRemoteLogSink } from '../remote-log.ts';
import { parseBuildMachineOption } from '../offload/selection.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { ReclaimedStep } from '../budget.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { recordWorkspaceUseAsync } from '../workspace/workspace-state.ts';
import { printLightenedFailure, restoreLightenedDependencies } from '../workspace/lightened.ts';
import { NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { ensureDevServer, isPhysicalDeviceRequest, type MobileRuntimePreparation } from './native-runtime.ts';
import {
  PLATFORM,
  buildLogFile,
  deviceLabel,
  resolveConfiguration,
  resolveDeviceType,
  resolveSchemeSelection,
  resolveRuntime,
  resolveSimulatorAppFlag,
  resolveIosWait,
  createIosDeviceWaitRun,
  deviceModelRefusal,
  iosProjectPathError,
  isReleaseConfiguration,
  ownedSimFailure,
  resolveIosBuildSetup,
  simulatorBuildArch,
} from './ios/support.ts';
import { iosLedgerDevice, lastBuildRecord, writeLastBuild } from './ios/result.ts';
import type { BuildLedgerExtras } from '../engine/build-ledger.ts';
import { finishIosRun, type IosRunCompletion } from './ios/launch.ts';
import { planIos } from './ios/next-build.ts';

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

export default function iosCommand(program: Command): void {
  registerIos(program);
}

export function registerIos(program: Command, deps: Partial<IosDeps> = {}): void {
  program
    .command('ios')
    .description(
      "Build (or restore from the fingerprint cache), install and launch this workspace's app on its owned " +
        'simulator. React Native and Expo Debug runs start the dev server when it is not running.',
    )
    .option(
      '--eas-profile <name>',
      'Download a matching EAS development build; on a miss, print the build command without running it',
    )
    .option('--slot <name>', 'Reusable device slot within this workspace (default: default)', parseDeviceSlotOption)
    .option(
      '--remote-build <value>',
      'Build on local, auto, remote (remote machines first), remote-only (never here), or one named machine; a name refuses without fallback',
      parseBuildMachineOption,
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option(
      '--plan',
      'Predict the next build without building, booting or installing: resolve the fingerprint, check the local ' +
        'then remote cache, and print the expected cache result and duration. Writes no Stim state.',
    )
    .option(
      '--scheme <name>',
      'Shared Xcode app scheme to build; overrides automatic scheme selection, not the app URL scheme',
    )
    .option(
      '--no-metro-check',
      'Skip the "is this workspace\'s dev server running?" check: do not start it, and build anyway',
    )
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
      '--remote <target>',
      'Run on eas, proxy, or an approved Mac in remote.machines; named Macs never fall back locally. auto places on an approved Mac when this machine is full or busy. remote tries remote.machines in order first and runs here only when none takes it. remote-only never runs here. local runs here, whatever ios.remote says.',
      (value) => {
        if (parseMachine(value)) return value.trim();
        throw new InvalidArgumentError('expected eas, proxy, local, auto, remote, remote-only, or a remote Mac name');
      },
    )
    .option(
      '--wait <seconds>',
      'How long to wait for another workspace to release the phone it leases, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once). Without --device, wait for an owned-device slot (default 600 seconds; --no-wait refuses immediately).',
    )
    .option(
      '--no-wait',
      "Install on a phone another workspace leases instead of waiting: this run takes no lease and, when both workspaces build the same app id, the install terminates the holder's running app. Without --device, refuse a full device cap or existing slot queue immediately.",
    )
    .action(async (opts: IosCommandOptions) => {
      if (opts.plan) {
        const d = { ...DEFAULT_DEPS, ...deps };
        await planIos(opts, d);
        return;
      }
      const root = (deps.findProjectRoot ?? DEFAULT_DEPS.findProjectRoot)(process.cwd());
      const { value: completion, interrupted } = await runProcessOperation(root ?? process.cwd(), (context) =>
        runIosOperation(context, root, { ...opts, waitConflict: waitFlagConflict(process.argv) }, deps),
      );
      if (!completion) process.exit(interrupted ?? 1);
      else if (completion.uploadsAbandoned) exitAfterFlush(0);
    });
}

export function runIosOperation(
  context: StimContext,
  root: string | null,
  opts: IosCommandOptions = {},
  deps: Partial<IosDeps> = {},
  onFailure: (error: FailArgs) => void = () => {},
): Promise<IosRunCompletion | null> {
  const run = (progress?: BuildProgress) => runIos(context, root, opts, deps, progress, onFailure);
  return root
    ? withNativeBuildRun(
        context,
        root,
        { command: 'ios', platform: PLATFORM, slot: opts.slot ?? 'default' },
        async (claim) => {
          const lightened = await restoreLightenedDependencies(root, context);
          if (lightened) {
            printLightenedFailure(context, lightened, Boolean(opts.json));
            onFailure(lightened);
            return null;
          }
          await recordWorkspaceUseAsync(root, new Date(), context.env, context.cwd, context.signal);
          const progress = startBuildProgress({
            root,
            platform: PLATFORM,
            slot: opts.slot ?? 'default',
            claim,
            note: (line) => context.output('stderr', `${chalk.dim(line)}\n`),
          });
          try {
            return await run(progress);
          } finally {
            progress.clear();
          }
        },
        { write: (line) => context.output('stderr', `${chalk.dim(phaseLine('lock', line))}\n`) },
      )
    : run();
}

function unlessCancelled(
  context: StimContext,
  result: Awaited<ReturnType<typeof acquireIosArtifact>>,
): Awaited<ReturnType<typeof acquireIosArtifact>> {
  if (!result.ok || !runCancellation(context)) return result;
  return {
    ok: false,
    failure: { code: 'STIM_CANCELLED', message: 'before install' },
    compilationCache: result.artifact.cache.compilation,
  };
}

function iosProjectTargetRefusal(
  project: IosProject,
  {
    physical,
    easProfile,
    placement,
  }: {
    physical: boolean;
    easProfile?: string;
    placement?: { machine: string | null; backend: string | null };
  },
): FailArgs | null {
  const target = physical
    ? 'physical'
    : placement
      ? placement.machine
        ? 'hosted'
        : placement.backend
          ? 'remote'
          : 'simulator'
      : null;
  if (target && !project.targets.includes(target))
    return {
      code: 'STIM_BAD_ARG',
      message: `This project integration does not support the ${target} iOS target.`,
      remedy: 'Use a local iOS simulator for this integration.',
    };
  if (easProfile !== undefined && !project.eas)
    return {
      code: 'STIM_BAD_ARG',
      message: 'This project integration does not support EAS builds.',
      remedy: 'Use its local iOS build recipe.',
    };
  return null;
}

function iosArtifactTargetInputs({
  udid,
  physical,
  remote,
  hosted,
  simulatorArch,
  lanAddress,
  metroPort,
  settings,
}: {
  udid: string;
  physical: boolean;
  remote: boolean;
  hosted: Awaited<ReturnType<IosDeps['prepareHostedIos']>> | null;
  simulatorArch: IosArtifactContext['target']['arch'];
  lanAddress: string | null;
  metroPort: number | null;
  settings: ReturnType<IosDeps['resolveSettings']>;
}): Pick<IosArtifactContext, 'target' | 'device'> {
  return {
    target: {
      udid,
      destination: remote || hosted ? 'generic/platform=iOS Simulator' : null,
      sdk: physical ? 'iphoneos' : 'iphonesimulator',
      arch: remote || hosted ? simulatorArch : null,
      keyArch: simulatorArch,
      offloadRuntime: () => hosted?.choice.runtimeId ?? (remote ? null : simulatorRuntime(udid)),
      hostedArchitecture: hosted?.choice.architecture,
      offloadRefusal: physical ? 'device builds build here' : remote ? '--remote builds build here' : null,
    },
    device: physical
      ? {
          udid,
          lanAddress,
          metroPort,
          signingName: iosSigningIdentitySetting(settings),
          signingSha1: iosSigningIdentitySha1Setting(settings),
        }
      : null,
  };
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
      ensureBooted: (args) => base.ensureBooted({ ...args, slot }),
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
  context: StimContext,
  projectRoot: string | null,
  opts: IosCommandOptions = {},
  overrides: Partial<IosDeps> = {},
  progress: BuildProgress = NO_BUILD_PROGRESS,
  onFailure: (error: FailArgs) => void,
): Promise<IosRunCompletion | null> {
  const slot = validateDeviceSlot(opts.slot);
  let d = iosSlotDeps({ ...DEFAULT_DEPS, ...overrides }, slot);
  const json = Boolean(opts.json);
  const metroCheck = opts.metroCheck !== false;

  const note = (line: string) => context.output('stderr', `${line}\n`);
  const phase = (name: unknown, text: string) => note(phaseLine(name, text));
  const emit = (line: string) => context.output('stdout', `${line}\n`);

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const refuseProject = ({ message, remedy }: { message: string; remedy: string }): null => {
    note(chalk.red(phaseLine('error', message)));
    note(chalk.dim(phaseLine('remedy', remedy)));
    note(chalk.red(phaseLine('failed', 'STIM_NO_PROJECT')));
    if (json) emit(JSON.stringify({ code: 'STIM_NO_PROJECT', message, remedy }));
    onFailure({ code: 'STIM_NO_PROJECT', message, remedy });
    return null;
  };
  if (!projectRoot) return refuseProject(NO_PROJECT_REFUSAL);
  const root = projectRoot;
  const selectedProject = d.projectRegistry.selectIos(root);
  if ('problem' in selectedProject) return refuseProject(selectedProject.problem);

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
    if (json) emit(JSON.stringify({ code, message, remedy: 'Check that STIM_HOME is writable and has free space.' }));
    onFailure({ code, message, remedy: 'Check that STIM_HOME is writable and has free space.' });
    return null;
  }

  const logsDir = workspaceLogsDir(root);
  const logFile = iosSlotLogFile(root, slot);
  let writer = null as NdjsonWriter | null;
  const logWriter = () =>
    (writer ||= tapBuildLog(
      d.createWriter(logFile, { truncate: true, fields: { platform: PLATFORM, slot } }),
      progress,
    ));

  setRemoteLogSink(context, (record) => logWriter().write(record));
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
    deviceSetup: () => progress.deviceSetupKnown(),
  });
  const deviceWaitRun = createIosDeviceWaitRun(stats, progress, runCancellationSignal(context));
  const recordRun = deviceWaitRun.record;

  let compilationCache: CompilationCacheActivity = COMPILATION_CACHE_NOT_RUN;
  let reclaimed: ReclaimedStep[] = [];
  let buildMachine = 'auto';
  let devicePlacement: DevicePlacement | undefined;
  let builtConfiguration: string | null = null;
  let acquiredBuild: BuildFailureFields | null = null;

  let builtScheme: string | undefined;
  let builtDevice: BuildLedgerExtras['device'] = null;
  const recordFailedBuild = (
    build: BuildFailureFields,
    errorCode?: string,
    why: { message?: string | null; remedy?: string | null } = {},
  ) =>
    writeLastBuild(
      root,
      lastBuildRecord({
        ledger: { scheme: builtScheme, device: builtDevice, message: why.message, remedy: why.remedy },
        devicePlacement,
        buildMachine,
        ...build,
        configuration: builtConfiguration,
        startedAt,
        status: 'failed',
        errorCode,
        durationMs: elapsed(),
      }),
    );

  const fail = ({
    retainedClaimRoots,
    code,
    message,
    remedy = null,
    lines = [],
    logPath = null,
    build = null,
    lease,
    setup = false,
  }: FailArgs): null => {
    ({ code, message, remedy, lines } = cancelledFailure(context, PLATFORM, { code, message }) ?? {
      code,
      message,
      remedy,
      lines,
    });
    releaseLease();
    if (message) note(chalk.red(phaseLine('error', message)));
    for (const line of lines) note(chalk.dim(phaseLine('', line)));
    if (remedy) note(chalk.dim(phaseLine('remedy', remedy)));
    if (logPath) note(chalk.dim(phaseLine('log', logPath)));
    const failedBuild = build ?? acquiredBuild;
    if (failedBuild) recordFailedBuild(failedBuild, code, { message, remedy });
    if (acquiredBuild) logWriter().write(runFailureRecord({ code, message, phase: progress.phase() }));
    note(chalk.red(phaseLine('failed', code)));
    if (!setup) recordRun({ failed: true, durationMs: elapsed() });
    if (json) {
      emit(
        JSON.stringify({
          code,
          message: message ?? null,
          remedy: remedy ?? null,
          ...(devicePlacement ? { devicePlacement } : {}),
          ...(compilationCache.status === 'not-run' ? {} : { compilationCache }),
          ...(lease === undefined ? {} : { lease }),
          ...(reclaimed.length ? { reclaimed } : {}),
        }),
      );
    }
    writer?.close?.();
    onFailure({
      code,
      message,
      remedy,
      lines,
      logPath,
      build,
      lease,
      setup,
      ...(retainedClaimRoots ? { retainedClaimRoots } : {}),
    });
    return null;
  };

  const settingsSignal = runCancellationSignal(context) ?? context.signal;
  let settingsContext: Awaited<ReturnType<typeof projectSettingsContextAsync>>;
  try {
    settingsContext = await projectSettingsContextAsync(root, d, { env: context.env, signal: settingsSignal });
  } catch (error) {
    if (!settingsSignal.aborted) throw error;
    return fail({ code: 'STIM_CANCELLED', message: 'before resolving project settings', setup: true });
  }
  const projectKey = statsProjectKey({
    root,
    commonDir: settingsContext.gitCommonDir,
    repoRoot: settingsContext.repoRoot,
  });
  stats.setProject(projectKey);
  progress.estimate(projectKey);
  let estimatesRead: RunEstimates | null = null;
  const estimates = (): RunEstimates => (estimatesRead ??= d.readEstimates({ projectKey, platform: PLATFORM }));
  const settings = d.resolveSettings(settingsContext);
  const setup = resolveIosBuildSetup(
    opts.remoteBuild,
    settings,
    (label, message) => note(phaseLine(label, chalk.yellow(message))),
    context.env,
  );
  if (!setup.ok) return fail(setup.failure);
  buildMachine = setup.buildMachine;
  const { optimizations } = setup;
  const buildProfile = optimizationBuildProfile('ios', optimizations);
  const cacheProviderConfig = d.resolveCacheProviderConfig(settingsContext);

  const poolError = parkedMaxSetting('ios').error;
  if (poolError) return fail({ code: 'STIM_BAD_ARG', message: poolError, remedy: POOL_SETTING_REMEDY });

  for (const settingError of [
    iosSigningIdentitySettingError(settings),
    iosSigningIdentitySha1SettingError(settings),
    iosLanHostSettingError(settings),
    iosProjectPathError(settings, root, () => d.detectIsExpo(root)),
  ]) {
    if (settingError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: settingError,
        remedy: SETTING_SHAPE_REMEDY,
      });
    }
  }
  const integration = await selectedProject.load(settings);

  const configuration = opts.easProfile !== undefined ? null : resolveConfiguration(opts.configuration, settings);
  builtConfiguration = configuration ?? 'Debug';
  const buildScheme = resolveSchemeSelection(opts, settings);
  builtScheme = buildScheme;
  const release = isReleaseConfiguration(configuration);
  const appMode = ({ metro: 'development', process: 'process', 'embedded-js': 'release' } as const)[
    integration.runtimeKind(configuration)
  ];
  const cachePolicy = artifactCachePolicy(
    optimizations,
    opts.buildCache !== false,
    integration.runtimeKind(configuration) === 'embedded-js',
  );

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
  const remoteConflict = deviceRemoteConflict(opts.remote, physical);
  if (remoteConflict) return fail(remoteConflict);

  const wait = resolveIosWait(opts, physical);
  if ('failure' in wait) return fail(wait.failure);
  const { waitSeconds, noWait, deviceSlotWaitMs, checkCapacity } = wait;
  const deviceSlotWait = {
    automatic: false,
    waitMs: deviceSlotWaitMs,
    reclaimIdleMinutes: deviceReclaimIdleMinutesSetting(settings),
    ...deviceWaitRun.policy,
    onWait: (ms: number) => {
      deviceWaitRun.policy.onWait?.(ms);
      if (devicePlacement?.decision === 'local' && ms > 0) devicePlacement.decision = 'waited-locally';
    },
  };

  const isExpo = integration.isExpo;
  const schemeRefusal = await integration.schemeProblem(buildScheme, configuration);
  if (schemeRefusal) return fail(schemeRefusal);
  const capabilityRefusal = iosProjectTargetRefusal(integration, { physical, easProfile: opts.easProfile });
  if (capabilityRefusal) return fail(capabilityRefusal);
  const simSnapshot = createIosSimSnapshot();
  const remoteSelection = await selectIosPlacement({
    root,
    env: context.env,
    operation: context,
    slot,
    opts,
    settings,
    physical,
    release,
    appMode,
    supportsRemote: integration.targets.includes('remote'),
    metroCheck,
    d,
    deviceType,
    runtime,
    validateSelectors: () =>
      deviceModelRefusal({
        slot,
        deviceTypeFlag: opts.deviceType,
        runtimeFlag: opts.runtime,
        deviceType,
        runtime,
        physical,
        remoteBackend: null,
        deviceTypeOrigin: d.settingOriginScope(d.settingsLayers(settingsContext), 'ios.deviceType'),
        runtimeOrigin: d.settingOriginScope(d.settingsLayers(settingsContext), 'ios.runtime'),
        listRuntimes: d.listIosRuntimes,
        signal: context.signal,
        snapshot: simSnapshot,
      }),
    simSnapshot,
    noWait: deviceSlotWaitMs === 0,
    waitMs: deviceSlotWaitMs,
    note,
    phase,
    log: (entry) => logWriter().write(entry),
  });
  if ('failure' in remoteSelection) return fail(remoteSelection.failure);
  deviceSlotWait.automatic = Boolean(remoteSelection.auto);
  const targetRefusal = iosProjectTargetRefusal(integration, { physical, placement: remoteSelection });
  if (targetRefusal) return fail(targetRefusal);
  devicePlacement = remoteSelection.devicePlacement;
  await writeDevicePlacementAsync(root, slot, PLATFORM, devicePlacement);
  const { machine: hostedMachine, backend: remoteBackend } = remoteSelection;
  const viewer = resolveSimulatorAppFlag(
    opts.simulatorApp,
    physical,
    hostedMachine ?? remoteBackend,
    Boolean(remoteSelection.auto),
  );
  if ('refusal' in viewer) return fail(viewer.refusal);
  const { simulatorApp } = viewer;
  const settingsLayersForOrigin = d.settingsLayers(settingsContext);
  const modelRefusal = await deviceModelRefusal({
    slot,
    deviceTypeFlag: opts.deviceType,
    runtimeFlag: opts.runtime,
    deviceType,
    runtime,
    deviceTypeOrigin: d.settingOriginScope(settingsLayersForOrigin, 'ios.deviceType'),
    runtimeOrigin: d.settingOriginScope(settingsLayersForOrigin, 'ios.runtime'),
    physical,
    remoteBackend,
    hosted: Boolean(hostedMachine),
    listRuntimes: d.listIosRuntimes,
    signal: context.signal,
    snapshot: simSnapshot,
  });
  if (modelRefusal) return fail(modelRefusal);
  const selectors = hostedIosSelectors(deviceType, runtime);
  const connected = await connectIosTarget(remoteSelection, selectors, d, appMode);
  if ('failure' in connected) return fail(connected.failure);
  const hostedTarget = connected.target;
  try {
    const budget = await iosPlacementBudget(
      d,
      root,
      note,
      Boolean(hostedTarget),
      remoteSelection.budget,
      simSnapshot,
      context.env,
    );
    reclaimed = budget.reclaimed;
    if (budget.refusal) return fail(budget.refusal);
    const backendConnection = await connectIosBackend(root, remoteBackend, opts.deviceType, d, context.env, context);
    if ('failure' in backendConnection) return fail(backendConnection.failure);
    const remoteDevice = backendConnection.remote;
    const remoteArch = hostedTarget ? hostedTarget.choice.architecture : backendConnection.arch;
    if (remoteDevice)
      d = {
        ...d,
        checkDeviceCapacity: remoteDevice.checkDeviceCapacity,
        ensureOwnedDevice: remoteDevice.ensureOwnedDevice,
        ensureBooted: remoteDevice.ensureBooted,
        installIosApp: async (args) => remoteDevice.installIosApp(args),
        launchIosApp: async (args) => remoteDevice.launchIosApp(args),
      };

    const easBuild = await d
      .resolveEasDevelopmentBuild({
        context,
        root,
        platform: PLATFORM,
        profile: opts.easProfile,
        note,
        isExpo,
        physical,
        selectors: [opts.scheme, opts.configuration],
        buildCache: opts.buildCache,
        env: context.env,
        signal: settingsSignal,
      })
      .catch((error) => {
        const cancelled = cancelledFailure(context, PLATFORM, { code: 'STIM_CANCELLED', message: 'during EAS lookup' });
        if (cancelled) return { ok: false as const, ...cancelled };
        throw error;
      });
    if (isEasBuildFailure(easBuild)) return fail(easBuild);
    const registerProject = async () =>
      d.upsertProject(root, { bundleId: (await integration.bundleId()) ?? undefined, isExpo });
    if (remoteBackend !== 'eas') await registerProject();
    const proj = d.getProject(root);

    const limits = d.getConcurrencyLimits();

    let physicalDevice: { udid: string; name: string } | null = null;
    let wireless = false;
    if (physical && typeof deviceFlag !== 'string') {
      const pooled = await d.selectFromPool({
        root,
        platform: PLATFORM,
        idLabel: 'udid',
        list: async () =>
          iosPoolCandidates(await d.listIosDevices()).map((entry) => ({
            id: entry.udid,
            name: entry.name,
            fallback: isWirelessIosDevice(entry),
          })),
        noCandidates: async () => {
          const resolved = iosPoolNoCandidatesRefusal(await d.listIosDevices());
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
      const resolved = resolveIosPhysicalDevice(
        typeof deviceFlag === 'string' ? deviceFlag : null,
        await d.listIosDevices(),
      );
      if (!resolved.udid) {
        return fail({ code: 'STIM_NO_DEVICE', message: resolved.error!, remedy: resolved.remedy! });
      }
      physicalDevice = { udid: resolved.udid, name: resolved.name ?? resolved.udid };
      wireless = resolved.wireless === true;
    }
    if (checkCapacity && !hostedTarget) {
      const capacity = await d.checkDeviceCapacity({
        platform: PLATFORM,
        project: proj,
        max: limits.maxDevices,
        sims: () => simSnapshot.read().filter((sim) => sim.available),
      });
      if (capacity) {
        if (capacity.code === 'STIM_AT_CAPACITY') {
          d.recordCapacityRefusal(
            { platform: PLATFORM, max: limits.maxDevices, workspace: workspaceId(root) },
            d.now(),
          );
        }
        return fail(capacity);
      }
    }

    let metroPort = proj?.metroPort ?? null;
    let lanAddress: string | null = null;
    let lanOriginUrl: string | null = null;
    let devServer: DevServerStart | null = null;
    const appRuntime = composeRuntime();
    const preparation = await appRuntime.prepare();
    if (!preparation.ok) return fail(preparation.error);
    const runtimePreparation = preparation.prepared;
    metroPort = runtimePreparation.metroPort;

    let device: Awaited<ReturnType<typeof ensureOwnedDevice>>;
    if (physicalDevice) {
      device = { deviceUdid: physicalDevice.udid, deviceName: physicalDevice.name, owned: false } as Awaited<
        ReturnType<typeof ensureOwnedDevice>
      >;
    } else if (hostedTarget) {
      device = { owned: false, deviceName: hostedTarget.choice.deviceType, runtime: hostedTarget.choice.runtime };
    } else {
      const prepare = stepClock(d.now);
      try {
        device = await d.ensureOwnedDevice({
          platform: PLATFORM,
          project: proj,
          projectPath: root,
          settingsRoot: root,
          settings,
          flags: { deviceSlotWait, deviceType, runtime, runtimeFlag: resolveRuntime(opts.runtime, null), simulatorApp },
          note,
          out: note,
          simSnapshot,
        });
      } catch (e) {
        return fail(ownedSimFailure(e));
      }
      deviceWaitRun.booting(device.booting);
      progress.deviceSetup(didSetUpDevice(device, Boolean(remoteDevice)));
      const prepareMs = prepare();
      if (device.created || prepareMs >= SLOW_STEP_MS) {
        phase(
          'device',
          `${deviceLabel(device, device.deviceUdid)} ${device.created ? 'created' : 'prepared'} (${formatDuration(prepareMs)})`,
        );
      }
    }

    builtDevice = iosLedgerDevice(device);
    let bootDuration = '';
    let bootPending = false;
    let bootPromise!: Promise<{ ok?: boolean; reason?: string; udid?: string } | null | undefined>;
    let udid = '';
    function composeRuntime() {
      return (
        d.runtimePlan ??
        integration.runtime({
          configuration,
          prepareMetro,
          prepareEmbedded: async () => {
            phase('metro', `skipped (${configuration}: the JS bundle is embedded, no dev server is used)`);
            hostedIosMetroNote(Boolean(hostedTarget), settings, note, opts.simulatorApp);
            return { ok: true, prepared: { metroPort: null } };
          },
        })
      );
    }

    async function prepareMetro(): Promise<RuntimePreparationResult<MobileRuntimePreparation>> {
      if (metroCheck) {
        const hostedPorts =
          hostedTarget && isExpo && d.hasDevClient(root)
            ? {
                machine: hostedTarget.host.machine,
                free: d.hostedMetroPortProbe(hostedTarget.host.machine, note),
                busy: (port: number) => devClientPortBusy(hostedTarget.host.machine, port),
              }
            : undefined;
        const gate = await ensureDevServer({
          env: context.env,
          root,
          port: metroPort,
          settings: hostedMetroSettings(settings, Boolean(hostedTarget)),
          settingsContext,
          remote: Boolean(remoteDevice),
          hostedPorts,
          note,
          resolve: d.resolveProjectMetro,
          start: d.startDevServer,
          readState: d.readWorkspaceState,
        });
        reclaimed = [...reclaimed, ...gate.reclaimed];
        if (!gate.ok) {
          return {
            ok: false,
            error: {
              code: gate.code,
              message: gate.message,
              remedy: gate.remedy,
              lines: gate.lines,
              ...(gate.retainedClaimRoots ? { retainedClaimRoots: gate.retainedClaimRoots } : {}),
            },
          };
        }
        metroPort = gate.port;
        devServer = gate.devServer;
        if (hostedPorts && !(await hostedPorts.free(gate.port)))
          return { ok: false, error: devClientPortBusy(hostedPorts.machine, gate.port) };
      } else {
        const pin = metroPortSetting(settings, context.env);
        if (pin.error) {
          return { ok: false, error: { code: 'STIM_BAD_ARG', message: pin.error, remedy: SETTING_SHAPE_REMEDY } };
        }
        if (pin.port === null && !metroPort)
          note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${DEFAULT_METRO_PORT}.`));
        metroPort = pin.port ?? metroPort ?? DEFAULT_METRO_PORT;
      }
      hostedIosMetroNote(Boolean(hostedTarget), settings, note, opts.simulatorApp);
      if (physical && metroPort !== null) {
        const error = await resolveLanOrigin();
        if (error) return { ok: false, error };
      }
      if (remoteDevice && metroPort !== null) {
        const reachable = await d.ensureMetroReachable({
          ctx: remoteDevice.ctx,
          env: context.env,
          metroPort,
          isExpo,
          tunnelMode: tunnelModeSetting(settings) ?? undefined,
          publicUrl: publicUrlSetting(settings),
          available: d.detectProviders(binOnPath, tunnelModeSetting(settings) ?? 'auto'),
        });
        if ('failed' in reachable) {
          return {
            ok: false,
            error: {
              code: reachable.code ?? REMOTE_SESSION_ERROR,
              message: reachable.failed,
              remedy: reachable.remedy,
            },
          };
        }
      }
      if (metroCheck && optimizations.metroWarmup)
        void d.warmMetro({
          port: metroPort as number,
          platform: 'ios',
          isExpo,
          appId: proj?.bundleId,
          bundleUrl: metroWarmupUrlSetting(settings, 'ios'),
          logsDir,
          root,
        });
      return { ok: true, prepared: { metroPort } };
    }

    async function resolveLanOrigin(): Promise<RuntimePreparationError | null> {
      const port = metroPort as number;
      const pinned = iosLanHostSetting(settings);
      const candidates = d.hostLanCandidates();
      const chosen = chooseLanAddress({ pinned, candidates });
      if (!chosen) {
        return {
          code: 'STIM_NO_LAN_ADDRESS',
          message:
            'A Debug run on a phone needs an address the phone can reach, and this Mac has no non-internal IPv4 interface.',
          remedy:
            'The phone reaches Metro over the network you share, because USB carries no reverse forward. ' +
            'Join a Wi-Fi or Ethernet network, or connect this Mac by cable, then run the command again.',
        };
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
      if (!metroCheck) return null;
      const reachable = await d.ensureLanReachable({
        origin: lanOriginUrl,
        metroPort: port,
        root,
        isExpo,
        logsDir,
      });
      if ('failed' in reachable) {
        return { code: 'STIM_LAN_METRO_UNREACHABLE', message: reachable.failed, remedy: reachable.remedy };
      }
      phase('lan', `gated: ${lanOriginUrl} answered as this workspace's Metro`);
      return null;
    }

    let artifact: PreparedIosArtifact | null = null;
    const reportRunFailure = (error: unknown): null => {
      const cancelled = cancelledFailure(context, PLATFORM, {
        code: 'STIM_CANCELLED',
        message: 'while finishing the run',
      });
      if (cancelled) return fail(cancelled);
      if (acquiredBuild) {
        const { code } = error as { code?: unknown };
        recordFailedBuild(acquiredBuild, typeof code === 'string' ? code : undefined, {
          message: error instanceof Error ? error.message : String(error),
        });
        logWriter().write(thrownRunFailureRecord(error, progress.phase()));
      }
      recordRun({ failed: true, durationMs: elapsed() });
      throw error;
    };

    try {
      const boot = (): Promise<IosBootLike> =>
        physicalDevice
          ? Promise.resolve({ ok: true, udid: physicalDevice.udid })
          : Promise.resolve(
              d.ensureBooted({
                platform: PLATFORM,
                device,
                projectPath: root,
                deviceSlotWait,
                simulatorApp,
                out: note,
              }),
            ).catch((e) => ({
              ok: false,
              reason: String((e as Error)?.message || e),
            }));
      const startBoot = (): Promise<string> => {
        const bootTimer = stepTimer(d.now);
        bootPending = remoteDevice?.ctx.backend !== 'eas';
        bootPromise = (
          remoteDevice?.ctx.backend === 'eas'
            ? d.ensureRemoteBootOwned({
                root,
                platform: PLATFORM,
                sessionName: ownedSessionName(remoteDevice.ctx.label),
                operation: context,
                startedAt: new Date(d.now()).toISOString(),
                deviceType: remoteDevice.ctx.deviceType ?? null,
                boot,
                createdSessionId: remoteDevice.createdSessionId,
                abandonCreatedSession: remoteDevice.abandonCreatedSession,
                webPreviewUrl: remoteDevice.webPreviewUrl,
                writeState: d.writeWorkspaceState,
                register: registerProject,
                notice: (line: string) => note(chalk.dim(phaseLine('lock', line))),
              })
            : boot()
        ).then((result) => {
          bootDuration = bootTimer();
          bootPending = false;
          return result;
        });
        deviceWaitRun.booting({ done: bootPromise });
        return bootPromise.then((result) => result?.udid ?? '');
      };
      // A remote device boots after the build: agent-device's daemon exits five
      // minutes after its last request while no session is open, and nothing
      // restarts it on an EAS host (https://github.com/appandflow/stim/issues/1212).
      const localBoot = remoteDevice || hostedTarget ? null : startBoot();
      udid = (device.deviceUdid as string | undefined) ?? (await localBoot) ?? '';
      const simulatorArch = simulatorBuildArch({
        physical,
        remoteArch,
        hostArch: d.hostSimulatorArch(),
        configuration,
      });
      const acquiredArtifact = unlessCancelled(
        context,
        await acquireIosArtifact(
          {
            context,
            root,
            logFile,
            configuration,
            buildMachine,
            physical,
            recipe: integration.artifact({
              operation: context,
              root,
              logFile,
              configuration,
              buildScheme,
              buildProfile,
              ...iosArtifactTargetInputs({
                udid,
                physical,
                remote: Boolean(remoteDevice),
                hosted: hostedTarget,
                simulatorArch,
                lanAddress,
                metroPort,
                settings,
              }),
              optimizations: optimizations.ios,
              easProfile: opts.easProfile,
              cache: cachePolicy,
              phase,
              note,
              logWriter,
              estimates,
              step: progress.step,
              setPodsMs: (ms) => stats.setPodsMs(ms),
            }),
            cache: {
              policy: cachePolicy,
              providerConfig: cacheProviderConfig,
              disabledByFlag: opts.buildCache === false,
            },
            easBuild,
            maxBuilds: limits.maxBuilds,
            progress: {
              phase,
              note,
              logWriter,
              stats,
              step: progress.step,
              miss: progress.miss,
              hit: progress.hit,
              place: progress.place,
              waitingOn: progress.waitingOn,
              waitingFor: progress.waitingFor,
            },
          },
          d,
        ),
      );
      if (!acquiredArtifact.ok) {
        compilationCache = acquiredArtifact.compilationCache;
        return fail(acquiredArtifact.failure);
      }
      artifact = acquiredArtifact.artifact;
      acquiredBuild = {
        ...artifact.failureFields,
        appPath: artifact.path,
        bundleId: artifact.bundleId,
      };
      compilationCache = artifact.cache.compilation;
      if (hostedTarget)
        return await finishHostedIosRun({
          operation: context,
          output: context.output,
          target: hostedTarget,
          projectBundleId: integration.bundleId,
          root,
          slot,
          d,
          artifact,
          configuration,
          buildScheme,
          release,
          appMode,
          isExpo,
          metroCheck,
          metroPort,
          logsDir,
          json,
          elapsed,
          startedAt,
          closeWriter: () => writer?.close(),
          devicePlacement,
          recordRun,
          reclaimed,
          devServer,
          fail,
          note,
          phase,
          enterPhase: progress.step,
          enterActivity: progress.activity,
          selectors,
          logWriter,
        });
      if (!localBoot) {
        progress.step('device');
        udid = await startBoot();
      }

      if (physicalDevice) {
        progress.step('device');
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
          stopLeaseSignals = d.releaseLeaseOnAbort(context, releaseLease);
          phase(
            'lease',
            `${acquired.kind} lease on ${physicalDevice.udid} until ${leaseExpiryText(acquired.expiresAt, d.now())}`,
          );
        }
      }

      try {
        return await finishIosRun({
          operation: context,
          output: context.output,
          projectBundleId: integration.bundleId,
          runtime: appRuntime,
          runtimePreparation,
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
          bootPending: () => bootPending,
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
          devicePlacement,
          recordRun,
          reclaimed,
          devServer,
          enterPhase: progress.step,
          enterActivity: progress.activity,
        });
      } finally {
        releaseLease();
      }
    } catch (error) {
      return reportRunFailure(error);
    } finally {
      artifact?.cancelFingerprintCheck();
      await artifact?.release();
    }
  } finally {
    await deviceWaitRun.finish();
    hostedTarget?.host.connection.close();
  }
}
