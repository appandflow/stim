import { ambientContext, ambientEnv } from '@stim-cli/core';
import { operationState } from '../engine/operation-state.ts';
import { InvalidArgumentError } from 'commander';
import { OFFLOAD_MODES, parseMachine, automaticMachineEnabled } from '@stim-cli/core/state';
import type { PlacementSetting, SettingSource } from '../placement-log.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines } from './build-machines.ts';

export const FINGERPRINT_MISMATCH_REMEDY =
  "The build Mac fingerprints the synced checkout differently; the message names the sources that differ. Stim sends tracked and untracked files and the gitignored files the fingerprint reads, except under node_modules. A source still differs when the build Mac's dependency install or pod install writes it differently, or when the app config reads an environment variable or file that differs. Make that input agree on both Macs, for example by committing the lockfile pod install rewrote there, or rerun with --remote-build auto or --remote-build local.";

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy: string;

  constructor(
    machine: string,
    reason: string,
    remedy = 'Run stim doctor --fix to ask for build access if not paired; it prints the stim-server setup command a person runs on the worker to approve this machine. Check stim settings get remote.machines, or rerun with --remote-build auto or --remote-build local.',
  ) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
    this.remedy = remedy;
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

/** The settings that decide where a build runs, with the layer each value came from, for this run's `--remote-build`. */
export function buildPlacementSettings(selected: string): PlacementSetting[] {
  const flag = operationState(ambientContext()).buildMachineFlag;
  const remote = loadConfig()?.remote;
  const rawMode = ambientEnv().STIM_REMOTE_BUILD_MODE || remote?.buildMode;
  return [
    {
      key: 'remote.build',
      value: selected,
      from: settingSource(flag, ambientEnv().STIM_REMOTE_BUILD, remote?.build),
    },
    {
      key: 'remote.buildMode',
      value: selected === 'local' ? 'off' : OFFLOAD_MODES.includes(rawMode as never) ? (rawMode as string) : 'auto',
      from: settingSource(undefined, ambientEnv().STIM_REMOTE_BUILD_MODE, remote?.buildMode),
    },
  ];
}

export function resolveBuildPlacement(flag?: string): {
  selected: string;
  failure?: { code: string; message: string; remedy: string };
} {
  const remote = loadConfig()?.remote;
  operationState(ambientContext()).buildMachineFlag = flag;
  let selected = 'auto';
  try {
    selected = resolveBuildMachine(flag, ambientEnv().STIM_REMOTE_BUILD, remote?.build);
    selected = requireConfiguredMachine(selected, remote?.machines);
    if (namedBuildMachine(selected) && pairedMachines([selected]).length === 0)
      throw new OffloadRefusal(selected, 'no remote machine is paired');
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
