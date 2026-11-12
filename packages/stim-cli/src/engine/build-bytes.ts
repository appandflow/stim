import type { BuildLedgerPlatform } from '@stim-cli/core/state';

const measured = new Map<string, number>();
const measureKey = (root: string, platform: BuildLedgerPlatform) => `${platform}\0${root}`;

export function setBuildBytes(root: string, platform: BuildLedgerPlatform, bytes: number): void {
  measured.set(measureKey(root, platform), bytes);
}

/** The bytes this process measured for the build of `platform` at `root`, handed over once to the build ledger. */
export function takeBuildBytes(root: string, platform: BuildLedgerPlatform): number | undefined {
  const key = measureKey(root, platform);
  const bytes = measured.get(key);
  measured.delete(key);
  return bytes;
}
