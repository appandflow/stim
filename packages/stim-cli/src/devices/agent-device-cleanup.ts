import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { ambientEnv, ambientWrite, type StimContext } from '@stim-cli/core';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { workspaceAgentDeviceDir } from '../workspace/paths.ts';
import { phaseLine } from '../command-output.ts';
import { getExecutor } from '../exec.ts';
import { agentDeviceDaemon, readAgentDeviceRecords } from './activity.ts';

type Device = { platform: 'ios'; id: string } | { platform: 'android'; id: string | null; avdName: string };
interface Session {
  name: string;
  platform: string;
  id: string;
  device: string | null;
  createdAt: number;
}
interface SessionClaim {
  deviceId: string | null;
  session: string | null;
  workspace: string | null;
}

export function parseAgentDeviceSessions(output: string): Session[] {
  const result = JSON.parse(output);
  if (result?.success !== true || !Array.isArray(result.data?.sessions)) {
    throw new Error('agent-device did not return a successful session list');
  }
  return result.data.sessions.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const id = row.platform === 'ios' ? row.device_udid : row.id;
    if (
      (row.platform !== 'ios' && row.platform !== 'android') ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      typeof id !== 'string' ||
      !id ||
      typeof row.createdAt !== 'number' ||
      !Number.isFinite(row.createdAt) ||
      (row.platform === 'ios' && row.id !== undefined && row.id !== id)
    )
      return [];
    // agent-device resolves a session name such as "default" against the caller's working directory; the
    // listed `address` (e.g. "cwd:<hash>:android") names the session from any directory, and device claims
    // record it.
    return [
      {
        name: typeof row.address === 'string' && row.address.trim() ? row.address : row.name,
        platform: row.platform,
        id,
        device: typeof row.device === 'string' ? row.device : null,
        createdAt: row.createdAt,
      },
    ];
  });
}

// agent-device names an emulator session's device from `ro.boot.qemu.avd_name`, with underscores shown as
// spaces; the serial alone is reused by the next emulator on that console port.
export function isOwnDeviceSession(
  session: Session,
  device: Device,
  owner?: { workspace: string; repoRoot?: string; claims: readonly SessionClaim[] },
): boolean {
  if (session.platform !== device.platform || (device.id !== null && session.id !== device.id)) return false;
  if (device.platform === 'android' && session.device !== device.avdName.replaceAll('_', ' ')) return false;
  if (!owner) return true;
  return owner.claims.some(
    (claim) =>
      claim.deviceId === session.id &&
      claim.session === session.name &&
      claim.workspace !== null &&
      (within(owner.workspace, claim.workspace) || claim.workspace === owner.repoRoot),
  );
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest.split(sep)[0] !== '..');
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function deviceClaims(device: Device): SessionClaim[] {
  return readAgentDeviceRecords(ambientEnv().HOME || ambientEnv().USERPROFILE || homedir(), ambientEnv())
    .filter((record) => record.kind === 'claim' && (device.id === null || record.deviceId === device.id))
    .map((record) => ({
      deviceId: record.deviceId,
      session: record.session,
      workspace: record.workspace && canonical(record.workspace),
    }));
}

class AgentDeviceRefusal extends Error {
  reason?: string;
  stateDir?: string;
}

// agent-device writes its failure as a JSON envelope on stdout and exits non-zero, so the thrown
// `Command failed` text carries none of its reason.
function explainFailure(error: unknown): Error {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  let failure: { message?: unknown; details?: { reason?: unknown; stateDir?: unknown } } | undefined;
  try {
    failure = typeof stdout === 'string' ? JSON.parse(stdout)?.error : undefined;
  } catch {
    failure = undefined;
  }
  if (typeof failure?.message !== 'string' || !failure.message) return error as Error;
  const reason = typeof failure.details?.reason === 'string' ? failure.details.reason : undefined;
  const stateDir = typeof failure.details?.stateDir === 'string' ? failure.details.stateDir : undefined;
  const refusal = new AgentDeviceRefusal(`agent-device refused: ${failure.message}${reason ? ` (${reason})` : ''}`);
  refusal.reason = reason;
  refusal.stateDir = stateDir;
  return refusal;
}

