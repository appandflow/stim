import { execFile } from 'node:child_process';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { availableParallelism, cpus, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import { loadConfig } from '@stim-cli/core/state';
import type { MachineHistory, MachineUsage, MachineVolume, MemoryPressure, UsageSample } from './protocol.ts';

interface DiskLocation {
  label: string;
  path: string;
}

function stimDiskLocations(): DiskLocation[] {
  let workspaces: string[] = [];
  try {
    workspaces = Object.keys(loadConfig()?.projects ?? {});
  } catch {}
  return [
    ...workspaces.map((path) => ({ label: 'Workspaces', path })),
    { label: 'Stim home', path: configDir() },
    ...(process.platform === 'darwin'
      ? [{ label: 'Simulators', path: join(homedir(), 'Library', 'Developer', 'CoreSimulator') }]
      : []),
  ];
}

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

function mountOf(path: string): string {
  return /^\/Volumes\/[^/]+/.exec(path)?.[0] ?? '/';
}

function readVolumes(locations: DiskLocation[]): MachineVolume[] {
  const byDevice = new Map<number, MachineVolume>();
  for (const { label, path } of locations) {
    try {
      const existing = existingAncestor(path);
      const device = statSync(existing).dev;
      const known = byDevice.get(device);
      if (known) {
        if (!known.holds.includes(label)) known.holds.push(label);
        continue;
      }
      const fs = statfsSync(existing);
      byDevice.set(device, {
        mount: mountOf(existing),
        holds: [label],
        freeBytes: fs.bavail * fs.bsize,
        totalBytes: fs.blocks * fs.bsize,
      });
    } catch {}
  }
  return [...byDevice.values()];
}

function readMemoryPressure(): Promise<MemoryPressure | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }, (error, stdout) => {
      // XNU exposes dispatch flags here, not its internal pressure enum:
      // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
      const level = error ? '' : stdout.trim();
      resolve(level === '1' ? 'normal' : level === '2' ? 'warning' : level === '4' ? 'critical' : null);
    });
  });
}

/**
 * Activity Monitor's "Memory Used" from `vm_stat` output: app memory (anonymous minus purgeable pages),
 * wired, and compressed pages, times the page size its header names. Null when a count is missing.
 */
export function parseVmStatUsedBytes(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const count = (label: string) => {
    const value = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(output)?.[1];
    return value === undefined ? null : Number(value);
  };
  const anonymous = count('Anonymous pages');
  const purgeable = count('Pages purgeable');
  const wired = count('Pages wired down');
  const compressed = count('Pages occupied by compressor');
  if (!pageSize || anonymous === null || purgeable === null || wired === null || compressed === null) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * Number(pageSize);
}

function readMemoryUsed(): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/usr/bin/vm_stat', { timeout: 2000 }, (error, stdout) => {
      resolve(error ? null : parseVmStatUsedBytes(stdout));
    });
  });
}

export interface CpuTicks {
  idle: number;
  total: number;
}

function cpuTicks(list: ReturnType<typeof cpus>): CpuTicks {
  let idle = 0;
  let total = 0;
  for (const cpu of list) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

/** The busy fraction (0..1) between two `os.cpus()` tick totals. Null when the totals did not advance. */
export function cpuUsageFraction(previous: CpuTicks, current: CpuTicks): number | null {
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return null;
  const idleDelta = current.idle - previous.idle;
  return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
}

// Kept across calls so `machine.get` can report the delta since the previous request instead of blocking on a
// fresh sample window each time. The first call of a server process has no previous sample, so it reports null.
let previousCpuTicks: CpuTicks | null = null;

function readCpuUsage(): { usage: number | null; cores: number } {
  const current = cpuTicks(cpus());
  const usage = previousCpuTicks ? cpuUsageFraction(previousCpuTicks, current) : null;
  previousCpuTicks = current;
  return { usage, cores: availableParallelism() };
}

export async function readMachineUsage(): Promise<MachineUsage> {
  const [avg1 = 0, avg5 = 0, avg15 = 0] = loadavg();
  const [pressure, usedBytes] = await Promise.all([readMemoryPressure(), readMemoryUsed()]);
  return {
    volumes: readVolumes(stimDiskLocations()),
    memory: { totalBytes: totalmem(), usedBytes, pressure },
    load: { avg1, avg5, avg15, cpus: availableParallelism() },
    cpu: readCpuUsage(),
    sampledAt: new Date().toISOString(),
  };
}

const PRESSURE_LEVEL: Record<MemoryPressure, 0 | 1 | 2> = { normal: 0, warning: 1, critical: 2 };

const HISTORY_INTERVAL_MS = 5000;
const HISTORY_CAPACITY = 720;

export class UsageSampler {
  private readonly samples: UsageSample[] = [];
  private previousTicks: CpuTicks | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly capacity: number;

  constructor(intervalMs: number = HISTORY_INTERVAL_MS, capacity: number = HISTORY_CAPACITY) {
    this.intervalMs = intervalMs;
    this.capacity = capacity;
  }

  start(): void {
    if (this.timer) return;
    this.previousTicks = cpuTicks(cpus());
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.previousTicks = null;
  }

  record(sample: UsageSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }

  history(sinceMs?: number): MachineHistory {
    const samples = sinceMs === undefined ? [...this.samples] : this.samples.filter((s) => s.at > sinceMs);
    return { intervalMs: this.intervalMs, samples };
  }

  private async sample(): Promise<void> {
    const at = Date.now();
    const ticks = cpuTicks(cpus());
    const cpu = this.previousTicks ? cpuUsageFraction(this.previousTicks, ticks) : null;
    this.previousTicks = ticks;
    const [pressure, memoryUsedBytes] = await Promise.all([readMemoryPressure(), readMemoryUsed()]);
    let diskFreeBytes: number | null = null;
    try {
      const fs = statfsSync('/');
      diskFreeBytes = fs.bavail * fs.bsize;
    } catch {}
    if (!this.timer) return;
    this.record({
      at,
      cpu,
      memoryUsedBytes,
      memoryPressure: pressure === null ? null : PRESSURE_LEVEL[pressure],
      diskFreeBytes,
    });
  }
}
