import chalk from 'chalk';
import { phaseLine } from '../../command-output.ts';
import { isJsonObject, type HostedIosPlacement } from '@stim-cli/core/state';
import {
  parseIosRemote,
  remoteIosSetting,
  publicUrlSetting,
  tunnelModeSetting,
  type SettingsObject,
} from '../../workspace/settings.ts';
import { REMOTE_SESSION_ERROR } from '../../engine/device-remote.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import type { IosCommandOptions, FailArgs } from './types.ts';
import type { IosDeps } from './dependencies.ts';
import type { HostedIosTarget } from '../../device-host/hosted-ios.ts';

export function resolveIosRemote({
  opts,
  settings,
  physical,
  recorded,
}: {
  opts: IosCommandOptions;
  settings: SettingsObject;
  physical: boolean;
  recorded?: HostedIosPlacement;
}):
  | { machine: string | null; backend: RemoteDeviceBackend | null; recorded?: HostedIosPlacement }
  | { failure: FailArgs } {
  const target = opts.remote !== undefined ? parseIosRemote(opts.remote) : remoteIosSetting(settings);
  if (target?.kind === 'machine' && target.machine === 'auto')
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message:
          'stim ios --remote auto is not available yet: automatic placement has not shipped. Name a hosting Mac from hosting.machines.',
      },
    };
  if (physical && target?.kind === 'machine')
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: '--device builds for a phone connected to this machine, and --remote installs on a remote one.',
        remedy: 'Pass only one of --device and --remote; unset ios.remote for a local phone.',
      },
    };
  const machine = target?.kind === 'machine' ? target.machine : null;
  if (recorded && recorded.machine !== machine)
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: `This workspace's iOS simulator runs on ${recorded.machine}; run stim stop first.`,
      },
    };
  return { machine, backend: !physical && target?.kind === 'backend' ? target.backend : null, recorded };
}

export function hostedIosSelectors(
  deviceType: string | null,
  runtime: string | null,
): { deviceType?: string; runtime?: string } {
  return { ...(deviceType ? { deviceType } : {}), ...(runtime ? { runtime } : {}) };
}

export async function connectIosTarget(
  selection: ReturnType<typeof resolveIosRemote> & { machine: string | null; recorded?: HostedIosPlacement },
  selectors: ReturnType<typeof hostedIosSelectors>,
  d: IosDeps,
): Promise<{ target: HostedIosTarget | null } | { failure: FailArgs }> {
  if (!selection.machine) return { target: null };
  try {
    return { target: await d.prepareHostedIos(selection.machine, selectors, selection.recorded) };
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
    return { failure: { code: error.code, message: error.message } };
  }
}

export function hostedIosBuildTarget(target: HostedIosTarget | null): {
  hostedDestination?: { runtime: string; architecture: 'arm64' | 'x86_64' };
} {
  return target
    ? { hostedDestination: { runtime: target.choice.runtimeId, architecture: target.choice.architecture } }
    : {};
}

export async function iosPlacementBudget(
  d: IosDeps,
  root: string,
  note: (line: string) => void,
  hosted: boolean,
): ReturnType<IosDeps['budgetGate']> {
  return hosted ? { reclaimed: [], refusal: null } : d.budgetGate({ root, note });
}

export function hostedIosMetroNote(hosted: boolean, settings: SettingsObject, note: (line: string) => void): void {
  if (hosted && settings.iosSimulatorApp !== undefined)
    note(chalk.dim(phaseLine('device', 'iosSimulatorApp is ignored on a hosting Mac; the simulator boots headless.')));
  if (hosted && (publicUrlSetting(settings) || tunnelModeSetting(settings)))
    note(
      chalk.dim(
        phaseLine(
          'metro',
          'metro.publicUrl and metro.tunnel are ignored on a hosting Mac; Metro uses the private tailnet bridge.',
        ),
      ),
    );
}

export async function connectIosBackend(
  root: string,
  backend: RemoteDeviceBackend | null,
  deviceType: string | undefined,
  d: IosDeps,
): Promise<
  | {
      remote: ReturnType<IosDeps['remoteIosDeps']> | null;
      arch: Awaited<ReturnType<IosDeps['readRemoteSimulatorArch']>> | null;
    }
  | { failure: FailArgs }
> {
  if (!backend) return { remote: null, arch: null };
  const resolved = await d.resolveRemoteContext({
    root,
    backend,
    easBin: d.resolveEasCliBin(root)?.file ?? null,
    deviceType: deviceType?.trim() || null,
  });
  if ('failed' in resolved)
    return {
      failure: { code: resolved.code ?? REMOTE_SESSION_ERROR, message: resolved.failed, remedy: resolved.remedy },
    };
  return { remote: d.remoteIosDeps(resolved.ctx), arch: await d.readRemoteSimulatorArch(resolved.ctx.existingDaemon) };
}

export function iosMetroSettings(settings: SettingsObject, hosted: boolean): SettingsObject {
  return hosted
    ? {
        ...settings,
        ios: { ...(isJsonObject(settings.ios) ? settings.ios : {}), remote: undefined },
        android: { ...(isJsonObject(settings.android) ? settings.android : {}), remote: undefined },
        metro: {
          ...(isJsonObject(settings.metro) ? settings.metro : {}),
          tunnel: undefined,
          publicUrl: undefined,
          ngrokUrl: undefined,
        },
      }
    : settings;
}
