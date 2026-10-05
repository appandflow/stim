import { InvalidArgumentError } from 'commander';
import { parseMachine } from '@stim-cli/core/state';
import { loadConfig } from '../workspace/config.ts';
import { pairedMachines } from './build-machines.ts';

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy =
    'Run stim doctor --fix to ask for build access if not paired. On the worker, a person finds the id with stim-server devices and approves it with stim-server devices grant <id> --build. Check stim settings get offload.machines, or rerun with --build-machine auto or --build-machine local.';

  constructor(machine: string, reason: string) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
  }
}

export function resolveBuildMachine(flag?: string, env?: string, setting?: unknown): string {
  const selected = flag ?? (env?.trim() || undefined) ?? setting ?? 'auto';
  if (typeof selected !== 'string' || !selected.trim() || !parseMachine(selected)) {
    throw Object.assign(
      new Error('--build-machine / offload.machine must be auto, local, or a tailnet machine name.'),
      { code: 'STIM_BAD_ARG' },
    );
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
    throw new OffloadRefusal(selected, `not listed in offload.machines (configured: ${entries.join(', ') || 'none'})`);
  return match;
}

export function resolveBuildPlacement(flag?: string): {
  selected: string;
  failure?: { code: string; message: string; remedy: string };
} {
  const offload = loadConfig()?.offload;
  let selected = 'auto';
  try {
    selected = resolveBuildMachine(flag, process.env.STIM_OFFLOAD_MACHINE, offload?.machine);
    selected = requireConfiguredMachine(selected, offload?.machines);
    if (namedBuildMachine(selected) && pairedMachines([selected]).length === 0)
      throw new OffloadRefusal(selected, 'no build machine is paired');
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
            : 'Pass --build-machine auto, local, or an entry from stim settings get offload.machines.',
      },
    };
  }
}
