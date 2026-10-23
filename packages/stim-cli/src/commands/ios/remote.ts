import type { StimContext } from '@stim-cli/core';
import type { IosSimSnapshot } from '../../devices/ios.ts';
import { runCancellationSignal } from '../../engine/native-run.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { resolveSimulatorAppFlag } from './support.ts';
import { devicePlacementRecord, type PlacementRecord } from '../../placement-log.ts';
import { devicePlacementLine } from '../../device-host/auto-placement.ts';
import { deviceSlotPlatforms } from '../../devices/device-slots.ts';
import chalk from 'chalk';
import { phaseLine } from '../../command-output.ts';
import {
  type AutomaticPlacement,
  type DevicePlacement,
  type HostedIosPlacement,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import {
  parseIosRemote,
  remoteEasFallbackSetting,
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

export function deviceRemoteConflict(remote: string | undefined, physical: boolean): FailArgs | null {
  if (!physical || remote === undefined || !parseIosRemote(remote)) return null;
  return {
    code: 'STIM_BAD_ARG',
    message: `--device runs on a phone connected to this machine, and --remote ${remote} chooses where a simulator runs.`,
    remedy: 'Pass only one of --device and --remote, or --remote local with --device.',
  };
}

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
  | {
      machine: string | null;
      placement?: AutomaticPlacement;
      backend: RemoteDeviceBackend | null;
      recorded?: HostedIosPlacement;
    }
  | { failure: FailArgs } {
  const target = opts.remote !== undefined ? parseIosRemote(opts.remote) : physical ? null : remoteIosSetting(settings);
  const machine = target?.kind === 'machine' ? target.machine : null;
  if (recorded && recorded.machine !== machine && machine !== 'auto')
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: `This workspace's iOS simulator runs on ${recorded.machine}; run stim stop first.`,
      },
    };
  return {
    machine,
    ...(target?.kind === 'machine' && target.placement ? { placement: target.placement } : {}),
    backend: !physical && target?.kind === 'backend' ? target.backend : null,
    recorded,
  };
}

export function selectIosTarget({
  root,
  slot,
  opts,
  settings,
  physical,
  appMode,
  metroCheck,
  d,
}: {
  root: string;
  slot: string;
  opts: IosCommandOptions;
  settings: SettingsObject;
  physical: boolean;
  release: boolean;
  appMode: HostedAppOffer['mode'];
  metroCheck: boolean;
  d: IosDeps;
}): ReturnType<typeof resolveIosRemote> {
  let recorded;
  try {
    recorded = d.readHostedIos(root, slot)[slot];
  } catch (error) {
    return {
      failure: {
        code: 'STIM_HOSTING_REFUSED',
        message: (error as Error).message,
        ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? { remedy: error.remedy }
          : {}),
      },
    };
  }
  const selection = resolveIosRemote({ opts, settings, physical, recorded });
  if ('failure' in selection) return selection;
  const localIos = selection.machine ? deviceSlotPlatforms(d.getProject(root), slot)?.ios : undefined;
  if (selection.machine !== 'auto' && selection.machine && localIos?.owned && localIos.deviceUdid) {
    let localRunning = true;
    try {
      localRunning = d
        .listAllIosSims({ timeoutMs: 5000 })
        .some((sim) => sim.udid === localIos.deviceUdid && sim.state !== 'Shutdown');
    } catch {}
    if (localRunning)
      return {
        failure: {
          code: 'STIM_BAD_ARG',
          message: `This workspace's iOS simulator for slot ${slot} runs on this Mac; run stim stop first.`,
        },
      };
  }
  if (selection.machine !== 'auto' && selection.machine && appMode === 'development' && !metroCheck)
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: 'Hosted Debug runs require the local Metro supervisor; --no-metro-check cannot be used.',
        remedy: 'Run stim stop; stim start, then retry without --no-metro-check.',
      },
    };
  return selection;
}

export async function selectIosPlacement(
  args: Parameters<typeof selectIosTarget>[0] & {
    supportsRemote: boolean;
    simSnapshot: IosSimSnapshot;
    validateSelectors: () => FailArgs | null | Promise<FailArgs | null>;
    deviceType: string | null;
    runtime: string | null;
    noWait: boolean;
    waitMs?: number;
    env?: NodeJS.ProcessEnv;
    operation?: StimContext;
    note: (line: string) => void;
    phase: (label: string, line: string) => void;
    log?: (record: PlacementRecord) => void;
  },
): Promise<
  | (ReturnType<typeof resolveIosRemote> & {
      machine: string | null;
      auto?: { target: HostedIosTarget | null };
      budget?: Awaited<ReturnType<IosDeps['budgetGate']>>;
      devicePlacement?: DevicePlacement;
    })
  | { failure: FailArgs }
