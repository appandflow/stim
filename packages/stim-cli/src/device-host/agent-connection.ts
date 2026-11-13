import { ambientWrite } from '@stim-cli/core';
import { isJsonObject, parseNdjsonLine } from '@stim-cli/core/state';
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

/** Closes the saved agent-device connection `session` if it uses `remoteConfig`. */
export function closeAgentConnection(remoteConfig: string, session: string): void {
  const exec = getExecutor();
  const deadline = Date.now() + 30_000;
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
    const status = run(['connection', 'status', '--session', session]);
    if (status?.connected !== true || status.session !== session || typeof status.remoteConfig !== 'string') return;
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
        const reply =
          args[0] === 'close' &&
          isJsonObject(error) &&
          typeof error.status === 'number' &&
          error.status !== 0 &&
          error.signal === null
            ? parseNdjsonLine(error.stdout)
            : null;
        if (reply?.success === false && isJsonObject(reply.error) && reply.error.code === 'SESSION_NOT_FOUND') continue;
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
