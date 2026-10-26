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

export function supervisorPidFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'supervisor.pid');
}

export function workspaceStateFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.json');
}

/** The dependency directories `gc --delete` deleted from the workspace's worktree, apart from state.json so writing it is not workspace activity. */
export function workspaceLightenedFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'lightened.json');
}

export function workspaceStateLock(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.lock');
}

export function supervisorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'supervisor.log');
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

export function createdDevicesFile(): string {
  return join(configDir(), 'created-devices.json');
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

export function diskUsageCacheDir(): string {
  return join(configDir(), 'disk-usage');
}

/** The ownership claim root that admits one disk-usage walk at a time on this machine. */
export function diskUsageWalkClaims(): string {
  return join(configDir(), 'disk-usage-walk.claims');
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

/** The EAS session ledger lives under the real home directory, never under STIM_HOME. */
export function easMachineStateRoot(): string {
  return join(homedir(), '.stim', 'machine', 'eas');
}

export function easSessionLedgerFile(root: string = easMachineStateRoot()): string {
  return join(root, 'sessions.json');
}

export function easSessionLedgerLock(root: string = easMachineStateRoot()): string {
  return join(root, 'ledger.lock');
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

export function maintenanceAttemptFile(): string {
  return join(maintenanceDir(), 'attempt.json');
}

export function maintenanceNdjsonFile(): string {
  return join(maintenanceDir(), 'maintenance.ndjson');
}

export function gcLogDir(): string {
  return join(configDir(), 'gc');
}

export function gcLogFile(): string {
  return join(gcLogDir(), 'gc.ndjson');
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
 * The local Unix socket. sun_path permits 103 UTF-8 bytes on macOS and 107 on Linux. Longer paths use
 * /tmp/stim-sockets-<uid>/<SHA-256 of the normalized absolute socket path>.sock.
 */
export function serverLocalSocket(): string {
  const path = join(configDir(), 'server', 'local.sock');
  const uid = process.getuid?.();
  const maximumPathBytes = process.platform === 'linux' ? 107 : 103;
  if (uid === undefined || Buffer.byteLength(path) <= maximumPathBytes) return path;
  return join('/tmp', `stim-sockets-${uid}`, `${createHash('sha256').update(path).digest('hex')}.sock`);
}

export function serverSetupDir(): string {
  return join(configDir(), 'server', 'setup');
}

export function setupJournalFile(hash: string): string | null {
  return hash.length === 64 && /^[a-f0-9]{64}$/.test(hash) ? join(serverSetupDir(), `${hash}.json`) : null;
}
