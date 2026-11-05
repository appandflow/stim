import { isJsonObject, reversePorts } from '@stim-cli/core/state';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { requireHostedMetro } from './metro-request.ts';
import { call, connectHost, type HostConnection } from './hosted-client.ts';

export interface HostedReverse {
  port: number;
  workerPort: number;
}

export async function syncHostedReverses(
  root: string,
  host: HostConnection,
  session: string,
): Promise<HostedReverse[]> {
  const ports = reversePorts(readWorkspaceState(root));
  if (!host.connection.supports('hosted-reverse-ports')) {
    if (ports.length === 0) return [];
    throw Object.assign(new Error(`${host.machine} runs a stim-server that cannot reverse ports.`), {
      code: 'STIM_HOSTING_REFUSED',
      remedy: `Update stim-server on ${host.machine}, then run stim ports reverse again.`,
    });
  }
  const result = await call(host, 'device-host.reverse.set', { session, ports });
  const answered: unknown[] = Array.isArray(result.ports) ? result.ports : [];
  const bound = answered.flatMap((each) =>
    isJsonObject(each) && typeof each.port === 'number' && typeof each.workerPort === 'number'
      ? [{ port: each.port, workerPort: each.workerPort }]
      : [],
  );
  if (!Array.isArray(result.ports) || bound.length !== answered.length)
    throw new Error(`${host.machine} answered device-host.reverse.set without its ports.`);
  return bound;
}

export async function syncHostedReversesTo(
  root: string,
  machine: string,
  session: string,
  signal?: AbortSignal,
): Promise<HostedReverse[]> {
  const host = await connectHost(machine, undefined, true, signal);
  try {
    return await syncHostedReverses(root, host, session);
  } finally {
    host.connection.close();
  }
}

export function requireReverseLinks(root: string): void {
  try {
    requireHostedMetro(root);
  } catch {
    throw Object.assign(
      new Error(
        "Reverse ports to a hosted device need this workspace's Metro supervisor, which opens the links to the host.",
      ),
      { code: 'STIM_HOSTING_REFUSED', remedy: 'Run stim start, then run stim ports reverse again.' },
    );
  }
}
