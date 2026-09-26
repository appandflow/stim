import chalk from 'chalk';
import { readIdleStop } from '@stim-cli/core/state';
import type { ReclaimedStep } from '../budget.ts';
import { phaseLine } from '../command-output.ts';
import type { DevServerStart } from '../engine/build-facts.ts';
import { resolveProjectMetro } from '../metro.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { startDevServer, type StartDevServerRequest } from './start.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { LAUNCH_BUNDLING, LAUNCH_UNVERIFIED } from '../engine/launch-verify.ts';

export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

export type DevServerGate =
  | { ok: true; port: number; pid: number | null; devServer: DevServerStart | null; reclaimed: ReclaimedStep[] }
  | { ok: false; code: string; message: string; remedy: string | null; lines: string[]; reclaimed: ReclaimedStep[] };

export async function ensureDevServer({
  root,
  port,
  settings,
  remote,
  note,
  resolve = resolveProjectMetro,
  start = startDevServer,
  readState = readWorkspaceState,
}: {
  root: string;
  port: number | null;
  settings: StartDevServerRequest['settings'];
  remote: boolean;
  note: (line: string) => void;
  resolve?: (port: number, root: string) => Promise<{ metro?: { pid?: number } | null }>;
  start?: typeof startDevServer;
  readState?: typeof readWorkspaceState;
}): Promise<DevServerGate> {
  const held = port === null ? null : (await resolve(port, root)).metro;
  if (port !== null && held) return { ok: true, port, pid: held.pid ?? null, devServer: null, reclaimed: [] };
  const reason = readIdleStop(readState(root)) ? 'stopped (idle)' : 'not running';
  note(chalk.dim(phaseLine('metro', `dev server ${reason}; starting it${remote ? ' for a remote device' : ''}`)));
  const result = await start({ root, settings, remote, out: note, note });
  if (!result.ok) {
    return {
      ok: false,
      code: result.error.code,
      message: `Could not start this workspace's dev server: ${result.error.message}`,
      remedy: result.error.remedy,
      lines: result.lines,
      reclaimed: result.reclaimed,
    };
  }
  const { facts } = result;
  return {
    ok: true,
    port: facts.port,
    pid: facts.supervisorPid,
    devServer: facts.alreadyRunning ? null : { started: true, reason },
    reclaimed: result.reclaimed,
  };
}

export async function ensureWorkspaceStorageSafely(
  root: string,
  { note = (_line: string) => {} }: { note?: (line: string) => void } = {},
): Promise<unknown> {
  try {
    return ensureWorkspaceStorage(root);
  } catch (err) {
    note(chalk.dim(`Could not prepare this workspace's Stim state: ${(err as Error)?.message || err}`));
    throw err;
  }
}

export function launchOutcomeRecord({
  launchState,
  release,
  bundleId,
  configuration,
  metroPort,
  unattributed = false,
}: {
  launchState: boolean | string;
  release: boolean;
  bundleId: string | null;
  configuration: string | null;
  metroPort?: number | null;
  unattributed?: boolean;
}): Record<string, unknown> {
  const unverified = launchState === LAUNCH_UNVERIFIED;
  const bundling = launchState === LAUNCH_BUNDLING;
  let msg: string;
  if (release) {
    msg = unverified
      ? `${bundleId} could not be verified as running after its ${configuration} launch`
      : `${bundleId} is running its embedded ${configuration} bundle`;
  } else if (unverified && unattributed) {
    msg = `a bundle delivered on this workspace's Metro port ${metroPort} could not be attributed to ${bundleId} on this device: another slot of the same platform shares that Metro`;
  } else if (unverified) {
    msg = `no bundle request from ${bundleId} reached this workspace's Metro on port ${metroPort}`;
  } else if (bundling) {
    msg =
      `${bundleId} requested a bundle from this workspace's Metro on port ${metroPort}; ` +
      'it was still being built when the launch check ended';
  } else {
    msg = `${bundleId} fetched a bundle from this workspace's Metro on port ${metroPort}`;
  }
  return {
    src: 'build',
    level: unverified ? 'warn' : 'info',
    event: unverified ? 'launch_unverified' : bundling ? 'launch_bundling' : 'launch_verified',
    msg,
  };
}

export function isPhysicalDeviceRequest(flag: string | boolean | null | undefined): boolean {
  return flag !== null && flag !== undefined && flag !== false;
}
