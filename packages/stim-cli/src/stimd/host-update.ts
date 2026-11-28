import { loadServerCli } from '../server-cli.ts';
import { loadConfig } from '../workspace/config.ts';

const RETRY_MS = 60 * 60_000;

type Log = (level: 'info' | 'warn', event: string, msg: string) => void;

/**
 * Brings a Stim Host installed in `~/Applications` up to the release this build pins, once per stimd start and then
 * hourly until an attempt succeeds. Does nothing off macOS, on a Mac without Stim Host, or with `engine.autoUpdate`
 * set to `off`.
 */
// @ref LLP 0001#opt-in-apple-service-restarts -- stimd keeps an installed Stim Host at the pinned release
export async function keepHostCurrent(log: Log): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    if (loadConfig()?.engine?.autoUpdate === 'off') return;
    const updated = await (await loadServerCli()).updateInstalledHostApp();
    if (updated) log('info', 'host_updated', `installed the pinned ${updated.name} at ${updated.app}`);
  } catch (error) {
    log('warn', 'host_update_failed', `${error instanceof Error ? error.message : String(error)}; retrying in an hour`);
    setTimeout(() => void keepHostCurrent(log), RETRY_MS).unref();
  }
}
