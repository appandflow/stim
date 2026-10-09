import { InvalidArgumentError } from 'commander';
import { OFFLOAD_MODES, parseMachine, automaticMachineEnabled } from '@stim-cli/core/state';
import type { PlacementSetting, SettingSource } from '../placement-log.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines } from './build-machines.ts';

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy =
    'Run stim doctor --fix to ask for build access if not paired. On the worker, a person finds the id with stim-server devices and approves it with stim-server devices grant <id> --build. Check stim settings get remote.machines, or rerun with --remote-build auto or --remote-build local.';

  constructor(machine: string, reason: string) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
  }
}

export function resolveBuildMachine(flag?: string, env?: string, setting?: unknown): string {
  const selected = flag ?? (env?.trim() || undefined) ?? setting ?? 'auto';
  if (typeof selected !== 'string' || !selected.trim() || !parseMachine(selected)) {
    throw Object.assign(new Error('--remote-build / remote.build must be auto, local, or a tailnet machine name.'), {
      code: 'STIM_BAD_ARG',
    });
  }
  const trimmed = selected.trim();
  const reserved = trimmed.toLowerCase();
  return reserved === 'auto' || reserved === 'local' ? reserved : trimmed;
}

export function parseBuildMachineOption(value: string): string {
  try {
    return resolveBuildMachine(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

export function requireLocalBuild(selected: string): void {
  if (selected === 'auto' && !automaticMachineEnabled('build', 'local'))
    throw new OffloadRefusal(
      'auto',
      'local is disabled in remote.buildPoolDisabled; enable it or select a machine explicitly',
    );
}

export function namedBuildMachine(selected: string): boolean {
  return selected !== 'auto' && selected !== 'local';
}

export function requireConfiguredMachine(selected: string, machines: unknown): string {
  if (!namedBuildMachine(selected)) return selected;
  const parsed = parseMachine(selected)!;
  const entries = Array.isArray(machines) ? machines.filter((entry): entry is string => typeof entry === 'string') : [];
  const match = entries.find((entry) => {
    const candidate = parseMachine(entry);
    return candidate?.name === parsed.name && candidate.port === parsed.port;
  });
  if (!match)
    throw new OffloadRefusal(selected, `not listed in remote.machines (configured: ${entries.join(', ') || 'none'})`);
  return match;
}

const settingSource = (flag: string | undefined, env: string | undefined, setting: unknown): SettingSource =>
  flag !== undefined ? 'flag' : env?.trim() ? 'env' : setting !== undefined ? 'setting' : 'default';

let buildMachineFlag: string | undefined;

/** The settings that decide where a build runs, with the layer each value came from, for this run's `--remote-build`. */
export function buildPlacementSettings(selected: string): PlacementSetting[] {
  const flag = buildMachineFlag;
  const remote = loadConfig()?.remote;
  const rawMode = process.env.STIM_REMOTE_BUILD_MODE || remote?.buildMode;
  return [
    {
      key: 'remote.build',
      value: selected,
      from: settingSource(flag, process.env.STIM_REMOTE_BUILD, remote?.build),
    },
    {
      key: 'remote.buildMode',
      value: selected === 'local' ? 'off' : OFFLOAD_MODES.includes(rawMode as never) ? (rawMode as string) : 'auto',
      from: settingSource(undefined, process.env.STIM_REMOTE_BUILD_MODE, remote?.buildMode),
    },
  ];
}

export function resolveBuildPlacement(flag?: string): {
  selected: string;
  failure?: { code: string; message: string; remedy: string };
} {
  const remote = loadConfig()?.remote;
  buildMachineFlag = flag;
  let selected = 'auto';
  try {
    selected = resolveBuildMachine(flag, process.env.STIM_REMOTE_BUILD, remote?.build);
    selected = requireConfiguredMachine(selected, remote?.machines);
    if (namedBuildMachine(selected) && pairedMachines([selected]).length === 0)
      throw new OffloadRefusal(selected, 'no remote Mac is paired');
    return { selected };
  } catch (error) {
    return {
      selected,
      failure: {
        code: (error as { code: string }).code,
        message: (error as Error).message,
        remedy:
          error instanceof OffloadRefusal
            ? error.remedy
            : 'Pass --remote-build auto, local, or an entry from stim settings get remote.machines.',
      },
    };
  }
}
