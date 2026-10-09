import { loadConfig } from './config.ts';
import type { StimConfig } from './config-types.ts';
import { readBuildMachines } from './build-machines.ts';
import { readDeviceHostMachines } from './device-host-machines.ts';

export type AutomaticPoolRole = 'build' | 'device';

export function automaticMachineEnabled(
  role: AutomaticPoolRole,
  machine: string,
  config: StimConfig | null = loadConfig(),
): boolean {
  const key = `${role}PoolDisabled` as const;
  const disabled = config?.remote?.[key];
  if (disabled === undefined) return true;
  if (!Array.isArray(disabled) || disabled.some((entry) => typeof entry !== 'string' || !entry.trim()))
    throw Object.assign(new Error(`remote.${key} must be a list of machine names or local.`), { code: 'STIM_BAD_ARG' });
  return !disabled.includes(machine);
}

export function requireAutomaticMachine(role: AutomaticPoolRole, machine: string): void {
  if (automaticMachineEnabled(role, machine)) return;
  throw Object.assign(new Error(`${machine} is disabled in this requester's automatic ${role} pool.`), {
    code: role === 'build' ? 'STIM_OFFLOAD_REFUSED' : 'STIM_HOSTING_REFUSED',
    remedy: `Enable it in remote.${role}PoolDisabled or select a machine explicitly.`,
  });
}

export function validateAutomaticPool(role: AutomaticPoolRole, config: StimConfig): void {
  if (automaticMachineEnabled(role, 'local', config)) return;
  const configured = config.remote?.machines;
  const approved = role === 'build' ? readBuildMachines() : readDeviceHostMachines();
  if (
    Array.isArray(configured) &&
    configured.some(
      (machine) =>
        typeof machine === 'string' &&
        automaticMachineEnabled(role, machine, config) &&
        approved.some((entry) => entry.machine === machine && entry.state === 'approved'),
    )
  )
    return;
  throw Object.assign(
    new Error(
      `Keep at least one enabled automatic ${role} pool member: local or a configured, approved remote machine.`,
    ),
    {
      code: 'STIM_BAD_ARG',
    },
  );
}
