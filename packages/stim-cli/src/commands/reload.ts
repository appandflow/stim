import { reopenHostedAndroidMetro } from '../device-host/hosted-android.ts';
import { hostedNativeRecords, hostedAndroidDeviceName, type HostedAndroidPlacement } from '@stim-cli/core/state';
import { readHostedNative } from '../device-host/ios-state.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { nativeRunCommand } from '../engine/slot-launch.ts';
import { deviceSlotPlatforms, parseDeviceSlotKey } from '../devices/device-slots.ts';
import chalk from 'chalk';
import { cancellableSleep, throwIfCancelled } from '../cancellation.ts';
import type { Command } from 'commander';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { getProject, type ProjectRecord } from '../workspace/config.ts';
import { androidAppProcess, ensureMetroReverse, iosAppProcess, type AppProcessProbe } from '../engine/app-install.ts';
import { loadScaledBudgetMs } from '../process-group-exit.ts';
import { reloadThroughMetro } from '../engine/reload.ts';
import { listeningPidsAsync, processCwds, resolveProjectMetro, type MetroResolution } from '../metro.ts';
import { isMetroRunning } from '../ports.ts';
import { findCommandWorkspaceAsync } from '../workspace/project.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import { liveWebRecord, sendToOwnedPage } from '../web/page.ts';
import { cdpEndpoint, readWebRecord, webFactsAsync, type WebRecord } from '../web/state.ts';
import { readWorkspaceState, recordWorkspaceUseAsync } from '../workspace/workspace-state.ts';
import { resolveOwnedAvdSerialAsync, type ResolvedAvdSerial } from '../devices/android.ts';
import { listAllIosSimsAsync, resolveOwnedIosSim, type ResolvedIosSim } from '../devices/ios.ts';
import {
  readRemoteSession,
  readWorkspaceLaunches,
  type RemoteSessionRecord,
  type WorkspaceLaunchPlatform,
  type WorkspaceLaunchRecord,
} from '../supervisor/state.ts';

export type ReloadPlatform = WorkspaceLaunchPlatform | 'web';

export interface ReloadFacts {
  platform: ReloadPlatform;
  deviceId: string;
  deviceName: string;
  appId: string;
  metroPort: number | null;
  strategy: 'metro-websocket' | 'metro-broadcast' | 'cdp';
  targets: number | null;
  reverseRestored: string[];
}

interface ReloadFailure {
  code: string;
  message: string;
  remedy: string | null;
}

type ReloadResult = { ok: true; facts: ReloadFacts } | { ok: false; error: ReloadFailure };

interface LiveTarget {
  slot: string;
  platform: WorkspaceLaunchPlatform;
  record: WorkspaceLaunchRecord;
  deviceName: string;
  hosted?: boolean;
  hostedAndroid?: HostedAndroidPlacement;
  processUnknown?: boolean;
}

interface TargetFailure {
  platform: WorkspaceLaunchPlatform;
  error: ReloadFailure;
}

