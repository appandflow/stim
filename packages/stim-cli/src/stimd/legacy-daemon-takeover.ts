import { connect } from 'node:net';
import { daemonClaimRoot, daemonSocket, isJsonObject } from '@stim-cli/core/state';
import { readClaimSet, type ClaimOwner } from '@stim-cli/core/ownership-claim';
import { waitForProcessExit } from '../process-identity.ts';

// compat C22 until removal-minor
const EXIT_WAIT_MS = 10_000;

/** Sends `op` to a stim-daemon from Stim 1.40 to 1.42 and resolves with its first reply line, or null. */
function askDaemon(op: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect(daemonSocket());
    const finish = (reply: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
    socket.once('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      try {
        finish(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      } catch {
        finish(null);
      }
    });
  });
}

/** The live exclusive holder of the daemon claim, which only a stim-daemon from Stim 1.40 to 1.42 takes. */
function legacyHolder(): ClaimOwner | null {
  try {
    return readClaimSet(daemonClaimRoot()).live.find((holder) => holder.mode === 'exclusive')?.owner ?? null;
  } catch {
    return null;
  }
}

/**
 * Stops a stim-daemon from Stim 1.40 to 1.42 that holds this home's daemon claim exclusively and answers its socket
 * for itself: asks it for a tick, which wakes it from a wait, signals it once its claim still names it, and waits
 * briefly for it to exit. It releases its claim as soon as it is signalled. Returns the pid it stopped, or null.
 */
export async function takeOverLegacyDaemon(): Promise<number | null> {
  const holder = legacyHolder();
  const hello = holder ? await askDaemon('hello', 5000) : null;
  if (!holder || !isJsonObject(hello) || hello.pid !== holder.pid) return null;
  await askDaemon('tick', 200);
  if (legacyHolder()?.pid !== holder.pid) return null;
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch {
    return null;
  }
  await waitForProcessExit(holder, EXIT_WAIT_MS);
  return holder.pid;
}
// compat end
