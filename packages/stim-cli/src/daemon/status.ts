import { daemonClaimRoot, daemonNdjsonFile, readDaemonSnapshot, type DaemonStatus } from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { formatLongDuration } from '../command-output.ts';
import type { Finding } from '../diagnostics/doctor.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { loadConfig } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { daemonMode } from './client.ts';

/** The daemon's mode, whether it runs, and its last tick. */
export function daemonStatus(env: NodeJS.ProcessEnv = process.env): DaemonStatus {
  const mode = daemonMode(env);
  let holder: ReturnType<typeof readClaimSet>['live'][number] | undefined;
  let unresolved: { path: string; reason: string } | undefined;
  try {
    const survey = readClaimSet(daemonClaimRoot());
    holder = survey.live[0];
    unresolved = survey.unresolved[0];
  } catch (error) {
    unresolved = { path: daemonClaimRoot(), reason: error instanceof Error ? error.message : String(error) };
  }
  const read = readDaemonSnapshot();
  const snapshot = holder && read?.pid !== holder.owner.pid ? null : read;
  return {
    mode,
    running: holder ? { pid: holder.owner.pid, since: holder.startedAt } : null,
    lastTickAt: snapshot?.tickAt ?? null,
    intervalMs: snapshot?.intervalMs ?? null,
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

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function daemonLine(status: DaemonStatus, now: number = Date.now()): string {
  const claim = status.claim ? `; unresolved claim ${status.claim.unresolved}; ${status.claim.removeCommand}` : '';
  if (status.mode === 'off' && !status.running)
    return `Daemon: off (daemon.mode); each dev server supervisor times its own idle stop${claim}`;
  const tickAt = Date.parse(status.lastTickAt ?? '');
  const tick = Number.isFinite(tickAt)
    ? `last tick ${formatLongDuration(Math.max(0, now - tickAt))} ago`
    : 'no tick yet';
  const label = `Daemon (${status.mode === 'report' ? 'report only' : status.mode})`;
  return status.running
    ? `${label}: running since ${clock(status.running.since)} (pid ${status.running.pid}), ${tick}${claim}`
    : `${label}: not running, ${tick}; start, ios, android, web, macos and revive start it${claim}`;
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
  if (status.claim)
    findings.push({
      level: 'cost',
      title: 'The stim-daemon claim cannot be resolved',
      detail: `${status.claim.unresolved}. While it stands no daemon decides idle in this Stim home, and dev server supervisors keep their own idle timers.`,
      fix: `If no stim-daemon process runs, remove it with \`${status.claim.removeCommand}\`.`,
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
      detail: `stim-daemon pid ${status.running.pid} holds its claim, but its last tick was ${Number.isFinite(tickAt) ? `${formatLongDuration(now - tickAt)} ago` : 'never written'}, so idle workspaces are not stopped and dev server supervisors stand down. Its log is ${daemonNdjsonFile()}.`,
      fix: `Stop it with \`kill ${status.running.pid}\`; the next stim start, ios or android starts a new one.`,
    });
  if (!status.running && !status.claim) {
    const running = serving();
    if (running.length)
      findings.push({
        level: 'note',
        title: 'No stim-daemon runs while a dev server does',
        detail: `${running.join(', ')} ${running.length === 1 ? 'runs a dev server' : 'run dev servers'}, so each supervisor times its own idle stop, without the idle stage's device and build output cleanup. ${daemonNdjsonFile()} says why the last daemon exited.`,
        fix: 'Run stim start in one of those workspaces; it starts the daemon.',
      });
  }
  return findings;
}
