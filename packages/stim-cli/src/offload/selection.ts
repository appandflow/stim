import { ambientContext, ambientEnv } from '@stim-cli/core';
import { operationState } from '../engine/operation-state.ts';
import { InvalidArgumentError } from 'commander';
import { parseMachine, automaticMachineEnabled, placementWord } from '@stim-cli/core/state';
import type { PlacementSetting, SettingSource } from '../placement-log.ts';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines } from './build-machines.ts';

const FINGERPRINT_MISMATCH_REMEDY =
  "The build Mac fingerprints the synced checkout differently; the message names the sources that differ. Stim sends tracked and untracked files and the gitignored files the fingerprint reads, except under node_modules. A source still differs when the build Mac's dependency install or pod install writes it differently, or when the app config reads an environment variable or file that differs. Make that input agree on both Macs, for example by committing the lockfile pod install rewrote there, or rerun with --remote-build auto or --remote-build local.";

/** The remedy for a React Native worker's fingerprint-mismatch reason, or undefined for any other reason. */
export function fingerprintMismatchRemedy(reason: string): string | undefined {
  return reason.startsWith('fingerprint-mismatch: the checkout there ') ? FINGERPRINT_MISMATCH_REMEDY : undefined;
}

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy: string;

  constructor(
    machine: string,
    reason: string,
    remedy = 'Run stim doctor --fix to ask for build access if not paired; it prints the stim-server setup command a person runs on the worker to approve this machine. Check stim settings get remote.machines, or rerun with --remote-build auto, remote or local.',
  ) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
    this.remedy = remedy;
  }
}

export function resolveBuildMachine(flag?: string, env?: string, setting?: unknown): string {
  const selected = flag ?? (env?.trim() || undefined) ?? setting ?? 'auto';
  if (typeof selected !== 'string' || !selected.trim() || !parseMachine(selected)) {
    throw Object.assign(
      new Error('--remote-build / remote.build must be local, auto, remote, remote-only, or a tailnet machine name.'),
      { code: 'STIM_BAD_ARG' },
    );
  }
  return placementWord(selected) ?? selected.trim();
}

export function parseBuildMachineOption(value: string): string {
  try {
    return resolveBuildMachine(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

/** Whether `selected` lets Stim choose among this machine and `remote.machines` rather than naming one place. */
export function automaticBuild(selected: string): boolean {
  const word = placementWord(selected);
  return word !== null && word !== 'local';
}

/**
 * Refuses a build that would run on this machine when the selection or the build pool excludes it, giving `reason`
 * (why the build could not go elsewhere) first.
 */
export function requireLocalBuild(selected: string, reason?: string): void {
  const word = placementWord(selected);
  const lead = reason ? `${reason}; ` : '';
  if (word === 'remote-only') throw new OffloadRefusal(selected, `${lead}remote-only never builds on this machine`);
  if ((word === 'auto' || word === 'remote') && !automaticMachineEnabled('build', 'local'))
    throw new OffloadRefusal(
      selected,
      `${lead}local is disabled in remote.buildPoolDisabled; enable it or select a machine explicitly`,
    );
}

/** Whether `selected` names one machine, which takes the build with no fallback and no other machine considered. */
export function namedBuildMachine(selected: string): boolean {
  return placementWord(selected) === null;
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
  return [
    {
      key: 'remote.build',
      value: selected,
      from: settingSource(flag, ambientEnv().STIM_REMOTE_BUILD, loadConfig()?.remote?.build),
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
            : 'Pass --remote-build local, auto, remote, remote-only, or an entry from stim settings get remote.machines.',
      },
    };
  }
}
