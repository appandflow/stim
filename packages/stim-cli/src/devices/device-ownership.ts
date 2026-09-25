import { readCreatedDevices, type CreatedDevices } from './created-devices.ts';

const OWNED_SIM_NAME = /^stim-[A-Za-z0-9._-]+ \(.* \d+(?:\.\d+)*\)(?: [A-Za-z0-9-]+)?$/;
const OWNED_AVD_NAME = /^stim-[A-Za-z0-9._-]+$/;
const GIB = 1024 ** 3;

export function isOwnedSimName(name: string): boolean {
  return OWNED_SIM_NAME.test(name);
}

function isOwnedAvdName(name: string): boolean {
  return OWNED_AVD_NAME.test(name);
}

function avdConfigWrittenByStim(configIni: string | null): boolean {
  for (const line of String(configIni ?? '').split(/\r?\n/)) {
    const match = /^disk\.dataPartition\.size=(\d+)$/.exec(line.trim());
    if (match) return Number(match[1]) > 0 && Number(match[1]) % GIB === 0;
  }
  return false;
}

export function isStimOwnedSim(
  sim: { udid: string; name?: string | null },
  created: CreatedDevices = readCreatedDevices(),
): boolean {
  const name = sim.name ?? '';
  return name.startsWith('stim-') && (created.ios.has(sim.udid) || isOwnedSimName(name));
}

export function isStimOwnedAvd(
  name: string,
  readConfig: () => string | null,
  created: CreatedDevices = readCreatedDevices(),
): boolean {
  return isOwnedAvdName(name) && (created.android.has(name) || avdConfigWrittenByStim(readConfig()));
}
