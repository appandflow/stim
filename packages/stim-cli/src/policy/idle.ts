import { formatLongDuration } from '../command-output.ts';

const MINUTE_MS = 60_000;
export const IDLE_SETTING = 'idle.minutes';
/** Under high or critical pressure, the idle stage takes every workspace idle this long (ladder rung 1). */
export const PRESSURE_IDLE_MS: number = 2 * MINUTE_MS;

/**
 * How long after its last command an agent-device session still counts as activity under pressure: an agent that waits
 * on a test run or thinks between commands is not idle after the 2 minutes of a plain workspace.
 */
const AGENT_DEVICE_IDLE_MS: number = 10 * MINUTE_MS;

/**
 * The window within which an activity of `basis` keeps a workspace running under an `idleMs` threshold. Only under
 * disk pressure does an agent-device command hold longer than `idleMs`.
 */
export function activityWindowMs(basis: string, idleMs: number, pressured: boolean): number {
  return pressured && basis === 'agent-device command' ? Math.max(idleMs, AGENT_DEVICE_IDLE_MS) : idleMs;
}

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
  | 'Simulator or emulator window'
  | 'file edit'
  | 'git write'
  | 'git commit';

export interface IdleStopEvidence {
  activity: { basis: IdleStopBasis; at: number }[];
  keep: string[];
}

export type IdleStopDecision =
  | { stop: true; idleMs: number; last: IdleStopEvidence['activity'][number] }
  | { stop: false; reason: string; active?: true; last?: IdleStopEvidence['activity'][number] };

export function decideIdleStop(
  evidence: IdleStopEvidence,
  { idleMs, now, setting, pressured = false }: { idleMs: number; now: number; setting: string; pressured?: boolean },
): IdleStopDecision {
  if (!(idleMs > 0)) return { stop: false, reason: `${setting} is 0` };
  const last = evidence.activity
    .filter(({ at }) => Number.isFinite(at))
    .reduce<IdleStopEvidence['activity'][number] | null>(
      (best, entry) => (!best || entry.at > best.at ? entry : best),
      null,
    );
  const idle = last ? now - last.at : NaN;
  const holding = evidence.activity
    .filter(({ at, basis }) => Number.isFinite(at) && now - at < activityWindowMs(basis, idleMs, pressured))
    .reduce<IdleStopEvidence['activity'][number] | null>(
      (best, entry) => (!best || entry.at > best.at ? entry : best),
      null,
    );
  if (last && holding)
    return {
      stop: false,
      active: true,
      last: holding,
      reason: `its last ${holding.basis} was ${formatLongDuration(Math.max(0, now - holding.at))} ago, within ${setting}`,
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
  if (facts.protected) return { runs: false };
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