export interface ReloadDeps {
  findWorkspace: (cwd: string) => string | null | Promise<string | null>;
  getProject: typeof getProject;
  readLaunches: typeof readWorkspaceLaunches;
  readRemote: (root: string) => RemoteSessionRecord | null;
  resolveIos: (udid: string) => ResolvedIosSim | Promise<ResolvedIosSim>;
  resolveAndroid: (avdName: string) => Promise<ResolvedAvdSerial>;
  iosProcess: typeof iosAppProcess;
  androidProcess: typeof androidAppProcess;
  resolveMetro: (port: number, root: string, signal?: AbortSignal) => Promise<MetroResolution>;
  reloadMetro: typeof reloadThroughMetro;
  readBrowser: (
    root: string,
  ) =>
    | (WebRecord & { targetId: string })
    | 'unverified'
    | null
    | Promise<(WebRecord & { targetId: string }) | 'unverified' | null>;
  reloadPage: (record: WebRecord & { targetId: string }) => Promise<string>;
  reopenHostedMetro: typeof reopenHostedAndroidMetro;
  ensureReverse: (serial: string, metroPort: number) => ReturnType<typeof ensureMetroReverse>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: ReloadDeps = {
  findWorkspace: (cwd) => findCommandWorkspaceAsync(cwd, repoRootAsync, (line) => console.error(line)),
  getProject,
  readLaunches: readWorkspaceLaunches,
  readRemote: readRemoteSession,
  resolveIos: async (udid) => resolveOwnedIosSim(udid, await listAllIosSimsAsync({})),
  resolveAndroid: resolveOwnedAvdSerialAsync,
  iosProcess: iosAppProcess,
  androidProcess: androidAppProcess,
  resolveMetro: (port, root, signal) =>
    resolveProjectMetro(port, root, {
      probe: (candidate) => isMetroRunning(candidate, signal),
      pidsOf: listeningPidsAsync,
      cwdOf: async (pid) => (await processCwds([pid])).get(pid) ?? null,
    }),
  reloadMetro: reloadThroughMetro,
  readBrowser: async (root) => {
    const facts = await webFactsAsync(readWebRecord(root));
    return facts?.status === 'unverified' ? 'unverified' : liveWebRecord(facts?.record ?? null);
  },
  reloadPage: (record) => sendToOwnedPage(record, 'Page.reload'),
  reopenHostedMetro: reopenHostedAndroidMetro,
  ensureReverse: (serial, metroPort) => ensureMetroReverse({ serial, metroPort }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// React Native's Android packager connection retries every 2 seconds, so a restored reverse is picked up within a few.
const RECONNECT_POLL_MS = 500;
const RECONNECT_POLLS = 16;
const RECONNECT_UNOBSERVED_MS = 2_500;

function failure(code: string, message: string, remedy: string | null): ReloadFailure {
  return { code, message, remedy };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reloadBrowser(
  browser: WebRecord & { targetId: string },
  metroPort: number | null,
  d: ReloadDeps,
  signal?: AbortSignal,
): Promise<ReloadResult> {
  let pageUrl: string;
  try {
    pageUrl = await d.reloadPage(browser);
  } catch (error) {
    throwIfCancelled(signal, 'reload');
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_FAILED',
        `The owned Chrome did not accept the reload: ${describe(error)}`,
        'Run `stim web` to reopen the page.',
      ),
    };
  }
  return {
    ok: true,
    facts: {
      platform: 'web',
      deviceId: cdpEndpoint(browser.cdpPort),
      deviceName: browser.version ?? 'Chrome',
      appId: pageUrl,
      metroPort: metroPort !== null && new URL(browser.url).port === String(metroPort) ? metroPort : null,
      strategy: 'cdp',
      targets: 1,
      reverseRestored: [],
    },
  };
}

const PROCESS_PROBE_BASE_MS = 5_000;
const PROCESS_PROBE_CAP_MS = 30_000;

async function appProcessState(
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
  d: ReloadDeps,
): Promise<AppProcessProbe['state']> {
  const { state } =
    platform === 'ios'
      ? await d.iosProcess(record.deviceId, record.appId, {
          timeoutMs: loadScaledBudgetMs(PROCESS_PROBE_BASE_MS, PROCESS_PROBE_CAP_MS),
        })
      : await d.androidProcess(record.deviceId, record.appId);
  return state;
}

function processFailure(
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
  state: AppProcessProbe['state'],
  slot = 'default',
): ReloadFailure | null {
  if (state === 'unknown') {
    const probe =
      platform === 'ios'
        ? `xcrun simctl spawn ${record.deviceId} launchctl list`
        : `adb -s ${record.deviceId} shell pidof ${record.appId}`;
    return failure(
      'STIM_RELOAD_PROBE_FAILED',
      `Stim could not determine whether ${record.appId} is running on ${record.deviceId}.`,
      `Run \`${probe}\` and retry when the device tool responds.`,
    );
  }
  if (state === 'stopped') {
    return failure(
      'STIM_RELOAD_STOPPED',
      `${record.appId} is not running on ${record.deviceId}.`,
      `Run \`${nativeRunCommand(platform, slot)}\` to launch it.`,
    );
  }
  return null;
}

async function inspectTarget(
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
  project: ProjectRecord,
  d: ReloadDeps,
  slot = 'default',
): Promise<LiveTarget | TargetFailure> {
  const runCommand = nativeRunCommand(platform, slot);
  if (platform === 'ios') {
    const configured = project.platforms?.ios;
    if (!configured?.owned || configured.deviceUdid !== record.deviceId) {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_UNOWNED',
          `The recorded iOS launch on ${record.deviceId} is not this workspace's current owned simulator.`,
          `Run \`${runCommand}\` to launch the app on this workspace's owned simulator.`,
        ),
      };
    }
    let resolved: ResolvedIosSim;
    try {
      resolved = await d.resolveIos(record.deviceId);
    } catch (error) {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_PROBE_FAILED',
          `Stim could not inspect iOS simulator ${record.deviceId}: ${describe(error)}`,
          'Run `xcrun simctl list devices` and retry when simctl responds.',
        ),
      };
    }
    if (!resolved.sim || resolved.sim.state !== 'Booted') {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_STOPPED',
          `The recorded iOS app is not running on a booted owned simulator.`,
          `Run \`${runCommand}\` to boot, install, and launch it.`,
        ),
      };
    }
    const state = await appProcessState(platform, record, d);
    const stopped = state === 'unknown' ? null : processFailure(platform, record, state, slot);
    if (stopped) return { platform, error: stopped };
    return { platform, slot, record, deviceName: resolved.sim.name, processUnknown: state === 'unknown' };
  }

  const configured = project.platforms?.android;
  if (!configured?.owned || !configured.avdName) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_UNOWNED',
        `The recorded Android launch on ${record.deviceId} is not this workspace's current owned emulator.`,
        `Run \`${runCommand}\` to launch the app on this workspace's owned emulator.`,
      ),
    };
  }
  let resolved: ResolvedAvdSerial;
  try {
    resolved = await d.resolveAndroid(configured.avdName);
  } catch (error) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_PROBE_FAILED',
        `Stim could not inspect Android emulator ${configured.avdName}: ${describe(error)}`,
        'Run `adb devices` and retry when adb responds.',
      ),
    };
  }
  if (!resolved.serial || resolved.serial !== record.deviceId) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_STOPPED',
        `The recorded Android app is not running on this workspace's owned emulator.`,
        `Run \`${runCommand}\` to boot, install, and launch it.`,
      ),
    };
  }
  const state = await appProcessState(platform, record, d);
  const stopped = state === 'unknown' ? null : processFailure(platform, record, state, slot);
  if (stopped) return { platform, error: stopped };
  return { platform, slot, record, deviceName: configured.avdName, processUnknown: state === 'unknown' };
}

