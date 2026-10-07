import type { BuildProgress } from '../../engine/build-progress.ts';
import type { RunRecorder } from '../../engine/stats.ts';
import { parseDeviceWait } from '../../engine/device-lease-run.ts';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { shortUdid, phaseLine } from '../../command-output.ts';
import type { IosCommandOptions, DeviceLike, PodStateLike, PodVerdictLike, FailArgs } from './types.ts';
import type { BuildIosResult } from '../../engine/xcode.ts';
import type { SettingsObject } from '../../workspace/settings.ts';
import type { SettingScope } from '@stim-cli/core/state';
import {
  DEFAULT_DEVICE_SLOT_WAIT_MS,
  type DeviceSlotWaitPolicy,
  layerNote,
  unknownIosDeviceTypeRefusal,
  unknownIosRuntimeRefusal,
} from '../../engine/device-capacity.ts';
import { parseIosSimulatorApp, type IosSimulatorApp } from '../../devices/ios-simulator-viewer.ts';
import { listIosRuntimes } from '../../devices/ios.ts';
import { IosDeviceMismatchError } from '../../engine/device-ios.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import { describeDiagnostic } from '../../engine/errors-xcode.ts';
import type { SimulatorArch } from '../../engine/agent-device.ts';

export const PLATFORM = 'ios';

export function buildLogFile(root: string): string {
  return join(workspaceLogsDir(root), `build-${PLATFORM}.ndjson`);
}

const MAX_PRINTED_DIAGNOSTICS = 6;

export function deviceLabel(device: DeviceLike | null | undefined, udid: unknown): string {
  const name = device?.deviceName || device?.name || null;
  return name ? `${name} (${shortUdid(udid)})` : shortUdid(udid);
}

export function deviceShortName(device: DeviceLike | null | undefined, udid: unknown): string {
  return device?.deviceName || device?.name || shortUdid(udid);
}

export function appNameFromPath(appPath: unknown): string | null {
  if (typeof appPath !== 'string' || appPath.trim() === '') return null;
  const name = basename(appPath).replace(/\.app$/i, '');
  return name === '' ? null : name;
}

