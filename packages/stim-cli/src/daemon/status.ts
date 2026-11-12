import {
  daemonClaimRoot,
  daemonNdjsonFile,
  daemonSnapshotFile,
  parseUnverifiedCleanups,
  readDaemonSnapshot,
  type DaemonStatus,
} from '@stim-cli/core/state';
import { formatBytes } from '../fs-util.ts';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { formatLongDuration } from '../command-output.ts';
import type { Finding } from '../diagnostics/doctor.ts';
import { resolveSupervisorTarget } from '../stimd/metro/ownership.ts';
import { loadConfig } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { listTestWaiting, listWaiting } from '../engine/wait-queue.ts';
import { legacyDaemonStop } from './legacy-daemon.ts';
import { daemonMode, parseDaemonMode } from './mode.ts';

/**
 * The daemon's mode, whether it runs, and its last tick. A running daemon reports the mode it runs in, from its last
 * tick or else its claim, since it keeps the mode the command that started it resolved.
 */
export function daemonStatus(env: NodeJS.ProcessEnv = process.env): DaemonStatus {
  const setting = daemonMode(env);
  let holder: ReturnType<typeof readClaimSet>['live'][number] | undefined;
  // compat C30 until 2.1.0
  let older: ReturnType<typeof readClaimSet>['live'][number] | undefined;
  // compat end
  let unresolved: { path: string; reason: string } | undefined;
  try {
    const survey = readClaimSet(daemonClaimRoot());
    // compat C30 until 2.1.0
    older = survey.live.find((entry) => entry.mode === 'exclusive');
    // compat end
    holder = older ? undefined : survey.live[0];
    unresolved = survey.unresolved[0];
  } catch (error) {
    unresolved = { path: daemonClaimRoot(), reason: error instanceof Error ? error.message : String(error) };
  }
  const read = readDaemonSnapshot();
  const snapshot = holder && read?.pid !== holder.owner.pid ? null : read;
  const waiting = listWaiting();
  const testWaiting = listTestWaiting();
  const runningMode = holder ? (parseDaemonMode(snapshot?.mode) ?? parseDaemonMode(holder.details.mode)) : null;
  const mode = runningMode ?? setting;
  const unverified = parseUnverifiedCleanups(holder?.details.unverified);
  return {
    mode,
    ...(mode === setting ? {} : { setting }),
    running: holder ? { pid: holder.owner.pid, since: holder.startedAt } : null,
    // compat C30 until 2.1.0
    ...(older ? { older: { pid: older.owner.pid, stop: legacyDaemonStop(older.owner.pid) } } : {}),
    // compat end
    lastTickAt: snapshot?.tickAt ?? null,
    intervalMs: snapshot?.intervalMs ?? null,
    ...(snapshot?.pressure ? { pressure: snapshot.pressure } : {}),
    ...(waiting.length ? { waiting } : {}),
    ...(testWaiting.length ? { testWaiting } : {}),
    ...(read?.recent?.length ? { recent: read.recent } : {}),
    ...(unverified.length ? { unverified } : {}),
    ...(unresolved
      ? {
          claim: {
            unresolved: `${unresolved.path}: ${unresolved.reason}`,
            removeCommand: claimRemoveCommand(unresolved.path),
          },
        }
      : {}),
  };
}

