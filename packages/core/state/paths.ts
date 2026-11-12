import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, workspaceStateDir as workspaceDir } from '../index.ts';

export function getConfigPath(): string {
  return join(configDir(), 'config.json');
}

export function configLockPath(): string {
  return join(configDir(), 'config.lock');
}

export function workspaceMetadataFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'workspace.json');
}

export function workspaceAgentDeviceDir(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'agent-device');
}

export function workspaceLogsDir(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'logs');
}

/** Device screen footage stim-server records for the workspace, one directory per platform and slot. */
export function workspaceRecordingsDir(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'recordings');
}

export function workspaceLogErrorIndex(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'log-error-index.json');
}

export function workspaceDerivedData(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'derived-data');
}

export function workspaceGradleBuild(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'gradle-build');
}

export function workspaceBuildDetailFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'build-detail.json');
}

/** The agent sessions that stopped running in the workspace in the last `ENDED_AGENT_RETENTION_MS`. */
export function workspaceEndedAgentsFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'ended-agents.json');
}

export function workspaceEndedAgentsLock(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'ended-agents.lock');
}

/** The claim a native run, a stop, an automatic shutdown or a web share start holds on one workspace's devices. */
export function workspaceNativeRunClaim(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'native-run.lock');
}

export function supervisorPidFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'supervisor.pid');
}

export function workspaceStateFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.json');
}

/** The dependency directories `stim gc` deleted from the workspace's worktree, apart from state.json so writing it is not workspace activity. */
export function workspaceLightenedFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'lightened.json');
}

/** The links `stim share` started in the workspace that `stim share --reuse` can start again; holds secrets, mode 0600. */
export function workspaceShareLinksFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'share-links.json');
}

export function workspaceStateLock(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.lock');
}

export function emulatorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'emulator.log');
}

export function sharedCompilationCache(): string {
  return join(configDir(), 'compilation-cache');
}

export function sharedCcache(): string {
  return join(configDir(), 'ccache');
}

export function sharedGradle(): string {
  return join(configDir(), 'gradle');
}

export function sharedPods(): string {
  return join(configDir(), 'pods');
}

export function createdDevicesFile(home: string = configDir()): string {
  return join(home, 'created-devices.json');
}

export function gitMergeCacheDir(): string {
  return join(configDir(), 'git-merge');
}

export function pullRequestCacheDir(): string {
  return join(configDir(), 'pull-requests');
}

export function agentSessionsCacheFile(): string {
  return join(configDir(), 'agent-sessions.json');
}

/** The last device listing a boot admission took, which queued runs reuse while it is fresh instead of listing again. */
export function deviceListingCacheFile(): string {
  return join(configDir(), 'device-listing.json');
}

/** The checkouts `status` confirmed as repository roots. */
export function checkoutRootsCacheFile(): string {
  return join(configDir(), 'checkout-roots.json');
}

export function diskUsageCacheDir(): string {
  return join(configDir(), 'disk-usage');
}

/** The ownership claim root that admits one disk-usage walk at a time on this machine. */
export function diskUsageWalkClaims(): string {
  return join(configDir(), 'disk-usage-walk.claims');
}

/** The ownership claim root that admits one headroom ladder run at a time on this machine. */
export function ladderRunClaims(): string {
  return join(configDir(), 'ladder-run.claims');
}

/** The remote machines this machine asked for build access, each with its pinned stim-server key once approved. */
export function buildMachinesFile(): string {
  return join(configDir(), 'build-machines.json');
}

export function buildMachinesLock(): string {
  return join(configDir(), 'build-machines.lock');
}

/** The remote machines this machine asked for access, separate from build credentials. */
export function deviceHostMachinesFile(): string {
  return join(configDir(), 'device-host-machines.json');
}

export function deviceHostMachinesLock(): string {
  return join(configDir(), 'device-host-machines.lock');
}

export function deviceHostMachinesClaims(): string {
  return join(configDir(), 'device-host-machines.claims');
}

export function createdDevicesLock(): string {
  return join(configDir(), 'created-devices.lock');
}

/** The user's home directory: `HOME`, then `USERPROFILE` from `env`, else the OS account's. */
export function userHome(env?: NodeJS.ProcessEnv): string {
  return env?.HOME || env?.USERPROFILE || homedir();
}

/** The EAS session ledger lives under the real home directory, never under STIM_HOME. */
export function easMachineStateRoot(env?: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.stim', 'machine', 'eas');
}

export function easSessionLedgerFile(root: string = easMachineStateRoot()): string {
  return join(root, 'sessions.json');
}

export function easSessionLedgerLock(root: string = easMachineStateRoot()): string {
  return join(root, 'ledger.lock');
}

/** The machine-level list of Stim homes lives under the real home directory, never under STIM_HOME. */
export function stimHomesRoot(): string {
  return join(homedir(), '.stim', 'machine', 'homes');
}

export function stimHomesFile(root: string = stimHomesRoot()): string {
  return join(root, 'homes.json');
}

