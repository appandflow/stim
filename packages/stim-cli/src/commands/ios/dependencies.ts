import { projectRegistry } from '../../integrations/projects.ts';
import type { ProjectRegistry } from '../../integrations/project-registry.ts';
import type { IosRuntimePlan } from './launch.ts';
import { automaticDevicePlacement } from '../../device-host/auto-placement.ts';
import { checkEasFallback } from '../../engine/eas-fallback.ts';
import { prepareHostedIos, placeHostedIos } from '../../device-host/hosted-ios.ts';
import { hostedMetroPortProbe } from '../../device-host/hosted-native.ts';
import { readHostedIos, writeHostedIosAsync } from '../../device-host/ios-state.ts';
import { followHostedLaunchLogs } from '../../device-host/hosted-logs-sync.ts';
import { loadCacheProvider } from '@stim-cli/cache';
import { buildIos, discoverXcodeProject } from '../../integrations/react-native-build.ts';
import { resolveEasDevelopmentBuild } from '../../engine/eas-build.ts';
import { memoizedFingerprint } from '../../cache/fingerprint-memo.ts';
import {
  fingerprintProject,
  resolveBuild,
  storeBuild,
  type BuildStore,
  untrackedNativeFiles,
} from '../../cache/build-cache.ts';
import {
  getConcurrencyLimits,
  getProject,
  recordIosSchemeApprovals,
  upsertProject,
  withConfigLockAsync,
  type ProjectRecord,
} from '../../workspace/config.ts';
import { clearOtherUserApps, installIosApp, launchIosApp } from '../../engine/app-install.ts';
import { verifyLaunch, verifyReleaseLaunch } from '../../engine/launch-verify.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../../engine/build-slots.ts';
import { readPodState, podsAreStale, runPodInstall } from '../../engine/deps.ts';
import { checkDeviceCapacity } from '../../engine/device-capacity.ts';
import { budgetGate } from '../../budget.ts';
import { clearIosAdoptionPending } from '../../engine/device-ios.ts';
import { ensureBooted, ensureOwnedDevice } from '../../engine/device.ts';
import {
  clearIosAppData,
  listIosRuntimesAsync,
  listIosRuntimes,
  listAllIosSims,
  type IosSimSnapshot,
} from '../../devices/ios.ts';
import {
  ensureRemoteBootOwned,
  ensureMetroReachable,
  remoteIosDeps,
  resolveRemoteContext,
} from '../../engine/device-remote.ts';
import { readRemoteSimulatorArch } from '../../engine/agent-device.ts';
import { hostSimulatorArch } from '@stim-cli/core';
import {
  awaitIosDeviceLaunch,
  installIosDeviceApp,
  iosDeviceProcess,
  listIosDevices,
  verifyIosDeviceReleaseLaunch,
} from '../../engine/ios-device.ts';
import { selectFromPool } from '../../engine/device-pool.ts';
import { acquireRunLease, releaseLeaseOnAbort, runLease } from '../../engine/device-lease-run.ts';
import { gateProfileForDevice, sealAppForDevice } from '../../engine/ios-signing.ts';
import { ensureLanReachable } from '../../engine/ios-lan.ts';
import { hostLanCandidates } from '../../engine/lan-address.ts';
import { detectProviders } from '../../engine/metro-reach.ts';
import { planPrebuildAsync, runPrebuild, type PrebuildAction } from '../../engine/prebuild.ts';
import {
  checkEasAuth,
  loadProjectProvider,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
} from '../../engine/remote-cache.ts';
import { readRunEstimates, recordRunStats, recordCapacityRefusal } from '../../engine/stats.ts';
import { swapJsBundle } from '../../engine/js-swap.ts';
import { resolveScheme, readBundleExecutable, readBundleId } from '../../engine/xcode.ts';
import { pidExists, resolveProjectMetro } from '../../metro.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { detectBundleId } from '../../workspace/app-id.ts';
import { detectIsExpo, findProjectRoot } from '../../workspace/project.ts';
import {
  resolveCacheProviderConfig,
  resolveSettings,
  type ProjectSettingsReaders,
  settingsLayers,
  settingOriginScope,
} from '../../workspace/settings.ts';
import { writeWorkspaceLaunchAsync } from '../../supervisor/state.ts';
import { readWorkspaceState, writeWorkspaceStateAsync } from '../../workspace/workspace-state.ts';
import { gitCommonDirAsync, repoRootAsync } from '../../workspace/worktree.ts';
import { warmMetro } from '../../engine/metro-warmup.ts';
import { ensureWorkspaceStorageSafely } from '../native-runtime.ts';
import { startDevServer } from '../start.ts';
import { devClientScheme, devClientTakesDevMenuParams, hasDevClient } from '../dev-client.ts';
import { stopPreviousCollector, replaceCollector } from './collector.ts';

