import type { LauncherScan, Launching } from '../../workspace/launchers.ts';

export const launchingWith = (checkout: string, scan: LauncherScan): Launching => ({
  launchers: async () => scan,
  anew: async () => scan,
  checkout,
});

export const noLaunchers = (checkout: string): Launching => launchingWith(checkout, { targets: [], incomplete: [] });
