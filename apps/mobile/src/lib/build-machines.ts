import { t } from '@lingui/core/macro';

import { machineName } from '@/lib/format';
import type { BuildMachineReport } from '@/protocol/types';

export interface MachineReadiness {
  id: string;
  name: string;
  title: string;
  remedy: string | null;
  tone: 'success' | 'warning' | 'error' | 'tertiary';
}

type State = { title: string; tone: MachineReadiness['tone'] };

function pairingState(state: string): State {
  switch (state) {
    case 'approved':
      return { title: t`Approved`, tone: 'success' };
    case 'pending':
      return { title: t`Waiting for approval`, tone: 'warning' };
    case 'not-asked':
      return { title: t`Not asked`, tone: 'tertiary' };
    case 'revoked':
      return { title: t`Revoked`, tone: 'error' };
    case 'node-changed':
      return { title: t`Different Mac`, tone: 'error' };
    case 'not-on-tailnet':
      return { title: t`Not on the tailnet`, tone: 'warning' };
    case 'tailscale-off':
      return { title: t`Tailscale is off`, tone: 'warning' };
    case 'unreachable':
      return { title: t`Unreachable`, tone: 'warning' };
    case 'invalid':
      return { title: t`Not a tailnet name`, tone: 'error' };
    default:
      return { title: t`Unknown`, tone: 'tertiary' };
  }
}

/** The short title and remedy of each `stim doctor` build-machine reason code; `busy` is built from the load. */
function knownProblem(code: string): [string, string | null] | undefined {
  switch (code) {
    case 'unreachable':
      return [t`Not answering`, t`check its stim-server`];
    case 'checkout':
      return [t`Not a git checkout`, t`run Stim from a git checkout`];
    case 'stim-build':
      return [t`Stim build differs`, t`update the build machine`];
    case 'arch':
      return [t`Other CPU`, t`use a Mac with the same CPU`];
    case 'xcode':
      return [t`Xcode differs`, t`select the same Xcode on both`];
    case 'simulator-sdk':
      return [t`Simulator SDK differs`, t`select the same Xcode on both`];
    case 'cocoapods':
      return [t`CocoaPods differs`, t`install the same CocoaPods there`];
    case 'bundler':
      return [t`No Bundler`, t`install Bundler there`];
    case 'runtime':
      return [t`No simulator runtime`, t`install the iOS runtime there`];
    case 'jdk':
      return [t`JDK differs`, t`use the same JDK there`];
    case 'android-sdk':
      return [t`No Android SDK`, t`install one there`];
    case 'ndk':
      return [t`NDK missing`, t`install it with sdkmanager there`];
    case 'build-tools':
      return [t`Build-tools missing`, t`install it with sdkmanager there`];
    case 'compile-sdk':
      return [t`Android platform missing`, t`install it with sdkmanager there`];
    case 'disk':
      return [t`Low on disk`, t`free space there`];
    default:
      return undefined;
  }
}

/**
 * Whether a build machine takes builds now: "Ready", or the first reason `stim doctor` gave with its remedy, such
 * as "Stim build differs" and "update the build machine", or "Busy (load 8.2/core)". A machine that is not
 * approved shows its pairing state.
 */
export function machineReadiness(report: BuildMachineReport): MachineReadiness {
  const id = report.machine;
  const name = machineName(id);
  const state = pairingState(report.state);
  if (report.state !== 'approved' || report.offloadable === undefined) {
    return { id, name, ...state, remedy: null };
  }
  if (report.offloadable) return { id, name, title: t`Ready`, tone: 'success', remedy: null };
  const first = report.problems?.[0];
  if (first?.code === 'busy') {
    const load = report.capacity?.loadPerCore;
    return {
      id,
      name,
      title: typeof load === 'number' ? t`Busy (load ${load}/core)` : t`Busy`,
      tone: 'warning',
      remedy: null,
    };
  }
  const known = first ? knownProblem(first.code) : undefined;
  if (known) {
    return {
      id,
      name,
      title: known[0],
      remedy: known[1],
      tone: first!.code === 'unreachable' ? 'warning' : 'error',
    };
  }
  return { id, name, title: report.reasons?.[0] ?? t`Cannot take builds`, remedy: null, tone: 'error' };
}
