import { randomUUID } from 'node:crypto';
import {
  isJsonObject,
  HOSTED_METRO_REQUESTS_KEY,
  hostedMetroRequests,
  hostedMetroLinks,
  type DeviceHostMachineCredential,
  type HostedMetroRequest,
  type SettingsObject,
} from '@stim-cli/core/state';
import { inspectProcessIdentity } from '../process-identity.ts';
import {
  readWorkspaceState,
  updateWorkspaceState,
  updateWorkspaceStateAsync,
  withWorkspaceStateLockAsync,
} from '../workspace/workspace-state.ts';
import { cancelledError, throwIfCancelled } from '../cancellation.ts';
import { watchWorkspaceState } from '../workspace/workspace-state-watch.ts';

async function waitForSupervisor<T>(
  root: string,
  read: () => T | null,
  { waitMs, signal, what }: { waitMs: number; signal?: AbortSignal; what: string },
): Promise<T | null> {
  throwIfCancelled(signal, what);
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let observer: ReturnType<typeof watchWorkspaceState> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: ReturnType<typeof setImmediate> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const check = () => {
        clearImmediate(queued);
        queued = undefined;
        clearTimeout(timer);
        try {
          throwIfCancelled(signal, what);
          observer?.refresh();
          const result = read();
          const remaining = deadline - Date.now();
          if (result !== null || remaining <= 0) resolve(result);
          else {
            // macOS fs.watch exposes no ready event: https://github.com/nodejs/node/issues/52601
            const repairMs = Date.now() - startedAt < 500 ? 100 : 1000;
            timer = setTimeout(check, Math.min(remaining, repairMs));
          }
        } catch (error) {
          reject(error);
        }
      };
      onAbort = () => reject(cancelledError(what));
      signal?.addEventListener('abort', onAbort, { once: true });
      observer = watchWorkspaceState(root, () => {
        queued ??= setImmediate(check);
      });
      check();
    });
  } finally {
    observer?.close();
    clearTimeout(timer);
    clearImmediate(queued);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export function requireHostedMetro(root: string): void {
  const supervisor = readWorkspaceState(root)?.supervisor;
  if (supervisor?.hostedMetroLinks === true && inspectProcessIdentity(supervisor) === 'same') return;
  throw Object.assign(
    new Error(
      'Hosted Debug runs require a running Metro supervisor that links Metro to the hosting machine. Run stim stop; stim start, then retry.',
    ),
    { code: 'STIM_HOSTING_REFUSED', remedy: 'Run stim stop; stim start, then retry.' },
  );
}

export async function requestHostedMetro(
  root: string,
  session: string,
  credential: DeviceHostMachineCredential,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal, 'hosted Metro link');
  requireHostedMetro(root);
  const recorded = readWorkspaceState(root);
  const previous = hostedMetroRequests(recorded)[session];
  const answer = hostedMetroLinks(recorded)[session];
  const request: HostedMetroRequest =
    previous?.machine === credential.machine &&
    answer?.id === previous.id &&
    answer.processToken === recorded?.supervisor?.processToken &&
    answer.ready
      ? previous
      : { id: randomUUID(), machine: credential.machine };
  await updateWorkspaceStateAsync(
    root,
    (state) => ({
      ...state,
      [HOSTED_METRO_REQUESTS_KEY]: { ...hostedMetroRequests(state), [session]: request },
    }),
    signal,
  );
  const linked = await waitForSupervisor(
    root,
    () => {
      const state = readWorkspaceState(root);
      const links = hostedMetroLinks(state)[session];
      if (links?.id === request.id && links.processToken === state?.supervisor?.processToken) {
        if (links.error) throw new Error(links.error);
        if (links.ready) return true;
      }
      return null;
    },
    { waitMs: 15_000, signal, what: 'hosted Metro link' },
  );
  if (linked) return;
  throw new Error(
    `The Metro supervisor did not link Metro to ${credential.machine}. Run stim doctor, then stim stop; stim start and retry.`,
  );
}

/** The loopback port on which this workspace's live supervisor relays `session`'s agent control, or null. */
export function hostedAgentPort(root: string, session: string): number | null {
  const state = readWorkspaceState(root);
  const links = hostedMetroLinks(state)[session];
  return links?.ready && links.agentPort && links.processToken === state?.supervisor?.processToken
    ? links.agentPort
    : null;
}

export function clearHostedMetro(root: string, session: string): void {
  updateWorkspaceState(root, (state) => {
    const requests = { ...hostedMetroRequests(state) };
    delete requests[session];
    return { ...state, [HOSTED_METRO_REQUESTS_KEY]: requests };
  });
}

export async function closeHostedMetro(root: string, session: string, signal?: AbortSignal): Promise<void> {
  await withWorkspaceStateLockAsync(root, () => clearHostedMetro(root, session), signal);
  const closed = await waitForSupervisor(
    root,
    () => {
      const state = readWorkspaceState(root);
      const links = hostedMetroLinks(state)[session];
      const supervisor = state?.supervisor;
      if (!links?.ready || !supervisor || links.processToken !== supervisor.processToken) return true;
      return inspectProcessIdentity(supervisor) === 'gone' ? true : null;
    },
    { waitMs: 5000, signal, what: 'close hosted Metro' },
  );
  if (!closed)
    throw new Error('The Metro supervisor did not close its Metro links. Restart Metro, then retry stim stop.');
}

export function hostedMetroSettings(settings: SettingsObject, hosted: boolean): SettingsObject {
  return hosted
    ? {
        ...settings,
        ios: { ...(isJsonObject(settings.ios) ? settings.ios : {}), remote: undefined },
        android: { ...(isJsonObject(settings.android) ? settings.android : {}), remote: undefined },
        metro: {
          ...(isJsonObject(settings.metro) ? settings.metro : {}),
          tunnel: undefined,
          publicUrl: undefined,
          ngrokUrl: undefined,
        },
      }
    : settings;
}
