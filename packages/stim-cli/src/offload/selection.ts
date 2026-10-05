import { loadConfig } from '../workspace/config.ts';
import { parseMachine } from '@stim-cli/core/state';

export class OffloadRefusal extends Error {
  readonly code = 'STIM_OFFLOAD_REFUSED';
  readonly remedy =
    'Check stim settings get offload.machines and build pairing. Approve this Mac on the worker with stim-server devices grant <id> --build, or rerun with --build-machine auto or --build-machine local.';

  constructor(machine: string, reason: string) {
    super(reason.startsWith(`${machine}: `) ? reason : `${machine}: ${reason}`);
  }
}

export function resolveBuildMachine(flag?: string, env?: string, setting?: unknown): string {
  const selected = flag ?? env ?? setting ?? 'auto';
  if (typeof selected !== 'string' || !selected.trim() || !parseMachine(selected)) {
    throw Object.assign(
      new Error('--build-machine / offload.machine must be auto, local, or a tailnet machine name.'),
      {
        code: 'STIM_BAD_ARG',
      },
    );
  }
  return selected.trim();
}

export function namedBuildMachine(selected: string): boolean {
  return selected !== 'auto' && selected !== 'local';
}

export function requireConfiguredMachine(selected: string, machines: unknown): void {
  if (namedBuildMachine(selected) && (!Array.isArray(machines) || !machines.includes(selected))) {
    throw new OffloadRefusal(selected, 'not listed in offload.machines');
  }
}

export function resolveBuildPlacement(flag?: string): {
  selected: string;
  failure?: { code: string; message: string; remedy: string };
} {
  let selected = 'auto';
  try {
    const offload = loadConfig()?.offload;
    selected = resolveBuildMachine(flag, process.env.STIM_OFFLOAD_MACHINE, offload?.machine);
    requireConfiguredMachine(selected, offload?.machines);
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