> {
  const selection = selectIosTarget(args);
  if ('failure' in selection || selection.machine !== 'auto') return selection;
  const { root, slot, d, opts, deviceType, runtime, noWait, waitMs, phase, log, release, appMode, metroCheck } = args;
  const signal = runCancellationSignal(args.operation) ?? args.operation?.signal;
  const viewer = resolveSimulatorAppFlag(opts.simulatorApp, args.physical, null);
  if ('refusal' in viewer) return { failure: viewer.refusal };
  const refusal = await args.validateSelectors();
  if (refusal) return { failure: refusal };
  const easFallback = args.supportsRemote && remoteEasFallbackSetting(args.settings);
  const localSims = await args.simSnapshot
    .readAsync?.({ signal: args.operation?.signal, operation: args.operation })
    .then((sims) => sims.filter((sim) => sim.available))
    .catch((error: unknown) => {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      args.operation?.signal.throwIfAborted();
      return undefined;
    });
  try {
    const placed = await d.automaticDevicePlacement({
      root,
      slot,
      platform: 'ios',
      placement: selection.placement,
      ...(localSims ? { localSims } : {}),
      selectors: hostedIosSelectors(deviceType, runtime),
      appMode,
      buildMachine: opts.remoteBuild,
      noWait,
      ...(waitMs === undefined ? {} : { waitMs }),
      onWait: (line) => phase('placement:', line),
      signal,
      ...(easFallback
        ? {
            eas: () =>
              d.checkEasFallback({
                root,
                platform: 'ios',
                env: args.env,
                operation: args.operation,
                slot,
                release,
                isExpo: d.detectIsExpo(root),
                tunnelMode: tunnelModeSetting(args.settings),
                publicUrl: publicUrlSetting(args.settings),
                deviceTypeFlag: opts.deviceType,
                localOnlyFlags: typeof opts.runtime === 'string' ? ['--runtime'] : [],
              }),
          }
        : {}),
    });
    phase('placement:', devicePlacementLine(placed.placement, placed.skipped));
    log?.(
      devicePlacementRecord({
        platform: 'ios',
        selected: selection.placement,
        fromFlag: opts.remote !== undefined,
        easFallback,
        placed,
      }),
    );
    if (placed.placement.decision === 'eas')
      return {
        ...selection,
        machine: null,
        backend: 'eas',
        recorded: undefined,
        auto: { target: null },
        devicePlacement: placed.placement,
      };
    if (placed.target && appMode === 'development' && !metroCheck)
      return {
        failure: {
          code: 'STIM_BAD_ARG',
          message: 'Hosted Debug runs require the local Metro supervisor; --no-metro-check cannot be used.',
          remedy: 'Run stim stop; stim start, then retry without --no-metro-check.',
        },
      };
    return {
      ...selection,
      machine: placed.target?.host.machine ?? null,
      recorded: undefined,
      auto: { target: placed.target as HostedIosTarget | null },
      budget: placed.target ? { reclaimed: [], refusal: null } : undefined,
      devicePlacement: placed.placement,
    };
  } catch (error) {
    if (signal?.aborted)
      return {
        failure: {
          code: 'STIM_CANCELLED',
          message: 'The run was cancelled while it waited for a remote machine.',
          remedy: 'Run the command again when you want the app on a device.',
        },
      };
    return {
      failure: {
        code: (error as Error & { code?: string }).code ?? 'STIM_HOSTING_REFUSED',
        message: (error as Error).message,
        ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? { remedy: error.remedy }
          : {}),
      },
    };
  }
}

export function hostedIosSelectors(
  deviceType: string | null,
  runtime: string | null,
): { deviceType?: string; runtime?: string } {
  return { ...(deviceType ? { deviceType } : {}), ...(runtime ? { runtime } : {}) };
}

export async function connectIosTarget(
  selection: ReturnType<typeof resolveIosRemote> & {
    machine: string | null;
    recorded?: HostedIosPlacement;
    auto?: { target: HostedIosTarget | null };
  },
  selectors: ReturnType<typeof hostedIosSelectors>,
  d: IosDeps,
  appMode?: HostedAppOffer['mode'],
): Promise<{ target: HostedIosTarget | null } | { failure: FailArgs }> {
  if (selection.auto) return { target: selection.auto.target };
  if (!selection.machine) return { target: null };
  try {
    return { target: await d.prepareHostedIos(selection.machine, selectors, selection.recorded, appMode) };
  } catch (error) {
    return {
      failure: {
        code:
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'STIM_HOSTING_REFUSED',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? { remedy: error.remedy }
          : {}),
      },
    };
  }
}

export async function iosPlacementBudget(
  d: IosDeps,
  root: string,
  note: (line: string) => void,
  hosted: boolean,
  automatic?: Awaited<ReturnType<IosDeps['budgetGate']>>,
  simSnapshot?: IosSimSnapshot,
  env?: NodeJS.ProcessEnv,
): ReturnType<IosDeps['budgetGate']> {
  if (automatic) return { ...automatic, refusal: hosted ? null : automatic.refusal };
  return hosted ? { reclaimed: [], refusal: null } : d.budgetGate({ root, note, simSnapshot, env });
}

export function hostedIosMetroNote(
  hosted: boolean,
  settings: SettingsObject,
  note: (line: string) => void,
  simulatorApp?: string,
): void {
  if (hosted && (settings.iosSimulatorApp !== undefined || simulatorApp !== undefined))
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
  env?: NodeJS.ProcessEnv,
  operation?: StimContext,
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
    env,
    operation,
    easBin: d.resolveEasCliBin(root)?.file ?? null,
    deviceType: deviceType?.trim() || null,
  });
  if ('failed' in resolved)
    return {
      failure: { code: resolved.code ?? REMOTE_SESSION_ERROR, message: resolved.failed, remedy: resolved.remedy },
    };
  return { remote: d.remoteIosDeps(resolved.ctx), arch: await d.readRemoteSimulatorArch(resolved.ctx.existingDaemon) };
}
