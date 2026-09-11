import { getExecutor, type Executor } from './exec.ts';

export type HostMemoryPressure = 'normal' | 'warning' | 'critical';

export function readHostMemoryPressure(
  exec: Executor = getExecutor(),
  platform: NodeJS.Platform = process.platform,
): HostMemoryPressure | null {
  if (platform !== 'darwin') return null;
  try {
    const value = exec.runFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 2000 });
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
  } catch {
    return null;
  }
}

export function hostMemoryPressureAdvice(pressure: HostMemoryPressure | null): string | null {
  if (pressure === null || pressure === 'normal') return null;
  return `macOS reports ${pressure} host memory pressure. Simulator processes can stall even when the device is Booted. Free memory before retrying: use \`stim stop\` only in workspaces you own, and ask before closing other apps or devices. For parallel iOS work, consider a reviewed SimSlim profile (\`stim guide lifecycle simslim\`). This observation does not establish an OOM crash.`;
}
