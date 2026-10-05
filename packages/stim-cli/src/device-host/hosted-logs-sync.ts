import { readMacosRecord, type HostedMacosPlacement } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { pullHostedMacosLogs } from './hosted-logs.ts';
import { connectHost, type HostConnection } from './hosted-macos.ts';

function warning(machine: string, error: unknown): string {
  const message = (error as Error).message.replace(/\.$/, '');
  const hint = message.includes('refused device-host.logs.query')
    ? ` If ${machine} runs an older stim-server, update it.`
    : '';
  return phaseLine(
    'device',
    `Could not read the app's logs from ${machine}: ${message}. Showing the logs already copied here.${hint}`,
  );
}

export async function syncHostedMacosLogs(root: string, placement: HostedMacosPlacement): Promise<boolean> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(placement.machine);
    await pullHostedMacosLogs(root, placement, host);
    return true;
  } catch (error) {
    process.stderr.write(`${warning(placement.machine, error)}\n`);
    return false;
  } finally {
    host?.connection.close();
  }
}

export function followHostedMacosLogs(
  root: string,
  {
    failing = false,
    intervalMs = 500,
    retryMs = 5000,
  }: { failing?: boolean; intervalMs?: number; retryMs?: number } = {},
): () => void {
  let host: HostConnection | undefined;
  let retryAt = 0;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped || Date.now() < retryAt) return;
    running = true;
    try {
      const placement = readMacosRecord(root)?.host;
      if (!placement) {
        host?.connection.close();
        host = undefined;
        return;
      }
      host ??= await connectHost(placement.machine);
      await pullHostedMacosLogs(root, placement, host);
      failing = false;
    } catch (error) {
      host?.connection.close();
      host = undefined;
      if (!failing) process.stderr.write(`${warning(readMacosRecord(root)?.host?.machine ?? 'the host', error)}\n`);
      failing = true;
      retryAt = Date.now() + retryMs;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    host?.connection.close();
  };
}