function remoteSessionFor(
  session: RemoteSessionRecord | null,
  platform: ReloadPlatform | null,
): RemoteSessionRecord | null {
  return session && (!platform || !session.platform || session.platform === platform) ? session : null;
}

function unlaunchedRefusal(
  platform: ReloadPlatform | null,
  metroPort: number | null,
  remote: RemoteSessionRecord | null,
): ReloadFailure {
  const metroReload = metroPort ? `agent-device metro reload --metro-port ${metroPort}` : null;
  if (remote) {
    return failure(
      'STIM_RELOAD_UNSUPPORTED',
      `This workspace's remote device is EAS Simulator session ${remote.sessionId}, which stim reload does not reach.`,
      metroReload
        ? `If the app is running there, run \`${metroReload}\`; it asks every app connected to this workspace's Metro to reload. Otherwise run \`stim ${platform ?? remote.platform ?? 'ios'} --remote eas\` to launch it.`
        : 'Run `stim start`, launch the app on the session, then reload it with `agent-device metro reload --metro-port <port>`.',
    );
  }
  const run = platform ? `Run \`stim ${platform}\` first.` : 'Run `stim ios` or `stim android` first.';
  return failure(
    'STIM_RELOAD_STOPPED',
    platform ? `No ${platform} app launch is recorded for this workspace.` : 'No live app launch is recorded.',
    metroReload
      ? `${run} Stim records launches only on owned local simulators and emulators, so an app running on a physical device (--device) is not recorded; reload it with \`${metroReload}\`.`
      : run,
  );
}

