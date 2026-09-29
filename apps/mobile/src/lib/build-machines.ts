import { machineName } from '@/lib/format';
import type { BuildMachineReport } from '@/protocol/types';

export interface MachineReadiness {
  name: string;
  title: string;
  remedy: string | null;
  tone: 'success' | 'warning' | 'error' | 'tertiary';
}

const STATES: Record<string, { title: string; tone: MachineReadiness['tone'] }> = {
  approved: { title: 'Approved', tone: 'success' },
  pending: { title: 'Waiting for approval', tone: 'warning' },
  'not-asked': { title: 'Not asked', tone: 'tertiary' },
  revoked: { title: 'Revoked', tone: 'error' },
  'node-changed': { title: 'Different Mac', tone: 'error' },
  'not-on-tailnet': { title: 'Not on the tailnet', tone: 'warning' },
  'tailscale-off': { title: 'Tailscale is off', tone: 'warning' },
  unreachable: { title: 'Unreachable', tone: 'warning' },
  invalid: { title: 'Not a tailnet name', tone: 'error' },
};

const SDK_REMEDY = 'install it with sdkmanager there';

/** The short title and remedy of each `stim doctor` build-machine reason code; `busy` is built from the load. */
const PROBLEMS: Record<string, [string, string | null]> = {
  unreachable: ['Not answering', 'check its stim-server'],
  checkout: ['Not a git checkout', 'run Stim from a git checkout'],
  'stim-build': ['Stim build differs', 'update the build machine'],
  arch: ['Other CPU', 'use a Mac with the same CPU'],
  xcode: ['Xcode differs', 'select the same Xcode on both'],
  'simulator-sdk': ['Simulator SDK differs', 'select the same Xcode on both'],
  cocoapods: ['CocoaPods differs', 'install the same CocoaPods there'],
  runtime: ['No simulator runtime', 'install the iOS runtime there'],
  jdk: ['JDK differs', 'use the same JDK there'],
  'android-sdk': ['No Android SDK', 'install one there'],
  ndk: ['NDK missing', SDK_REMEDY],
  'build-tools': ['Build-tools missing', SDK_REMEDY],
  'compile-sdk': ['Android platform missing', SDK_REMEDY],
  disk: ['Low on disk', 'free space there'],
};

/**
 * Whether a build machine takes builds now: "Ready", or the first reason `stim doctor` gave with its remedy, such
 * as "Stim build differs" and "update the build machine", or "Busy (load 8.2/core)". A machine that is not
 * approved shows its pairing state.
 */
export function machineReadiness(report: BuildMachineReport): MachineReadiness {
  const name = machineName(report.machine);
  const state = STATES[report.state] ?? { title: 'Unknown', tone: 'tertiary' as const };
  if (report.state !== 'approved' || report.offloadable === undefined) {
    return { name, ...state, remedy: null };
  }
  if (report.offloadable) return { name, title: 'Ready', tone: 'success', remedy: null };
  const first = report.problems?.[0];
  if (first?.code === 'busy') {
    const load = report.capacity?.loadPerCore;
    return {
      name,
      title: typeof load === 'number' ? `Busy (load ${load}/core)` : 'Busy',
      tone: 'warning',
      remedy: null,
    };
  }
  const known = first ? PROBLEMS[first.code] : undefined;
  if (known) {
    return {
      name,
      title: known[0],
      remedy: known[1],
      tone: first!.code === 'unreachable' ? 'warning' : 'error',
    };
  }
  return { name, title: report.reasons?.[0] ?? 'Cannot take builds', remedy: null, tone: 'error' };
}
