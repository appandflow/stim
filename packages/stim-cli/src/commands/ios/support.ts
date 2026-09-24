import { join, basename } from 'node:path';
import chalk from 'chalk';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { shortUdid, phaseLine } from '../../command-output.ts';
import type { DeviceLike, PodStateLike, PodVerdictLike, FailArgs } from './types.ts';
import type { BuildIosResult } from '../../engine/xcode.ts';
import type { SettingsObject } from '../../workspace/settings.ts';
import { unknownIosDeviceTypeRefusal, unknownIosRuntimeRefusal } from '../../engine/device-capacity.ts';
import { parseIosSimulatorApp, type IosSimulatorApp } from '../../devices/ios-simulator-viewer.ts';
import { listIosRuntimes } from '../../devices/ios.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import { describeDiagnostic } from '../../engine/errors-xcode.ts';

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
  remoteBackend: RemoteDeviceBackend | null,
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
  physical,
  remoteBackend,
  listRuntimes,
}: {
  slot?: string;
  deviceTypeFlag: string | undefined;
  runtimeFlag: string | undefined;
  deviceType: string | null;
  runtime: string | null;
  physical: boolean;
  remoteBackend: RemoteDeviceBackend | null;
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
  if (physical || remoteBackend) return null;
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
  const refusal =
    unknownIosRuntimeRefusal(runtime, runtimes) ?? unknownIosDeviceTypeRefusal(deviceType, runtimes, runtime);
  return refusal ? { code: 'STIM_BAD_ARG', message: refusal.message, remedy: refusal.remedy } : null;
}

export function isReleaseConfiguration(configuration: string | null | undefined): boolean {
  return (
    typeof configuration === 'string' && configuration.trim() !== '' && configuration.trim().toLowerCase() !== 'debug'
  );
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
