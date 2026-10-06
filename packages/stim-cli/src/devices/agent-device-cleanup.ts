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
  return readAgentDeviceRecords(homedir())
    .filter((record) => record.kind === 'claim' && (device.id === null || record.deviceId === device.id))
    .map((record) => ({
      deviceId: record.deviceId,
      session: record.session,
      workspace: record.workspace && canonical(record.workspace),
    }));
}

function report(message: string): void {
  process.stderr.write(`${phaseLine('device', message)}\n`);
}

export function closeOwnedDeviceSessions(
  device: Device,
  stillOwned: (id: string) => boolean,
  workspace?: string,
  repoRoot?: string,
): void {
  const exec = getExecutor();
  try {
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
    for (const dir of stateDirs) {
      const deadline = Date.now() + 15000;
      const run = (args: string[]) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('agent-device cleanup timed out');
        return exec.runFile(
          'agent-device',
          [...args, ...(dir ? ['--state-dir', dir] : []), '--json', '--daemon-transport', 'socket'],
          {
            timeoutMs: Math.min(5000, remaining),
            killSignal: 'SIGKILL',
          },
        );
      };
      const list = () => parseAgentDeviceSessions(run(['session', 'list', '--session', 'stim-teardown-inventory']));
      try {
        const sessions = list().filter((session) => isOwnDeviceSession(session, device, owner));
        for (const session of sessions) {
          try {
            if (
              !list().some(
                (current) =>
                  current.name === session.name &&
                  current.platform === session.platform &&
                  current.id === session.id &&
                  current.createdAt === session.createdAt,
              )
            )
              continue;
            if (!stillOwned(session.id)) continue;
            const result = JSON.parse(
              run([
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
            report(
              `could not close agent-device session ${session.name} on ${session.id}: ${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        report(
          `could not list agent-device sessions for ${device.platform === 'ios' ? device.id : (device.id ?? device.avdName)}: ${(error as Error).message}`,
        );
      }
    }
  } catch (error) {
    report(
      `could not list agent-device sessions for ${device.platform === 'ios' ? device.id : (device.id ?? device.avdName)}: ${(error as Error).message}`,
    );
  }
}
