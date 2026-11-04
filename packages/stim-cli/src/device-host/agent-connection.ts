import { ambientWrite, workspaceId } from '@stim-cli/core';
import { realpathSync } from 'node:fs';
import { phaseLine } from '../command-output.ts';
import { getExecutor } from '../exec.ts';

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function report(message: string): void {
  ambientWrite('stderr', `${phaseLine('device', message.replace(/\s+/g, ' '))}\n`);
}

/**
 * The agent-device session `stim agent-device` uses for a hosted device when the agent names none. agent-device keeps
 * one saved remote connection per name for the whole machine, so the name carries the workspace id.
 */
export function hostedAgentSessionName(root: string, platform: 'ios' | 'android', slot: string): string {
  return `stim-${slot}-${platform}-${workspaceId(root).slice(0, 8)}`;
}

/** Closes the saved agent-device connection `session` (agent-device's `default` when omitted) if it uses `remoteConfig`. */
export function closeAgentConnection(remoteConfig: string, session?: string): void {
  const exec = getExecutor();
  const deadline = Date.now() + 30_000;
  const sessionArgs = session === undefined ? [] : ['--session', session];
  const run = (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('agent-device cleanup timed out');
    const result = JSON.parse(
      exec.runFile('agent-device', [...args, '--json'], {
        timeoutMs: Math.min(10_000, remaining),
        killSignal: 'SIGKILL',
      }),
    );
    if (result?.success !== true) throw new Error('agent-device did not confirm the command');
    return result.data;
  };
  try {
    if (!exec.findExecutable('agent-device')) return;
    const status = run(['connection', 'status', ...sessionArgs]);
    if (status?.connected !== true || typeof status.session !== 'string' || typeof status.remoteConfig !== 'string')
      return;
    const config = canonical(remoteConfig);
    if (config === null || canonical(status.remoteConfig) !== config) return;
    const failures: string[] = [];
    for (const args of [
      ['close', '--remote-config', remoteConfig, '--session', status.session],
      ['disconnect', '--session', status.session],
    ]) {
      try {
        run(args);
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    report(
      failures.length
        ? `could not clean up agent-device connection for ${status.session}: ${failures.join('; ')}`
        : `closed agent-device connection for ${status.session}`,
    );
  } catch (error) {
    report(`could not clean up agent-device connection: ${(error as Error).message}`);
  }
}
