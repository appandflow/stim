import { DEVICE_HOST_LIMITS } from '@stim-cli/core/state';
import type { IosRuntimeInstallResult } from '../devices/ios-runtime.ts';
import { call, connectHost } from './hosted-client.ts';

export async function installHostedIosRuntime(
  machine: string,
  runtime: string,
  note: (line: string) => void,
  signal?: AbortSignal,
): Promise<IosRuntimeInstallResult> {
  const host = await connectHost(machine, undefined, true, signal);
  note(
    `Installing missing iOS ${runtime.replace(/^iOS /, '')} on ${machine} with Xcode (typically 8-10 GB; shared by its workspaces).`,
  );
  const heartbeat = setInterval(
    () => note(`Waiting for Xcode runtime installation on ${machine}; downloads can take several minutes.`),
    30_000,
  );
  heartbeat.unref();
  const close = () => host.connection.close();
  signal?.addEventListener('abort', close, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await call(
      host,
      'device-host.runtime.install',
      { runtime },
      DEVICE_HOST_LIMITS.imageInstallMs + 15_000,
    );
    signal?.throwIfAborted();
    if (result.ok !== true) throw new Error(`${machine} did not confirm runtime installation.`);
    return { ok: true };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ok: false,
      code: 'STIM_HOSTING_REFUSED',
      message: error instanceof Error ? error.message : String(error),
      remedy: `Check Xcode and free disk space on ${machine}; update stim-server there if it does not support runtime installation.`,
    };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', close);
    close();
  }
}