export interface IosDeps {
  projectRegistry: Pick<ProjectRegistry, 'selectIos'>;
  runtimePlan?: IosRuntimePlan;
  automaticDevicePlacement: typeof automaticDevicePlacement;
  checkEasFallback: typeof checkEasFallback;
  prepareHostedIos: typeof prepareHostedIos;
  placeHostedIos: typeof placeHostedIos;
  hostedMetroPortProbe: typeof hostedMetroPortProbe;
  readHostedIos: typeof readHostedIos;
  writeHostedIos: typeof writeHostedIosAsync;
  resolveEasDevelopmentBuild: typeof resolveEasDevelopmentBuild;
  resolveRemoteContext: typeof resolveRemoteContext;
  ensureMetroReachable: typeof ensureMetroReachable;
  ensureRemoteBootOwned: typeof ensureRemoteBootOwned;
  detectProviders: typeof detectProviders;
  remoteIosDeps: typeof remoteIosDeps;
  readRemoteSimulatorArch: typeof readRemoteSimulatorArch;
  hostSimulatorArch: typeof hostSimulatorArch;
  resolveEasCliBin: typeof resolveEasCliBin;
  findProjectRoot: typeof findProjectRoot;
  resolveSettings: typeof resolveSettings;
  settingsLayers: typeof settingsLayers;
  settingOriginScope: typeof settingOriginScope;
  gitCommonDir: ProjectSettingsReaders['gitCommonDir'];
  repoRoot: ProjectSettingsReaders['repoRoot'];
  detectBundleId: typeof detectBundleId;
  detectIsExpo: typeof detectIsExpo;
  devClientScheme: typeof devClientScheme;
  hasDevClient: typeof hasDevClient;
  devClientTakesDevMenuParams: typeof devClientTakesDevMenuParams;
  getProject: typeof getProject;
  upsertProject: (...args: Parameters<typeof upsertProject>) => Promise<ProjectRecord>;
  recordIosSchemeApprovals: typeof recordIosSchemeApprovals;
  checkDeviceCapacity: typeof checkDeviceCapacity;
  budgetGate: typeof budgetGate;
  ensureOwnedDevice: typeof ensureOwnedDevice;
  listIosRuntimes: (options?: {
    signal?: AbortSignal;
    snapshot?: IosSimSnapshot;
  }) => ReturnType<typeof listIosRuntimes> | Promise<ReturnType<typeof listIosRuntimes>>;
  listAllIosSims: typeof listAllIosSims;
  ensureBooted: typeof ensureBooted;
  resolveProjectMetro: typeof resolveProjectMetro;
  startDevServer: typeof startDevServer;
  warmMetro: typeof warmMetro;
  readWorkspaceState: typeof readWorkspaceState;
  pidExists: typeof pidExists;
  getConcurrencyLimits: typeof getConcurrencyLimits;
  fingerprintProject: typeof fingerprintProject;
  memoizedFingerprint: typeof memoizedFingerprint;
  untrackedNativeFiles: typeof untrackedNativeFiles;
  resolveBuild: typeof resolveBuild;
  storeBuild: BuildStore;
  resolveCacheProviderConfig: typeof resolveCacheProviderConfig;
  loadCacheProvider: typeof loadCacheProvider;
  acquireBuildLock: typeof acquireBuildLock;
  releaseBuildLock: typeof releaseBuildLock;
  waitForBuild: typeof waitForBuild;
  acquireBuildSlot: typeof acquireBuildSlot;
  releaseBuildSlot: typeof releaseBuildSlot;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  uploadRemote: typeof uploadRemote;
  planPrebuild: (...args: Parameters<typeof planPrebuildAsync>) => PrebuildAction | Promise<PrebuildAction>;
  runPrebuild: typeof runPrebuild;
  readPodState: typeof readPodState;
  podsAreStale: typeof podsAreStale;
  runPodInstall: typeof runPodInstall;
  buildIos: typeof buildIos;
  discoverXcodeProject: typeof discoverXcodeProject;
  resolveScheme: typeof resolveScheme;
  listIosDevices: typeof listIosDevices;
  hostLanCandidates: typeof hostLanCandidates;
  ensureLanReachable: typeof ensureLanReachable;
  gateProfileForDevice: (
    ...args: Parameters<typeof gateProfileForDevice>
  ) => Awaited<ReturnType<typeof gateProfileForDevice>> | ReturnType<typeof gateProfileForDevice>;
  sealAppForDevice: (
    ...args: Parameters<typeof sealAppForDevice>
  ) => Awaited<ReturnType<typeof sealAppForDevice>> | ReturnType<typeof sealAppForDevice>;
  installIosDeviceApp: typeof installIosDeviceApp;
  awaitIosDeviceLaunch: typeof awaitIosDeviceLaunch;
  acquireRunLease: typeof acquireRunLease;
  runLease: typeof runLease;
  selectFromPool: typeof selectFromPool;
  releaseLeaseOnAbort: typeof releaseLeaseOnAbort;
  iosDeviceProcess: typeof iosDeviceProcess;
  verifyIosDeviceReleaseLaunch: typeof verifyIosDeviceReleaseLaunch;
  readBundleId: typeof readBundleId;
  readBundleExecutable: typeof readBundleExecutable;
  swapJsBundle: typeof swapJsBundle;
  installIosApp: typeof installIosApp;
  clearOtherUserApps: typeof clearOtherUserApps;
  clearIosAppData: typeof clearIosAppData;
  clearIosAdoptionPending: typeof clearIosAdoptionPending;
  launchIosApp: typeof launchIosApp;
  verifyLaunch: typeof verifyLaunch;
  verifyReleaseLaunch: typeof verifyReleaseLaunch;
  followHostedLaunchLogs: typeof followHostedLaunchLogs;
  ensureWorkspaceStorage: typeof ensureWorkspaceStorageSafely;
  replaceCollector: typeof replaceCollector;
  stopPreviousCollector: typeof stopPreviousCollector;
  writeWorkspaceLaunch: typeof writeWorkspaceLaunchAsync;
  writeWorkspaceState: typeof writeWorkspaceStateAsync;
  createWriter: typeof createNdjsonWriter;
  recordStats: typeof recordRunStats;
  recordCapacityRefusal: typeof recordCapacityRefusal;
  readEstimates: typeof readRunEstimates;
  now: () => number;
}

