import { ambientWrite } from '@stim-cli/core';
import { isJsonObject, parseNdjsonLine } from '@stim-cli/core/state';
import { realpathSync } from 'node:fs';
import { phaseLine, quotedPath } from '../command-output.ts';
import { getExecutor } from '../exec.ts';

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function report(message: string): void {
  ambientWrite('stderr', `${phaseLine('device', message)}\n`);
}

/** Closes each named agent-device connection that uses `remoteConfig`. */
export function closeAgentConnection(remoteConfig: string, ...sessions: string[]): void {
  const exec = getExecutor();
  if (!exec.findExecutable('agent-device')) return;
  const config = canonical(remoteConfig);
  if (config === null) return;
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
  for (const session of new Set(sessions)) {
    try {
      const status = run(['connection', 'status', '--session', session]);
      if (status?.connected !== true || status.session !== session || typeof status.remoteConfig !== 'string') continue;
      if (canonical(status.remoteConfig) !== config) continue;
    } catch {
      report(`could not check agent-device connection for ${quotedPath(session)}`);
      continue;
    }
    let failed = false;
    try {
      run(['close', '--remote-config', remoteConfig, '--session', session]);
    } catch (error) {
      const reply =
        isJsonObject(error) && typeof error.status === 'number' && error.status !== 0 && error.signal === null
          ? parseNdjsonLine(error.stdout)
          : null;
      failed = !(reply?.success === false && isJsonObject(reply.error) && reply.error.code === 'SESSION_NOT_FOUND');
    }
    try {
      run(['disconnect', '--session', session]);
    } catch {
      failed = true;
    }
    if (failed) {
      report(
        `could not clean up agent-device connection for ${quotedPath(session)}; run agent-device disconnect --session ${quotedPath(session)} using the same agent-device state directory`,
      );
    } else {
      report(`closed agent-device connection for ${session}`);
    }
  }
}
