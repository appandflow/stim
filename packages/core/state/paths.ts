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

export function workspaceLogErrorIndex(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'log-error-index.json');
}

export function workspaceDerivedData(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'derived-data');
}

export function workspaceGradleBuild(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'gradle-build');
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