export function iosConfigurationSetting(settings: SettingsObject | null | undefined): string | null {
  const ios = settings?.['ios'];
  if (!ios || typeof ios !== 'object' || Array.isArray(ios)) return null;
  const raw = (ios as Record<string, unknown>)['configuration'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveConfiguration(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosConfigurationSetting(settings);
}

function iosStringSetting(settings: SettingsObject | null | undefined, key: string): string | null {
  const ios = settings?.['ios'];
  if (!ios || typeof ios !== 'object' || Array.isArray(ios)) return null;
  const raw = (ios as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveDeviceType(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosStringSetting(settings, 'deviceType');
}

export function resolveRuntime(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosStringSetting(settings, 'runtime');
}

export function resolveSimulatorAppFlag(
  flag: string | undefined,
  physical: boolean,
  remoteBackend: string | null,
): { simulatorApp?: IosSimulatorApp } | { refusal: FailArgs } {
  if (flag === undefined) return {};
  let simulatorApp: IosSimulatorApp;
  try {
    simulatorApp = parseIosSimulatorApp(flag, '--simulator-app');
  } catch (error) {
    return { refusal: { code: 'STIM_BAD_ARG', message: (error as Error).message } };
  }
  if (physical || remoteBackend) {
    return {
      refusal: {
        code: 'STIM_BAD_ARG',
        message: '--simulator-app only applies to a local owned iOS simulator.',
        remedy: 'Drop --simulator-app when using a physical or remote device.',
      },
    };
  }
  return { simulatorApp };
}

export function deviceModelRefusal({
  slot,
  deviceTypeFlag,
  runtimeFlag,
  deviceType,
  runtime,
  deviceTypeOrigin = null,
  runtimeOrigin = null,
  physical,
  remoteBackend,
  hosted = false,
  listRuntimes,
}: {
  slot?: string;
  deviceTypeFlag: string | undefined;
  runtimeFlag: string | undefined;
  deviceType: string | null;
  runtime: string | null;
  deviceTypeOrigin?: SettingScope | null;
  runtimeOrigin?: SettingScope | null;
  physical: boolean;
  remoteBackend: RemoteDeviceBackend | null;
  hosted?: boolean;
  listRuntimes: typeof listIosRuntimes;
}): { code: string; message: string; remedy: string } | null {
  if (slot && slot !== 'default' && remoteBackend)
    return {
      code: 'STIM_BAD_ARG',
      message: 'Named slots currently support local simulators and physical devices.',
      remedy: 'Use the default slot for a remote session.',
    };
  if (typeof deviceTypeFlag === 'string' && deviceTypeFlag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--device-type was given an empty name.',
      remedy:
        'Pass `--device-type <name>` with a model `xcrun simctl list devicetypes` names, e.g. "iPad Pro 13-inch (M5)".',
    };
  }
  if (typeof runtimeFlag === 'string' && runtimeFlag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--runtime was given an empty version.',
      remedy: 'Pass `--runtime <version>` with a runtime `xcrun simctl list runtimes` reports, e.g. "18.5".',
    };
  }
  if (remoteBackend) {
    const eas = remoteBackend === 'eas';
    const given = [!eas && deviceTypeFlag && '--device-type', runtimeFlag && '--runtime'].filter(Boolean).join(' and ');
    if (given) {
      return {
        code: 'STIM_BAD_ARG',
        message: `${given} ${given.includes(' and ') ? 'apply' : 'applies'} only to a local owned iOS simulator; the ${remoteBackend} remote backend chooses its own ${eas ? 'iOS runtime' : 'device'}.`,
        remedy: `Drop ${given} for a remote run. For a local owned simulator, drop --remote and unset ios.remote with \`stim settings unset ios.remote --scope <workspace|repo|committed>\`.`,
      };
    }
    return null;
  }
  if (physical || hosted) return null;
  if (!deviceType && !runtime) return null;
  let runtimes;
  try {
    runtimes = listRuntimes();
  } catch (error) {
    return {
      code: 'STIM_NO_DEVICE',
      message: `Could not read the installed simulator runtimes: ${(error as Error)?.message || error}`,
      remedy: 'Run `stim doctor` to check the simulator toolchain, then try again.',
    };
  }
  const runtimeRefusal = unknownIosRuntimeRefusal(runtime, runtimes);
  if (runtimeRefusal) {
    const { message, remedy } = layerNote(runtimeRefusal, 'ios.runtime', runtimeFlag, runtimeOrigin);
    return { code: 'STIM_BAD_ARG', message, remedy };
  }
  const deviceTypeRefusal = unknownIosDeviceTypeRefusal(deviceType, runtimes, runtime);
  if (deviceTypeRefusal) {
    const { message, remedy } = layerNote(deviceTypeRefusal, 'ios.deviceType', deviceTypeFlag, deviceTypeOrigin);
    return { code: 'STIM_BAD_ARG', message, remedy };
  }
  return null;
}

export function ownedSimFailure(error: unknown): { code: string; message: string; remedy: string } {
  return {
    code: 'STIM_NO_DEVICE',
    message: `Could not ensure an owned iOS simulator: ${(error as Error)?.message || error}`,
    remedy:
      error instanceof IosDeviceMismatchError
        ? error.remedy
        : 'Run `stim doctor` to check the simulator toolchain, then try again.',
  };
}

export function isReleaseConfiguration(configuration: string | null | undefined): boolean {
  return (
    typeof configuration === 'string' && configuration.trim() !== '' && configuration.trim().toLowerCase() !== 'debug'
  );
}

export function simulatorBuildArch({
  physical,
  remoteArch,
  hostArch,
  configuration,
}: {
  physical: boolean;
  remoteArch: SimulatorArch | null;
  hostArch: SimulatorArch;
  configuration: string | null | undefined;
}): SimulatorArch | null {
  if (physical) return null;
  if (remoteArch) return remoteArch;
  return isReleaseConfiguration(configuration) ? null : hostArch;
}

export function iosProviderRunOptions(
  configuration: string | null | undefined,
  arch: SimulatorArch | null,
): { configuration?: string; arch?: SimulatorArch } | null {
  if (arch) return { configuration: configuration || 'Debug', arch };
  return configuration ? { configuration } : null;
}

export function podAction(
  podState: PodStateLike | null | undefined,
  verdict: PodVerdictLike | null | undefined,
): { install: boolean; reason?: string } {
  if (verdict?.stale) return { install: true, reason: verdict.reason };
  if (verdict?.noPods && podState?.hasPodfile) {
    return { install: true, reason: 'ios/Podfile exists but no pods are installed' };
  }
  return { install: false };
}

export function xcodeFailureReport(
  result: Extract<BuildIosResult, { ok: false }>,
  logPath: string,
): { message: string; remedy: string } {
  const diagnostics = result.diagnostics;
  const code = result.exitCode;
  const how = code === null ? '' : ` (exit code ${code})`;
  const message = diagnostics.length
    ? `\`xcodebuild\` failed${how} with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}.`
    : `\`xcodebuild\` failed${how} with no recognizable diagnostic.`;
  const remedy = diagnostics.find((d) => d?.remedy)?.remedy || `See ${logPath} for the transcript.`;
  return { message, remedy };
}

export function printDiagnostics(note: (line: string) => void, result: Extract<BuildIosResult, { ok: false }>): void {
  const diagnostics = result.diagnostics;
  const shown = diagnostics.slice(0, MAX_PRINTED_DIAGNOSTICS);
  for (const diagnostic of shown) {
    note(chalk.red(phaseLine('error', describeDiagnostic(diagnostic))));
  }
  const hidden = diagnostics.length - shown.length + result.truncated;
  if (hidden > 0) {
    note(chalk.dim(phaseLine('error', `... and ${hidden} more diagnostic${hidden === 1 ? '' : 's'} in the log`)));
  }
  if (diagnostics.length === 0) {
    note(chalk.red(phaseLine('error', 'xcodebuild failed with no recognizable diagnostic; last lines:')));
    for (const line of result.tail.slice(-5)) note(chalk.dim(phaseLine('', line)));
  }
}

export function resolveIosWait(
  opts: IosCommandOptions,
  physical: boolean,
): { waitSeconds: number; noWait: boolean; deviceSlotWaitMs: number; checkCapacity: boolean } | { failure: FailArgs } {
  const noWait = opts.wait === false;
  if (opts.waitConflict) {
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: '--wait and --no-wait ask for opposite things.',
        remedy: 'Pass only one of `--wait <seconds>` and `--no-wait`.',
      },
    };
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : opts.wait);
  if ('error' in waitParsed) {
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: waitParsed.error,
        remedy:
          'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a busy lease or device slot at once.',
      },
    };
  }
  return {
    waitSeconds: waitParsed.seconds,
    noWait,
    checkCapacity: !physical && (noWait || waitParsed.seconds === 0),
    deviceSlotWaitMs: noWait
      ? 0
      : opts.wait === undefined && !physical
        ? DEFAULT_DEVICE_SLOT_WAIT_MS
        : waitParsed.seconds * 1000,
  };
}

interface IosDeviceWaitRun {
  policy: DeviceSlotWaitPolicy;
  record: RunRecorder['record'];
  booting(pending: { done: Promise<unknown> } | undefined): void;
  finish(): Promise<void>;
}

export function createIosDeviceWaitRun(stats: RunRecorder, progress: BuildProgress): IosDeviceWaitRun {
  const controller = new AbortController();
  let waiting = false;
  let boot: Promise<unknown> | undefined;
  let outcome: Parameters<RunRecorder['record']>[0] | undefined;
  return {
    policy: {
      signal: controller.signal,
      waitingFor(info) {
        waiting = info !== null;
        progress.waitingFor(info, 'device-slot');
      },
      onWait: stats.addDeviceSlotWaitMs,
    },
    record(next) {
      if (waiting) outcome = next;
      else stats.record(next);
    },
    booting(pending) {
      boot ??= pending?.done;
    },
    async finish() {
      const queued = waiting;
      controller.abort();
      if (queued) await boot?.catch(() => {});
      if (outcome) stats.record(outcome);
    },
  };
}
