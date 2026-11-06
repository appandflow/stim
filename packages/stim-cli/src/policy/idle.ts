import { formatLongDuration } from '../command-output.ts';

const MINUTE_MS = 60_000;
export const IDLE_SETTING = 'idle.minutes';
/** Under high or critical pressure, the idle stage takes every workspace idle this long (ladder rung 1). */
export const PRESSURE_IDLE_MS: number = 2 * MINUTE_MS;

/**
 * The activity signals: a Stim command or the native run it started, a Metro bundle, manifest or HMR request, an
 * agent-device action, an input stim-server forwarded, and a person using the focused Simulator or emulator window.
 * Device logs, in-app logs, dev server output and log modification times are not activity.
 */
type IdleStopBasis =
  | 'stim command'
  | 'native run'
  | 'Metro request'
  | 'agent-device command'
  | 'stim-server input'
  | 'Simulator or emulator window';

export interface IdleStopEvidence {
  activity: { basis: IdleStopBasis; at: number }[];
  keep: string[];
}

export type IdleStopDecision =
  | { stop: true; idleMs: number; last: IdleStopEvidence['activity'][number] }
  | { stop: false; reason: string; active?: true; last?: IdleStopEvidence['activity'][number] };

export function decideIdleStop(
  evidence: IdleStopEvidence,
  { idleMs, now, setting }: { idleMs: number; now: number; setting: string },
): IdleStopDecision {
  if (!(idleMs > 0)) return { stop: false, reason: `${setting} is 0` };
  const last = evidence.activity
    .filter(({ at }) => Number.isFinite(at))
    .reduce<IdleStopEvidence['activity'][number] | null>(
      (best, entry) => (!best || entry.at > best.at ? entry : best),
      null,
    );
  const idle = last ? now - last.at : NaN;
  if (last && idle < idleMs)
    return {
      stop: false,
      active: true,
      last,
      reason: `its last ${last.basis} was ${formatLongDuration(Math.max(0, idle))} ago, within ${setting}`,
    };
  if (evidence.keep.length) return { stop: false, reason: evidence.keep.join('; '), ...(last ? { last } : {}) };
  if (!last) return { stop: false, reason: 'its last activity is unknown' };
  return { stop: true, idleMs: idle, last };
}

/** What the activity pass reads of a workspace before its settings. */
export interface IdleScopeFacts {
  /** The workspace the running command belongs to. */
  protected: boolean;
  /** Its dev server runs: under Stim's supervisor, one Stim cannot verify, or one that outlived its supervisor. */
  serving: boolean;
  /** The pass leaves out every workspace whose dev server runs. */
  unsupervised: boolean;
  /** Why its simulators cannot be listed, when it owns one; null otherwise. */
  simsError: string | null;
  /** Its booted devices this Stim home owns, each with whether a deferred shutdown holds it. */
  booted: readonly { deferred: boolean }[];
  /** The names of its devices outside this Stim home's created-devices ledger. */
  foreign: readonly string[];
}

/**
 * Whether the activity pass leaves the workspace out (`runs: false`) or keeps it before reading its settings; null when
 * its settings and dev server decide. The protected workspace and one with nothing running are left out.
 */
export function idleScope(facts: IdleScopeFacts): { runs: false } | { runs: true; kept: string } | null {
  if (facts.protected || (facts.unsupervised && facts.serving)) return { runs: false };
  if (facts.simsError !== null) return { runs: true, kept: `its simulators cannot be listed (${facts.simsError})` };
  if (facts.serving) return null;
  if (facts.booted.length > 0) return facts.booted.every(({ deferred }) => deferred) ? { runs: false } : null;
  if (!facts.foreign.length) return { runs: false };
  return {
    runs: true,
    kept: `${facts.foreign.join(', ')} not in this Stim home's created-devices ledger, so the idle stage leaves it`,
  };
}

/** What the activity pass reads of a running workspace once its scope lets it in. */
export interface IdleKeepFacts {
  settings: { keep: boolean; minutes: number } | { error: string };
  supervisor: { status: string; reason?: string };
  /** Its supervisor runs `metro.command`. */
  command: boolean;
  /** Its dev server reports its requests to Stim. */
  hmrUpdates: boolean;
  /** Why a dev server may still run after its supervisor exited; null otherwise. */
  orphan: string | null;
  hosted: { placements: readonly { label: string; machine: string }[]; unreadable: readonly string[] };
  /** The pressure level is high or critical. */
  pressured: boolean;
}

/**
 * What keeps a running workspace out of the idle stage whatever its activity, the first in this order, else its idle
 * threshold: `idle.minutes`, shortened to `PRESSURE_IDLE_MS` under pressure, and that threshold in whole minutes.
 */
export function idleKeep(facts: IdleKeepFacts): { kept: string } | { idleMs: number; minutes: number } {
  const { settings, supervisor, hosted } = facts;
  if ('error' in settings) return { kept: `its settings cannot be resolved: ${settings.error}` };
  if (settings.keep) return { kept: 'pinned by maintenance.keep' };
  if (settings.minutes === 0) return { kept: `${IDLE_SETTING} is 0` };
  if (supervisor.status === 'unverified')
    return { kept: `its dev server supervisor cannot be verified: ${supervisor.reason ?? 'unknown identity'}` };
  if (facts.orphan) return { kept: facts.orphan };
  if (supervisor.status === 'ours' && facts.command)
    return { kept: 'its dev server runs metro.command, whose bundle and HMR requests Stim cannot see' };
  if (supervisor.status === 'ours' && !facts.hmrUpdates)
    return {
      kept: 'its dev server does not report its requests to Stim: an Expo SDK before 54, or a server an older Stim started, which stim stop and stim start restart',
    };
  if (hosted.unreadable.length) return { kept: hosted.unreadable.join('; ') };
  const [placement] = hosted.placements;
  if (placement) return { kept: `its ${placement.label} runs on ${placement.machine}` };
  const idleMs = facts.pressured
    ? Math.min(settings.minutes * MINUTE_MS, PRESSURE_IDLE_MS)
    : settings.minutes * MINUTE_MS;
  return { idleMs, minutes: Math.ceil(idleMs / MINUTE_MS) };
}
