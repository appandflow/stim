import { phaseLine } from './command-output.ts';
import { getExecutor } from './exec.ts';

type Device = { platform: 'ios' | 'android'; id: string };
interface Session {
  name: string;
  platform: string;
  id: string;
  createdAt: number;
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
    return [{ name: row.name, platform: row.platform, id, createdAt: row.createdAt }];
  });
}

function report(message: string): void {
  process.stderr.write(`${phaseLine('device', message)}\n`);
}

export function closeOwnedDeviceSessions(device: Device, stillOwned: () => boolean): void {
  const exec = getExecutor();
  const deadline = Date.now() + 15000;
  const run = (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('agent-device cleanup timed out');
    return exec.runFile('agent-device', [...args, '--json', '--daemon-transport', 'socket'], {
      timeoutMs: Math.min(5000, remaining),
      killSignal: 'SIGKILL',
    });
  };
  const list = () => parseAgentDeviceSessions(run(['session', 'list', '--session', 'stim-teardown-inventory']));
  try {
    if (!exec.runQuiet('command -v agent-device', { timeoutMs: 2000, killSignal: 'SIGKILL' })) return;
    const sessions = list().filter((session) => session.platform === device.platform && session.id === device.id);
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
        if (!stillOwned()) return;
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
            device.id,
          ]),
        );
        if (result?.success !== true) throw new Error('agent-device did not confirm session close');
        report(`closed agent-device session ${session.name} on ${device.id}`);
      } catch (error) {
        report(`could not close agent-device session ${session.name} on ${device.id}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    report(`could not list agent-device sessions for ${device.id}: ${(error as Error).message}`);
  }
}
