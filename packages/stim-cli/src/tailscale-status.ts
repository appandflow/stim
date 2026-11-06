import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from './exec.ts';

const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export function parseJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

function runningTailscaleStatus(status: unknown): unknown {
  return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
}

export function rawTailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output !== null) return parseJson(output);
  }
  return null;
}

export function tailscaleStatus(): unknown {
  return runningTailscaleStatus(rawTailscaleStatus());
}

async function tailscaleOutputAsync(signal?: AbortSignal): Promise<string | null> {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    signal?.throwIfAborted();
    let output: string;
    try {
      output = await getExecutor().runFileAsync(binary, ['status', '--json'], { timeoutMs: 5000, signal });
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
    return output;
  }
  return null;
}

export async function tailscaleStatusAsync(signal?: AbortSignal): Promise<unknown> {
  return runningTailscaleStatus(await rawTailscaleStatusAsync(signal));
}

export async function pingPeer(address: string, signal?: AbortSignal): Promise<boolean> {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    signal?.throwIfAborted();
    try {
      await getExecutor().runFileAsync(
        binary,
        ['ping', '--c', '1', '--until-direct=false', '--timeout', '4s', address],
        { timeoutMs: 6000, signal },
      );
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (!/ENOENT|not found/i.test(String(error))) return false;
    }
  }
  return false;
}

export async function rawTailscaleStatusAsync(signal?: AbortSignal): Promise<unknown> {
  const output = await tailscaleOutputAsync(signal);
  return output === null ? null : parseJson(output);
}
