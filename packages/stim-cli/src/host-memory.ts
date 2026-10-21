import type { MemoryCulprit } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { getExecutor, type Executor } from './exec.ts';
import { runOperationFileQuiet } from './engine/operation-exec.ts';
import { memoryCulpritAdvice, readMemoryCulprits, readMemoryCulpritsAsync } from './memory-culprits.ts';

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
  operation?: StimContext,
): Promise<HostMemoryPressure | null> {
  if (platform !== 'darwin') return null;
  const value = await runOperationFileQuiet(
    operation,
    exec,
    '/usr/sbin/sysctl',
    ['-n', 'kern.memorystatus_vm_pressure_level'],
    {
      timeoutMs: 2000,
      signal,
      cwd: operation?.cwd,
    },
  );
  return value === null ? null : pressureValue(value);
}

export function memoryCulpritsUnder(
  pressure: HostMemoryPressure | null,
  exec: Executor = getExecutor(),
): MemoryCulprit[] | null {
  return pressure === 'warning' || pressure === 'critical' ? readMemoryCulprits(exec) : null;
}

const CULPRIT_REUSE_MS = 30_000;
const recentCulprits = new WeakMap<Executor, { at: number; read: Promise<MemoryCulprit[] | null> }>();

/** Shares one `top` read among the calls of a run: concurrent and later calls within 30 seconds reuse it. */
export function memoryCulpritsUnderAsync(
  pressure: HostMemoryPressure | null,
  exec: Executor = getExecutor(),
): Promise<MemoryCulprit[] | null> {
  if (pressure !== 'warning' && pressure !== 'critical') return Promise.resolve(null);
  const recent = recentCulprits.get(exec);
  if (recent && Date.now() - recent.at < CULPRIT_REUSE_MS) return recent.read;
  const read = readMemoryCulpritsAsync(exec);
  recentCulprits.set(exec, { at: Date.now(), read });
  return read;
}

/** Starts the culprit read without waiting for it and calls `emit` with the advice if it names a process. */
export function reportMemoryCulprits(
  pressure: HostMemoryPressure | null,
  emit: (advice: string) => void,
  exec: Executor = getExecutor(),
): void {
  void (async () => {
    const named = memoryCulpritAdvice(await memoryCulpritsUnderAsync(pressure, exec));
    if (named) emit(named);
  })();
}

export function hostMemoryPressureAdvice(
  pressure: HostMemoryPressure | null,
  culprits: readonly MemoryCulprit[] | null = null,
): string | null {
  if (pressure === null || pressure === 'normal') return null;
  const named = memoryCulpritAdvice(culprits);
  return `macOS reports ${pressure} host memory pressure.${named ? ` ${named}` : ''} Simulator processes can stall even when the device is Booted. Free memory before retrying: use \`stim stop\` only in workspaces you own, and ask before closing other apps or devices. For parallel iOS work, consider a reviewed SimSlim profile (\`stim guide lifecycle simslim\`). This observation does not establish an OOM crash.`;
}