export const DEFAULT_DEPS: IosDeps = {
  projectRegistry,
  automaticDevicePlacement,
  checkEasFallback,
  prepareHostedIos,
  placeHostedIos,
  hostedMetroPortProbe,
  readHostedIos,
  writeHostedIos: writeHostedIosAsync,
  resolveEasDevelopmentBuild,
  findProjectRoot,
  resolveSettings,
  settingsLayers,
  settingOriginScope,
  gitCommonDir: gitCommonDirAsync,
  repoRoot: repoRootAsync,
  detectBundleId,
  detectIsExpo,
  devClientScheme,
  hasDevClient,
  devClientTakesDevMenuParams,
  getProject,
  upsertProject: (...args) => withConfigLockAsync(() => upsertProject(...args)),
  recordIosSchemeApprovals,
  checkDeviceCapacity,
  budgetGate,
  ensureOwnedDevice,
  listIosRuntimes: listIosRuntimesAsync,
  listAllIosSims,
  ensureBooted,
  resolveRemoteContext,
  remoteIosDeps,
  readRemoteSimulatorArch,
  hostSimulatorArch,
  ensureMetroReachable,
  ensureRemoteBootOwned,
  detectProviders,
  resolveProjectMetro,
  startDevServer,
  warmMetro,
  readWorkspaceState,
  pidExists,
  getConcurrencyLimits,
  fingerprintProject,
  memoizedFingerprint,
  untrackedNativeFiles,
  resolveBuild,
  storeBuild,
  resolveCacheProviderConfig,
  loadCacheProvider,
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild,
  acquireBuildSlot,
  releaseBuildSlot,
  loadProjectProvider,
  checkEasAuth,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
  planPrebuild: planPrebuildAsync,
  runPrebuild,
  readPodState,
  podsAreStale,
  runPodInstall,
  buildIos,
  discoverXcodeProject,
  resolveScheme,
  listIosDevices,
  hostLanCandidates,
  ensureLanReachable,
  gateProfileForDevice,
  sealAppForDevice,
  installIosDeviceApp,
  awaitIosDeviceLaunch,
  acquireRunLease,
  runLease,
  selectFromPool,
  releaseLeaseOnAbort,
  iosDeviceProcess,
  verifyIosDeviceReleaseLaunch,
  readBundleId,
  readBundleExecutable,
  swapJsBundle,
  installIosApp,
  clearOtherUserApps,
  clearIosAppData,
  clearIosAdoptionPending,
  launchIosApp,
  verifyLaunch,
  verifyReleaseLaunch,
  followHostedLaunchLogs,
  ensureWorkspaceStorage: ensureWorkspaceStorageSafely,
  replaceCollector,
  stopPreviousCollector,
  writeWorkspaceLaunch: writeWorkspaceLaunchAsync,
  writeWorkspaceState: writeWorkspaceStateAsync,
  createWriter: createNdjsonWriter,
  recordStats: recordRunStats,
  recordCapacityRefusal,
  readEstimates: readRunEstimates,
  now: () => Date.now(),
};