function isTargetFailure(value: LiveTarget | TargetFailure): value is TargetFailure {
  return 'error' in value;
}

export async function runReload({
  root,
  platform = null,
  deps = {},
  signal,
}: {
  root: string;
  platform?: ReloadPlatform | null;
  deps?: Partial<ReloadDeps>;
  signal?: AbortSignal;
}): Promise<ReloadResult> {
  throwIfCancelled(signal, 'reload');
  const d = {
    ...DEFAULT_DEPS,
    reloadPage: (record: WebRecord & { targetId: string }) => sendToOwnedPage(record, 'Page.reload', {}, signal),
    reopenHostedMetro: (projectRoot: string, placement: HostedAndroidPlacement, port: number) =>
      reopenHostedAndroidMetro(projectRoot, placement, port, signal),
    sleep: (ms: number) => cancellableSleep(ms, { signal, what: 'reload' }),
    ...deps,
  };
  const project = d.getProject(root);
  if (!project) {
    return {
      ok: false,
      error: failure('STIM_NO_PROJECT', `No Stim environment is registered for ${root}.`, 'Run `stim start` first.'),
    };
  }
  const read = platform === null || platform === 'web' ? await d.readBrowser(root) : null;
  throwIfCancelled(signal, 'reload');
  if (platform === 'web' && read === 'unverified') {
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_PROBE_FAILED',
        "Stim could not verify the owned Chrome's supervisor or Chrome process.",
        'Run `stim status`, then follow `stim guide errors teardown`.',
      ),
    };
  }
  const browser = read === 'unverified' ? null : read;
  if (platform === 'web') {
    return browser
      ? reloadBrowser(browser, project.metroPort ?? null, d, signal)
      : {
          ok: false,
          error: failure(
            'STIM_RELOAD_STOPPED',
            'No owned Chrome is running for this workspace.',
            'Run `stim web` first.',
          ),
        };
  }
  const hosted = {
    ios: platform === 'android' ? {} : readHostedNative(root, 'ios'),
    android: platform === 'ios' ? {} : readHostedNative(root, 'android'),
  };
  const hostedFailures: Record<string, TargetFailure> = {};
  for (const native of ['ios', 'android'] as const) {
    if (platform && platform !== native) continue;
    for (const slot of Object.keys(hostedNativeRecords(readWorkspaceState(root), native))) {
      if (hosted[native][slot]) continue;
      try {
        readHostedNative(root, native, slot);
      } catch (error) {
        hostedFailures[`${native}:${slot}`] = {
          platform: native,
          error: failure(
            'STIM_HOSTING_REFUSED',
            describe(error),
            error instanceof Error && 'remedy' in error && typeof error.remedy === 'string' ? error.remedy : null,
          ),
        };
      }
    }
  }
  const hostedProbes = Object.fromEntries(
    await Promise.all(
      (['ios', 'android'] as const).flatMap((native) =>
        Object.entries(hosted[native]).map(async ([slot, placement]) => [
          `${native}:${slot}`,
          await probeHostedSession({ ...placement, platform: native }, signal ? { ttlMs: 0 } : undefined),
        ]),
      ),
    ),
  );
  throwIfCancelled(signal, 'reload');
  const launches = d.readLaunches(root);
  const inspected = (
    await Promise.all(
      Object.entries(launches).map(async ([key, record]) => {
        const parsed = parseDeviceSlotKey(key);
        if (!parsed || (platform && parsed.platform !== platform)) return [];
        if (hostedFailures[`${parsed.platform}:${parsed.slot}`]) return [];
        const placement = hosted[parsed.platform][parsed.slot];
        if (placement) {
          const probe = hostedProbes[`${parsed.platform}:${parsed.slot}`]!;
          return [
            probe.state === 'ready' && record.deviceId === placement.session
              ? {
                  platform: parsed.platform,
                  slot: parsed.slot,
                  record,
                  hosted: true,
                  ...(parsed.platform === 'android' ? { hostedAndroid: placement as HostedAndroidPlacement } : {}),
                  deviceName: `${placement.device ? ('udid' in placement.device ? placement.device.name : hostedAndroidDeviceName(placement.device)) : `${parsed.platform} device`} on ${placement.machine}`,
                }
              : {
                  platform: parsed.platform,
                  error: failure(
                    'STIM_RELOAD_PROBE_FAILED',
                    `The ${parsed.platform} session on ${placement.machine} is ${probe.state}.`,
                    `Run stim ${parsed.platform} --remote ${placement.machine} or stim stop to reconcile it.`,
                  ),
                },
          ];
        }
        return [
          await inspectTarget(
            parsed.platform,
            record,
            { ...project, platforms: deviceSlotPlatforms(project, parsed.slot) },
            d,
            parsed.slot,
          ),
        ];
      }),
    )
  ).flat();
  throwIfCancelled(signal, 'reload');
  inspected.push(...Object.values(hostedFailures));
  const live = inspected.filter((target): target is LiveTarget => !isTargetFailure(target));

  const livePlatforms = new Set<ReloadPlatform>(live.map((target) => target.platform));
  if (browser) livePlatforms.add('web');
  if (livePlatforms.size > 1) {
    const names = [...livePlatforms];
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_AMBIGUOUS',
        `More than one platform is live: ${names.join(', ')}.`,
        `Choose one with ${names.map((name) => `\`stim reload ${name}\``).join(' or ')}.`,
      ),
    };
  }
  if (browser && inspected.length === 0) return reloadBrowser(browser, project.metroPort ?? null, d, signal);
  if (read === 'unverified' && inspected.length === 0) {
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_PROBE_FAILED',
        "Stim could not verify the owned Chrome's supervisor or Chrome process.",
        'Run `stim status`, then follow `stim guide errors teardown`.',
      ),
    };
  }
  if (live.length === 0) {
    const nativeFailure = inspected.find(isTargetFailure)?.error;
    const firstFailure =
      nativeFailure && browser
        ? {
            ...nativeFailure,
            remedy:
              `${nativeFailure.remedy ?? ''} To reload the owned Chrome page instead, run \`stim reload web\`.`.trim(),
          }
        : nativeFailure;
    return {
      ok: false,
      error:
        firstFailure ??
        unlaunchedRefusal(platform, project.metroPort ?? null, remoteSessionFor(d.readRemote(root), platform)),
    };
  }

  const target =
    live.find((candidate) => !candidate.record.release && candidate.record.metroPort === project.metroPort) ?? live[0]!;
  if (target.record.runtime === 'process') {
    return {
      ok: false,
      error: failure(
        'STIM_NO_METRO',
        `${target.record.appId} runs as a native process without Metro.`,
        `Run \`${nativeRunCommand(target.platform, target.slot)}\` again to rebuild and relaunch the app.`,
      ),
    };
  }
  if (target.record.release) {
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_RELEASE',
        `${target.record.appId} was launched with an embedded release bundle.`,
        `Run \`${nativeRunCommand(target.platform, target.slot)}\` with a Debug configuration or variant before reloading JavaScript.`,
      ),
    };
  }
  const port = target.record.metroPort;
  if (!port || project.metroPort !== port) {
    return {
      ok: false,
      error: failure(
        'STIM_NO_METRO',
        `The launch does not point at this workspace's current Metro reservation.`,
        'Run `stim start`, then launch the app again.',
      ),
    };
  }
  const metro = await d.resolveMetro(port, root, signal);
  throwIfCancelled(signal, 'reload');
  if (!metro.metro) {
    return {
      ok: false,
      error: failure(
        'STIM_NO_METRO',
        `Port ${port} is not serving this workspace's Metro.`,
        'Run `stim start`, then retry.',
      ),
    };
  }
  const rechecked =
    target.hosted || target.processUnknown ? 'running' : await appProcessState(target.platform, target.record, d);
  throwIfCancelled(signal, 'reload');
  const stopped =
    rechecked === 'unknown' ? null : processFailure(target.platform, target.record, rechecked, target.slot);
  if (stopped) return { ok: false, error: stopped };

  const reverseRestored: string[] = [];
  let hostedReopened = false;
  const reverseChecked =
    target.platform === 'android'
      ? live.filter((c) => c.platform === 'android' && !c.record.release && c.record.metroPort === port)
      : [];
  for (const candidate of reverseChecked) {
    throwIfCancelled(signal, 'reload');
    if (candidate.hostedAndroid) {
      try {
        await d.reopenHostedMetro(root, candidate.hostedAndroid, port);
        throwIfCancelled(signal, 'reload');
        hostedReopened = true;
      } catch (error) {
        throwIfCancelled(signal, 'reload');
        return {
          ok: false,
          error: failure(
            'STIM_HOSTING_REFUSED',
            describe(error),
            `Retry stim reload android when ${candidate.hostedAndroid.machine} answers, or run stim stop to reconcile the session.`,
          ),
        };
      }
      continue;
    }
    const serial = candidate.record.deviceId;
    const ensured = await d.ensureReverse(serial, port);
    throwIfCancelled(signal, 'reload');
    if (ensured.failed) {
      return {
        ok: false,
        error: failure(
          'STIM_RELOAD_FAILED',
          `Stim could not check or restore the adb reverse for Metro port ${port} on ${serial}: ${ensured.reason}`,
          `Run \`adb -s ${serial} reverse tcp:${port} tcp:${port}\`, then \`stim reload android\` again.`,
        ),
      };
    }
    if (ensured.restored) reverseRestored.push(serial);
  }

  const request = { role: target.platform, appId: target.record.appId, ...(signal ? { signal } : {}) };
  const expectedPeers = reverseChecked.filter((c) => c.record.appId === target.record.appId).length;
  const awaitReconnect = reverseRestored.length > 0 || hostedReopened;
  for (let poll = 0; poll < RECONNECT_POLLS; poll++) {
    throwIfCancelled(signal, 'reload');
    if (!awaitReconnect) break;
    const peers = await d.reloadMetro(port, { ...request, peersOnly: true });
    throwIfCancelled(signal, 'reload');
    if (peers.broadcast) await d.sleep(RECONNECT_UNOBSERVED_MS);
    if (peers.unreachable || peers.broadcast || (peers.ok && peers.targets >= expectedPeers)) break;
    await d.sleep(RECONNECT_POLL_MS);
  }
  throwIfCancelled(signal, 'reload');
  const reloaded = await d.reloadMetro(port, request);
  if (!reloaded.ok) {
    const stoppedAfterMetro = target.hosted
      ? null
      : processFailure(
          target.platform,
          target.record,
          await appProcessState(target.platform, target.record, d),
          target.slot,
        );
    if (stoppedAfterMetro) return { ok: false, error: stoppedAfterMetro };
    if (target.hosted)
      return {
        ok: false,
        error: failure(
          'STIM_RELOAD_FAILED',
          reloaded.reason,
          `Metro could not confirm a peer for the hosted ${target.platform} app. Check the app on its hosting Mac and run stim reload ${target.platform} again.`,
        ),
      };
    const snapshot = `agent-device snapshot -i --platform ${target.platform} --${target.platform === 'ios' ? 'udid' : 'serial'} ${target.record.deviceId}`;
    const relaunch = `agent-device open ${target.record.appId} --platform ${target.platform} --${target.platform === 'ios' ? 'udid' : 'serial'} ${target.record.deviceId} --metro-port ${port} --relaunch`;
    const firstBundle =
      target.platform === 'ios'
        ? ' If it stays unreachable, an error in the first bundle leaves iOS without a packager connection at all, and no retry will make it a peer.'
        : '';
    const device = `reload from the device in your existing automation session: run \`${snapshot}\`, then press the error screen's Reload button, or open the dev menu and press Reload when no error screen is showing. Only when neither is reachable, run \`${relaunch}\`; that restarts the app and loses in-memory state. Keep your existing --session flag, verify the expected UI afterward, and do not create another session.`;
    const remedy = reloaded.unreachable
      ? `Metro is registered for this workspace but did not answer on port ${port}, so nothing is known about ${target.record.appId}. Run \`stim reload ${target.platform}\` again. If it keeps timing out, run \`stim doctor\` to check the dev server before touching the app.`
      : `Metro reports no peer for ${target.record.appId} right now. Stim broadcast a reload anyway, so check the expected UI on ${target.record.deviceId} first -- it may already have recovered. If not, the app reconnects every 2 seconds, so run \`stim reload ${target.platform}\` once more.${firstBundle} Then ${device}`;
    return {
      ok: false,
      error: failure('STIM_RELOAD_FAILED', reloaded.reason, remedy),
    };
  }
  const strategy: ReloadFacts['strategy'] = reloaded.broadcast ? 'metro-broadcast' : 'metro-websocket';

  return {
    ok: true,
    facts: {
      platform: target.platform,
      deviceId: target.record.deviceId,
      deviceName: target.deviceName,
      appId: target.record.appId,
      metroPort: port,
      strategy,
      targets: reloaded.targets ?? null,
      reverseRestored,
    },
  };
}