/** One line per child whose cleanup the running daemon could not verify, with how long it has waited for it. */
export function unverifiedLines(status: DaemonStatus, now: number = Date.now()): string[] {
  return (status.unverified ?? []).map(
    (entry) =>
      `Daemon waits ${formatLongDuration(Math.max(0, now - Date.parse(entry.since)))} for child ${entry.child}, whose cleanup was not verified: ${entry.message} ${entry.remedy}`,
  );
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function daemonLine(status: DaemonStatus, now: number = Date.now()): string {
  const claim = status.claim ? `; unresolved claim ${status.claim.unresolved}; ${status.claim.removeCommand}` : '';
  // compat C30 until 2.1.0
  if (status.older)
    return `Daemon: pid ${status.older.pid} from an older stim holds the daemon claim; it is not this stim's daemon, and the next command that starts stimd stops it (or run ${status.older.stop})${claim}`;
  // compat end
  if (status.mode === 'off' && !status.running) return `Daemon: off (daemon.mode); no automatic pass runs${claim}`;
  const tickAt = Date.parse(status.lastTickAt ?? '');
  const tick = Number.isFinite(tickAt)
    ? `last tick ${formatLongDuration(Math.max(0, now - tickAt))} ago`
    : 'no tick yet';
  const resolves = status.setting ? `; daemon.mode resolves to ${status.setting} here` : '';
  const label = `Daemon (${status.mode === 'report' ? 'report only' : status.mode}${resolves})`;
  const pressure = status.pressure
    ? `; pressure ${status.pressure.level}${status.pressure.reasons.length ? ` (${status.pressure.reasons.join('; ')})` : ''}`
    : '';
  return status.running
    ? `${label}: running since ${clock(status.running.since)} (pid ${status.running.pid}), ${tick}${pressure}${claim}`
    : `${label}: not running, ${tick}${pressure}; start, ios, android, web, macos and revive start it${claim}`;
}

/** The last action a daemon of this home took, or null before its first. */
export function lastActionLine(status: DaemonStatus, now: number = Date.now()): string | null {
  const recent = status.recent ?? [];
  const action = recent.at(-1);
  if (!action) return null;
  const at = Date.parse(action.at);
  const when = Number.isFinite(at) ? `${formatLongDuration(Math.max(0, now - at))} ago` : 'at an unknown time';
  const verb = action.outcome === 'would' ? 'would ' : action.outcome === 'failed' ? 'failed to ' : '';
  return `Last daemon action ${when}: ${verb}${action.kind.replaceAll('-', ' ')} ${action.target}${action.bytes ? ` (${formatBytes(action.bytes)})` : ''}${recent.length > 1 ? `; ${recent.length} recent in ${daemonSnapshotFile()}` : ''}`;
}

/** One line per run waiting for a build slot, a device boot or a test slot, in arrival order per resource. */
export function waitingLines(status: DaemonStatus, now: number = Date.now()): string[] {
  const age = (since: string) => formatLongDuration(Math.max(0, now - Date.parse(since)));
  return [
    ...(status.waiting ?? []).map(
      (waiter) =>
        `Waiting for ${waiter.resource === 'build' ? 'a build slot' : 'a device boot'}: #${waiter.position} ${waiter.label}${waiter.platform ? ` (${waiter.platform})` : ''}, ${age(waiter.since)}`,
    ),
    ...(status.testWaiting ?? []).map(
      (waiter) => `Waiting for a test slot: #${waiter.position} ${waiter.label}, ${age(waiter.since)}`,
    ),
  ];
}

/** The workspaces whose dev server runs, so a daemon should be deciding their idle stop. */
function servingWorkspaces(): string[] {
  return Object.entries(loadConfig()?.projects ?? {}).flatMap(([path, project]) =>
    resolveSupervisorTarget({
      state: readWorkspaceState(path)?.supervisor,
      record: project.supervisor,
      reservedPort: project.metroPort,
    }).status === 'ours'
      ? [path]
      : [],
  );
}

/** A stuck daemon claim, a daemon that stopped ticking, or no daemon while a dev server runs. */
export function daemonFindings(
  status: DaemonStatus,
  { now = Date.now(), serving = servingWorkspaces }: { now?: number; serving?: () => string[] } = {},
): Finding[] {
  const findings: Finding[] = [];
  // compat C30 until 2.1.0
  if (status.older)
    findings.push({
      level: 'cost',
      title: 'A stim-daemon from an older Stim holds the daemon claim',
      detail: `pid ${status.older.pid} runs until every workspace in the home has been idle for idle.dormantDays, and while it runs this Stim's stimd cannot start, so no daemon of this version decides idle here.`,
      fix: `Run stim start, ios or android: stimd stops it when it can verify it. Otherwise stop it with \`${status.older.stop}\`.`,
    });
  // compat end
  if (status.claim)
    findings.push({
      level: 'cost',
      title: 'The stim-daemon claim cannot be resolved',
      detail: `${status.claim.unresolved}. While it stands no daemon decides idle in this Stim home.`,
      fix: `If no stim-daemon process runs, remove it with \`${status.claim.removeCommand}\`.`,
    });
  for (const entry of status.unverified ?? [])
    findings.push({
      level: 'cost',
      title: 'The stim-daemon waits for a child whose cleanup was not verified',
      detail: `Since ${entry.since}: ${entry.message} Until child ${entry.child} has stopped, the daemon does not exit when idle or switch engines, and the claims that child holds stay taken.`,
      fix: entry.remedy,
    });
  if (status.mode === 'off') return findings;
  const tickAt = Date.parse(status.lastTickAt ?? '');
  const late = 3 * (status.intervalMs ?? 60_000);
  const since = status.running
    ? Math.max(Number.isFinite(tickAt) ? tickAt : 0, Date.parse(status.running.since) || 0)
    : NaN;
  if (status.running && now - since > late)
    findings.push({
      level: 'cost',
      title: 'The stim-daemon has stopped ticking',
      detail: `stim-daemon pid ${status.running.pid} holds its claim, but its last tick was ${Number.isFinite(tickAt) ? `${formatLongDuration(now - tickAt)} ago` : 'never written'}, so idle workspaces and dev servers are not stopped. Its log is ${daemonNdjsonFile()}.`,
      fix: `Stop it with \`kill ${status.running.pid}\`; the next stim start, ios or android starts a new one.`,
    });
  if (!status.running && !status.claim && !status.older) {
    const running = serving();
    if (running.length)
      findings.push({
        level: 'note',
        title: 'No stim-daemon runs while a dev server does',
        detail: `${running.join(', ')} ${running.length === 1 ? 'runs a dev server' : 'run dev servers'} that no stimd supervises, so nothing stops it when idle. ${daemonNdjsonFile()} says why the last daemon exited.`,
        fix: 'Run stim start in one of those workspaces; it starts the daemon.',
      });
  }
  return findings;
}
