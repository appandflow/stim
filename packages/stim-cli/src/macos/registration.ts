import type { ChildProcess } from 'node:child_process';
import { readMacosRecord, type MacosAppRecord } from '@stim-cli/core/state';
import { inspectProcessIdentity } from '../process-identity.ts';

export function waitForMacosRegistration(
  root: string,
  launchId: string,
  child: ChildProcess,
  deadline: number,
): Promise<MacosAppRecord | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let repairTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (record: MacosAppRecord | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(repairTimer);
      clearTimeout(deadlineTimer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      child.removeListener('message', onMessage);
      child.removeListener('disconnect', check);
      if (child.connected) child.disconnect();
      if (error) reject(error);
      else resolve(record);
    };
    const check = () => {
      if (settled) return;
      if (Date.now() >= deadline) return finish(null);
      const current = readMacosRecord(root);
      if (
        current?.launchId === launchId &&
        current.app &&
        current.supervisor &&
        inspectProcessIdentity(current.app) === 'same' &&
        inspectProcessIdentity(current.supervisor) === 'same'
      )
        finish(current);
      else if (child.exitCode !== null || child.signalCode !== null) finish(null);
    };
    const onExit = () => {
      check();
      finish(null);
    };
    const onError = (error: Error) => finish(null, error);
    const onMessage = (message: unknown) => {
      if (message === 'macos-registered') check();
    };
    const repair = () => {
      check();
      if (!settled) repairTimer = setTimeout(repair, 1000);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    child.on('message', onMessage);
    child.once('disconnect', check);
    deadlineTimer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    check();
    if (!settled) repairTimer = setTimeout(repair, 100);
  });
}