interface ReloadOptions {
  json?: boolean;
}

export function registerReload(program: Command, deps: Partial<ReloadDeps> = {}): void {
  program
    .command('reload [platform]')
    .description(
      "Request a JavaScript reload in this workspace's live app, or reload its owned Chrome page, without observing completion. Specify ios, android or web when more than one is live.",
    )
    .option('--json', 'Emit the reload facts as one JSON line')
    .action(async (value: string | undefined, opts: ReloadOptions) => {
      if (value !== undefined && value !== 'ios' && value !== 'android' && value !== 'web') {
        const error = failure(
          'STIM_BAD_ARG',
          `Unknown reload platform ${JSON.stringify(value)}.`,
          'Use ios, android or web.',
        );
        if (opts.json) console.log(JSON.stringify(error));
        else {
          console.error(chalk.red(phaseLine('error', `${error.code}: ${error.message}`)));
          if (error.remedy) console.error(phaseLine('remedy', error.remedy));
        }
        process.exitCode = 1;
        return;
      }
      const root = await (deps.findWorkspace ?? DEFAULT_DEPS.findWorkspace)(process.cwd());
      if (!root) {
        refuseNoProject({ json: Boolean(opts.json) });
        return;
      }
      await recordWorkspaceUseAsync(root);
      const result = await runReload({ root, platform: value ?? null, deps });
      if (!result.ok) {
        if (opts.json) console.log(JSON.stringify(result.error));
        else {
          console.error(chalk.red(phaseLine('error', `${result.error.code}: ${result.error.message}`)));
          if (result.error.remedy) console.error(phaseLine('remedy', result.error.remedy));
        }
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(result.facts));
      } else {
        const facts = result.facts;
        if (facts.strategy === 'cdp') {
          console.log(
            `Reload requested for ${facts.appId} in the owned Chrome (DevTools ${facts.deviceId}). Completion is not observed; run stim logs --errors.`,
          );
          return;
        }
        const scope =
          facts.strategy === 'metro-broadcast'
            ? ` This Metro cannot name its connected apps, so the reload request was broadcast to all of them and Stim cannot confirm ${facts.appId} was one. Check the expected UI on ${facts.deviceId}; if nothing changed, reload from the app's own error screen or dev menu.`
            : facts.targets && facts.targets > 1
              ? ` ${facts.targets} devices are running this app on that Metro and the reload request addressed all of them, not only ${facts.deviceId}.`
              : '';
        const restored = facts.reverseRestored.length
          ? ` The adb reverse for tcp:${facts.metroPort} was missing on ${facts.reverseRestored.join(', ')}, so Stim restored it first.`
          : '';
        console.log(
          `Reload requested for ${facts.appId} on ${facts.deviceName} (${facts.deviceId}) via ${facts.strategy}; ${facts.platform} Metro port ${facts.metroPort}.${restored}${scope} Completion is not observed; verify the expected UI and run stim logs --errors.`,
        );
      }
    });
}

export default function reloadCommand(program: Command): void {
  registerReload(program);
}