function report(message: string): void {
  ambientWrite('stderr', `${phaseLine('device', message)}\n`);
}

export async function closeOwnedDeviceSessions(
  device: Device,
  stillOwned: (id: string) => boolean | Promise<boolean>,
  workspace?: string,
  repoRoot?: string,
  operation?: StimContext,
  reportedBusy: Set<string> = new Set<string>(),
): Promise<void> {
  const exec = getExecutor();
  try {
    operation?.signal.throwIfAborted();
    if (!exec.findExecutable('agent-device')) return;
    const root = workspace === undefined ? undefined : canonical(workspace);
    if (root === null) return;
    const owner =
      root === undefined
        ? undefined
        : { workspace: root, repoRoot: repoRoot && (canonical(repoRoot) ?? undefined), claims: deviceClaims(device) };
    const stateDir = root === undefined ? undefined : workspaceAgentDeviceDir(root);
    const stateDirs = [
      undefined,
      ...(stateDir && !['none', 'dead'].includes(agentDeviceDaemon(stateDir)) ? [stateDir] : []),
    ];
    const busy = new Set<string>();
    for (const dir of stateDirs) {
      const deadline = Date.now() + 15000;
      const run = async (args: string[]) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('agent-device cleanup timed out');
        try {
          return await runOperationFile(
            operation,
            exec,
            'agent-device',
            [...args, ...(dir ? ['--state-dir', dir] : []), '--json', '--daemon-transport', 'socket'],
            {
              timeoutMs: Math.min(5000, remaining),
              killSignal: 'SIGKILL',
            },
          );
        } catch (error) {
          if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
            throw error;
          operation?.signal.throwIfAborted();
          throw explainFailure(error);
        }
      };
      const list = async () =>
        parseAgentDeviceSessions(await run(['session', 'list', '--session', 'stim-teardown-inventory']));
      try {
        const sessions = (await list()).filter((session) => isOwnDeviceSession(session, device, owner));
        for (const session of sessions) {
          try {
            if (
              !(await list()).some(
                (current) =>
                  current.name === session.name &&
                  current.platform === session.platform &&
                  current.id === session.id &&
                  current.createdAt === session.createdAt,
              )
            )
              continue;
            if (!(await stillOwned(session.id))) continue;
            const result = JSON.parse(
              await run([
                'close',
                '--session',
                session.name,
                '--session-lock',
                'reject',
                '--platform',
                device.platform,
                device.platform === 'ios' ? '--udid' : '--serial',
                session.id,
              ]),
            );
            if (result?.success !== true) throw new Error('agent-device did not confirm session close');
            report(`closed agent-device session ${session.name} on ${session.id}`);
          } catch (error) {
            if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
              throw error;
            operation?.signal.throwIfAborted();
            report(
              `could not close agent-device session ${session.name} on ${session.id}: ${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        operation?.signal.throwIfAborted();
        if (error instanceof AgentDeviceRefusal && error.reason === 'daemon-busy')
          busy.add(error.stateDir ?? dir ?? '');
        else
          report(
            `could not list agent-device sessions for ${device.platform === 'ios' ? device.id : (device.id ?? device.avdName)}: ${(error as Error).message}`,
          );
      }
    }
    const unreported = [...busy].filter((dir) => !reportedBusy.has(dir));
    if (unreported.length > 0) {
      for (const dir of unreported) reportedBusy.add(dir);
      const stop = unreported.map((dir) => `agent-device daemon stop${dir ? ` --state-dir ${dir}` : ''}`);
      report(
        `agent-device daemon is busy, so Stim did not check it for sessions on ${device.platform === 'ios' ? device.id : (device.id ?? device.avdName)}; any that name the device stay open until the daemon is idle or, if it is yours, stopped with ${stop.join(' and ')}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    report(
      `could not list agent-device sessions for ${device.platform === 'ios' ? device.id : (device.id ?? device.avdName)}: ${(error as Error).message}`,
    );
  }
}
