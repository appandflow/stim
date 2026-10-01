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

export type PlacementDecision = 'here' | 'offloaded' | 'fell-back';

export interface Placement {
  at: string;
  platform: 'ios' | 'android';
  decision: PlacementDecision;
  reason: string;
  machine: string | null;
  buildMs: number | null;
  failed: boolean;
}

export interface OffloadCounts {
  offloaded: number;
  offloadedMs: number;
  savedMs: number;
  fallbacks: number;
}

/** The `offload` part of `stim stats --json`: where this Mac's compiling builds ran and why. */
export interface BuildPlacements {
  today: { here: number; offloaded: number; fellBack: number };
  machines: Record<string, { today: OffloadCounts; total: OffloadCounts }>;
  /** Newest first. */
  placements: Placement[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function counts(value: unknown): OffloadCounts {
  const entry = isObject(value) ? value : {};
  return {
    offloaded: num(entry.offloaded),
    offloadedMs: num(entry.offloadedMs),
    savedMs: num(entry.savedMs),
    fallbacks: num(entry.fallbacks),
  };
}

function placement(value: unknown): Placement[] {
  if (!isObject(value)) return [];
  const { at, platform, decision, reason, machine, buildMs } = value;
  if (typeof at !== 'string' || typeof reason !== 'string') return [];
  if (platform !== 'ios' && platform !== 'android') return [];
  if (decision !== 'here' && decision !== 'offloaded' && decision !== 'fell-back') return [];
  return [
    {
      at,
      platform,
      decision,
      reason,
      machine: typeof machine === 'string' ? machine : null,
      buildMs: typeof buildMs === 'number' ? buildMs : null,
      failed: value.failed === true,
    },
  ];
}

/** Reads `offload` from a `stim stats --json` payload; null from a stim that predates it. */
export function buildPlacements(stats: Record<string, unknown> | null | undefined): BuildPlacements | null {
  const offload = stats && isObject(stats.offload) ? stats.offload : null;
  if (!offload) return null;
  const today = isObject(offload.today) ? offload.today : {};
  const machines: BuildPlacements['machines'] = {};
  if (isObject(offload.machines)) {
    for (const [name, entry] of Object.entries(offload.machines)) {
      if (isObject(entry)) machines[name] = { today: counts(entry.today), total: counts(entry.total) };
    }
  }
  return {
    today: { here: num(today.here), offloaded: num(today.offloaded), fellBack: num(today.fellBack) },
    machines,
    placements: Array.isArray(offload.placements) ? offload.placements.flatMap(placement) : [],
  };
}

/** "Built here", "Built on mini", "Built here after mini". */
export function placementTitle(entry: Placement): string {
  const name = entry.machine ? machineName(entry.machine) : null;
  if (entry.decision === 'here') return t`Built here`;
  if (entry.decision === 'offloaded') return name ? t`Built on ${name}` : t`Built on a build machine`;
  return name ? t`Built here after ${name}` : t`Built here after offloading`;
}
