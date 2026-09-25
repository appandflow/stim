import { execFile } from 'node:child_process';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { availableParallelism, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import { loadConfig } from '@stim-cli/core/state';
import type { MachineUsage, MachineVolume, MemoryPressure } from './protocol.ts';

interface DiskLocation {
  label: string;
  path: string;
}

/** The locations Stim Desktop's storage view measures: workspaces, Stim home, and the simulators. */
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

export async function readMachineUsage(): Promise<MachineUsage> {
  const [avg1 = 0, avg5 = 0, avg15 = 0] = loadavg();
  return {
    volumes: readVolumes(stimDiskLocations()),
    memory: { totalBytes: totalmem(), pressure: await readMemoryPressure() },
    load: { avg1, avg5, avg15, cpus: availableParallelism() },
    sampledAt: new Date().toISOString(),
  };
}