export function stimHomesLock(root: string = stimHomesRoot()): string {
  return join(root, 'homes.lock');
}

/** Where stim-server records, one file per server process, the devices whose frames a client subscribes to. */
export function deviceViewersDir(): string {
  return join(configDir(), 'viewers');
}

export function budgetSweepFile(): string {
  return join(configDir(), 'budget-sweep.json');
}

export function budgetSweepLock(): string {
  return join(configDir(), 'budget-sweep.lock');
}

export function statsFile(): string {
  return join(configDir(), 'stats.json');
}

export function maintenanceDir(): string {
  return join(configDir(), 'maintenance');
}

export function maintenanceStateFile(): string {
  return join(maintenanceDir(), 'state.json');
}

export function gcLogDir(): string {
  return join(configDir(), 'gc');
}

export function gcLogFile(): string {
  return join(gcLogDir(), 'gc.ndjson');
}

/** The full plain-text report of the last `stim gc` run in plain mode, which prints only a summary. */
export function gcReportFile(): string {
  return join(gcLogDir(), 'last-report.txt');
}

export function buildLedgerDir(): string {
  return join(configDir(), 'builds');
}

export function buildLedgerFile(): string {
  return join(buildLedgerDir(), 'builds.ndjson');
}

export function buildLedgerLock(): string {
  return join(buildLedgerDir(), 'builds.lock');
}

export function maintenanceChildLogFile(): string {
  return join(maintenanceDir(), 'child.log');
}

export function maintenanceRunClaims(): string {
  return join(maintenanceDir(), 'run.claims');
}

/** Dependency trees `worktree remove` moved out of a worktree before git removed it; gc deletes what is left. */
export function trashRoot(): string {
  return join(configDir(), 'trash');
}

export function archiveRoot(): string {
  return join(configDir(), 'archive');
}

export function archiveDir(id: string): string {
  return join(archiveRoot(), id);
}

export function archiveLock(): string {
  return join(archiveRoot(), '.lock');
}

/** Uncommitted changes of removed worktrees: `<repository>/<branch-or-dir>-<timestamp>/` holding `manifest.json`. */
export function worktreeArchiveRoot(): string {
  return join(archiveRoot(), 'worktrees');
}

/** This machine's own long-term X25519 key as a client of other machines' stim-servers. */
export function clientIdentityKeyFile(): string {
  return join(configDir(), 'client-identity.key');
}

/**
 * A Unix socket at `path`. sun_path permits 103 UTF-8 bytes on macOS and 107 on Linux. Longer paths use
 * /tmp/stim-sockets-<uid>/<SHA-256 of the normalized absolute socket path>.sock.
 */
function localSocket(path: string): string {
  const uid = process.getuid?.();
  const maximumPathBytes = process.platform === 'linux' ? 107 : 103;
  if (uid === undefined || Buffer.byteLength(path) <= maximumPathBytes) return path;
  return join('/tmp', `stim-sockets-${uid}`, `${createHash('sha256').update(path).digest('hex')}.sock`);
}

/** stimd's run directory: its single-instance claim, its record and, when the path fits, its CLI socket. */
export function stimdRunDir(home?: string): string {
  return join(home ?? configDir(), 'run');
}

/**
 * stimd's CLI socket: `run/stimd.sock`, or on Windows a named pipe named after the Stim home.
 */
export function stimdSocket(home?: string): string {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\stimd-${createHash('sha256')
      .update(home ?? configDir())
      .digest('hex')
      .slice(0, 16)}`;
  return localSocket(join(stimdRunDir(home), 'stimd.sock'));
}

/** `{format, pid, socket, build, version}` of the running stimd, written by stimd alone. */
export function stimdRecordFile(): string {
  return join(stimdRunDir(), 'stimd.json');
}

/** The 0600 key stimd writes at boot that admits Stim Desktop to the Desktop-only methods. */
export function desktopKeyFile(): string {
  return join(stimdRunDir(), 'desktop.key');
}

/** The exclusive claim that keeps one stimd per Stim home. */
export function stimdClaimRoot(home?: string): string {
  return join(stimdRunDir(home), 'stimd');
}

/** The home daemon's directory: its claim, log, snapshot and, when the path fits, its socket. */
export function daemonDir(): string {
  return join(configDir(), 'daemon');
}

/** The ownership claim the running home daemon holds for its lifetime. */
export function daemonClaimRoot(): string {
  return join(daemonDir(), 'claim');
}

/** The daemon's own log, rotated like workspace logs. */
export function daemonNdjsonFile(): string {
  return join(daemonDir(), 'daemon.ndjson');
}

/** What the daemon's last tick measured and decided, written atomically each tick. */
export function daemonSnapshotFile(): string {
  return join(daemonDir(), 'snapshot.json');
}

export function serverSetupDir(): string {
  return join(configDir(), 'server', 'setup');
}

export function setupJournalFile(hash: string): string | null {
  return hash.length === 64 && /^[a-f0-9]{64}$/.test(hash) ? join(serverSetupDir(), `${hash}.json`) : null;
}
