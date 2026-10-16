import type { MemoryCulprit } from '@stim-cli/core/state';
import { getExecutor, type Executor } from './exec.ts';
import { memoryCulpritAdvice, readMemoryCulprits } from './memory-culprits.ts';

export type HostMemoryPressure = 'normal' | 'warning' | 'critical';

function pressureValue(value: string): HostMemoryPressure | null {
  // XNU exposes dispatch flags here, not its internal pressure enum:
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
  switch (value.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warning';
    case '4':
      return 'critical';
    default:
      return null;
  }
}

export function readHostMemoryPressure(
  exec: Executor = getExecutor(),
  platform: NodeJS.Platform = process.platform,
): HostMemoryPressure | null {
  if (platform !== 'darwin') return null;
  try {
    return pressureValue(
      exec.runFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 2000 }),
    );
  } catch {
    return null;
  }
}

export async function readHostMemoryPressureAsync(
  exec: Executor = getExecutor(),
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<HostMemoryPressure | null> {
  if (platform !== 'darwin') return null;
  const value = await exec.runFileQuietAsync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
    timeoutMs: 2000,
    signal,
  });
  return value === null ? null : pressureValue(value);
}

export function memoryCulpritsUnder(
  pressure: HostMemoryPressure | null,
  exec: Executor = getExecutor(),
): MemoryCulprit[] | null {
  return pressure === 'warning' || pressure === 'critical' ? readMemoryCulprits(exec) : null;
}

export function hostMemoryPressureAdvice(
  pressure: HostMemoryPressure | null,
  culprits: readonly MemoryCulprit[] | null = null,
): string | null {
  if (pressure === null || pressure === 'normal') return null;
  const named = memoryCulpritAdvice(culprits);
  return `macOS reports ${pressure} host memory pressure.${named ? ` ${named}` : ''} Simulator processes can stall even when the device is Booted. Free memory before retrying: use \`stim stop\` only in workspaces you own, and ask before closing other apps or devices. For parallel iOS work, consider a reviewed SimSlim profile (\`stim guide lifecycle simslim\`). This observation does not establish an OOM crash.`;
}
