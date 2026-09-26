import { nativeRunCommand } from '../engine/slot-launch.ts';
import { deviceSlotPlatforms, parseDeviceSlotKey } from '../devices/device-slots.ts';
import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { getProject, type ProjectRecord } from '../workspace/config.ts';
import { androidAppProcess, iosAppProcess } from '../engine/app-install.ts';
import { reloadThroughMetro } from '../engine/reload.ts';
import { resolveProjectMetro, type MetroResolution } from '../metro.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { liveWebRecord, sendToOwnedPage } from '../web/page.ts';
import { cdpEndpoint, readWebRecord, type WebRecord } from '../web/state.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { resolveOwnedAvdSerial, type ResolvedAvdSerial } from '../devices/android.ts';
import { resolveOwnedIosSim, type ResolvedIosSim } from '../devices/ios.ts';
import {
  readWorkspaceLaunches,
  type WorkspaceLaunchPlatform,
  type WorkspaceLaunchRecord,
} from '../supervisor/state.ts';

type ReloadPlatform = WorkspaceLaunchPlatform | 'web';

interface ReloadFacts {
  platform: ReloadPlatform;
  deviceId: string;
  deviceName: string;
  appId: string;
  metroPort: number | null;
  strategy: 'metro-websocket' | 'metro-broadcast' | 'cdp';
  targets: number | null;
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
}

interface TargetFailure {
  platform: WorkspaceLaunchPlatform;
  error: ReloadFailure;
}

export interface ReloadDeps {
  findProjectRoot: typeof findProjectRoot;
  getProject: typeof getProject;
  readLaunches: typeof readWorkspaceLaunches;
  resolveIos: (udid: string) => ResolvedIosSim;
  resolveAndroid: (avdName: string) => ResolvedAvdSerial;
  iosProcess: typeof iosAppProcess;
  androidProcess: typeof androidAppProcess;
  resolveMetro: (port: number, root: string) => Promise<MetroResolution>;
  reloadMetro: typeof reloadThroughMetro;
  readBrowser: (root: string) => (WebRecord & { targetId: string }) | null;
  reloadPage: (record: WebRecord & { targetId: string }) => Promise<void>;
}

const DEFAULT_DEPS: ReloadDeps = {
  findProjectRoot,
  getProject,
  readLaunches: readWorkspaceLaunches,
  resolveIos: resolveOwnedIosSim,
  resolveAndroid: resolveOwnedAvdSerial,
  iosProcess: iosAppProcess,
  androidProcess: androidAppProcess,
  resolveMetro: resolveProjectMetro,
  reloadMetro: reloadThroughMetro,
  readBrowser: (root) => liveWebRecord(readWebRecord(root)),
  reloadPage: (record) => sendToOwnedPage(record, 'Page.reload'),
};

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
): Promise<ReloadResult> {
  try {
    await d.reloadPage(browser);
  } catch (error) {
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
      appId: browser.url,
      metroPort,
      strategy: 'cdp',
      targets: 1,
    },
  };
}

function processFailure(
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
  d: ReloadDeps,
  slot = 'default',
): ReloadFailure | null {
  const process =
    platform === 'ios' ? d.iosProcess(record.deviceId, record.appId) : d.androidProcess(record.deviceId, record.appId);
  if (process === undefined) {
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
  if (process === null) {
    return failure(
      'STIM_RELOAD_STOPPED',
      `${record.appId} is not running on ${record.deviceId}.`,
      `Run \`${nativeRunCommand(platform, slot)}\` to launch it.`,
    );
  }
  return null;
}

function inspectTarget(
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
  project: ProjectRecord,
  d: ReloadDeps,
  slot = 'default',
): LiveTarget | TargetFailure {
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
      resolved = d.resolveIos(record.deviceId);
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
    const stopped = processFailure(platform, record, d, slot);
    if (stopped) return { platform, error: stopped };
    return { platform, slot, record, deviceName: resolved.sim.name };
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
    resolved = d.resolveAndroid(configured.avdName);
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
  const stopped = processFailure(platform, record, d, slot);
  if (stopped) return { platform, error: stopped };
  return { platform, slot, record, deviceName: configured.avdName };
}

function isTargetFailure(value: LiveTarget | TargetFailure): value is TargetFailure {
  return 'error' in value;
}

export async function runReload({
  root,
  platform = null,
  deps = {},
}: {
  root: string;
  platform?: ReloadPlatform | null;
  deps?: Partial<ReloadDeps>;
}): Promise<ReloadResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const project = d.getProject(root);
  if (!project) {
    return {
      ok: false,
      error: failure('STIM_NO_PROJECT', `No Stim environment is registered for ${root}.`, 'Run `stim start` first.'),
    };
  }
  const browser = platform === null || platform === 'web' ? d.readBrowser(root) : null;
  if (platform === 'web') {
    return browser
      ? reloadBrowser(browser, project.metroPort ?? null, d)
      : {
          ok: false,
          error: failure(
            'STIM_RELOAD_STOPPED',
            'No owned Chrome is running for this workspace.',
            'Run `stim web` first.',
          ),
        };
  }
  const launches = d.readLaunches(root);
  const inspected = Object.entries(launches).flatMap(([key, record]) => {
    const parsed = parseDeviceSlotKey(key);
    if (!parsed || (platform && parsed.platform !== platform)) return [];
    return [
      inspectTarget(
        parsed.platform,
        record,
        { ...project, platforms: deviceSlotPlatforms(project, parsed.slot) },
        d,
        parsed.slot,
      ),
    ];
  });
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
  if (browser) return reloadBrowser(browser, project.metroPort ?? null, d);
  if (live.length === 0) {
    const firstFailure = inspected.find(isTargetFailure)?.error;
    return {
      ok: false,
      error:
        firstFailure ??
        failure(
          'STIM_RELOAD_STOPPED',
          platform ? `No ${platform} app launch is recorded for this workspace.` : 'No live app launch is recorded.',
          platform ? `Run \`stim ${platform}\` first.` : 'Run `stim ios` or `stim android` first.',
        ),
    };
  }

  const target =
    live.find((candidate) => !candidate.record.release && candidate.record.metroPort === project.metroPort) ?? live[0]!;
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
  const metro = await d.resolveMetro(port, root);
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
  const stopped = processFailure(target.platform, target.record, d, target.slot);
  if (stopped) return { ok: false, error: stopped };

  const reloaded = await d.reloadMetro(port, { role: target.platform, appId: target.record.appId });
  if (!reloaded.ok) {
    const stoppedAfterMetro = processFailure(target.platform, target.record, d, target.slot);
    if (stoppedAfterMetro) return { ok: false, error: stoppedAfterMetro };
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
      const root = (deps.findProjectRoot ?? DEFAULT_DEPS.findProjectRoot)(process.cwd());
      if (!root) {
        refuseNoProject({ json: Boolean(opts.json) });
        return;
      }
      recordWorkspaceUse(root);
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
        console.log(
          `Reload requested for ${facts.appId} on ${facts.deviceName} (${facts.deviceId}) via ${facts.strategy}; ${facts.platform} Metro port ${facts.metroPort}.${scope} Completion is not observed; verify the expected UI and run stim logs --errors.`,
        );
      }
    });
}

export default function reloadCommand(program: Command): void {
  registerReload(program);
}
