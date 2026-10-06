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

/** The build machines this Mac paired with, each with its pinned tailnet node and device token. */
export function buildMachinesFile(): string {
  return join(configDir(), 'build-machines.json');
}

export function buildMachinesLock(): string {
  return join(configDir(), 'build-machines.lock');
}

/** The hosting machines this Mac asked for access, separate from build credentials. */
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

export function maintenanceChildLogFile(): string {
  return join(maintenanceDir(), 'child.log');
}

export function maintenanceRunClaims(): string {
  return join(maintenanceDir(), 'run.claims');
}
