import { readFile, stat } from 'node:fs/promises';
import { workspaceStateFile } from '../../workspace/paths.ts';
import {
  HOSTED_METRO_LINKS_KEY,
  hostedMetroRequests,
  hostedMetroLinks,
  hostedIosPlacements,
  hostedAndroidPlacements,
  HOSTED_METRO_REQUESTS_KEY,
  type HostedMetroRequest,
  type HostedMetroLinks,
  isJsonObject,
  reversePorts,
  parseMachine,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { updateWorkspaceState, updateWorkspaceStateAsync } from '../../workspace/workspace-state.ts';
import { probeHostedSession } from '../../device-host/hosted-client.ts';
import { openAgentRelay } from './agent-relay.ts';
import { openMetroLinks, type MetroLinkPool } from './metro-links.ts';
import { watchWorkspaceState } from '../../workspace/workspace-state-watch.ts';

const REVERSE_RETRY_MS = 60_000;

function reconcileHostedMetro(
  requests: Record<string, HostedMetroRequest>,
  active: Record<string, HostedMetroRequest>,
): { close: string[]; open: string[] } {
  const same = (session: string) => JSON.stringify(requests[session]) === JSON.stringify(active[session]);
  return {
    close: Object.keys(active).filter((session) => !same(session)),
    open: Object.keys(requests).filter((session) => !same(session)),
  };
}

/**
 * Serves the hosted Metro links, reverse ports and agent relays the workspace's hosted sessions ask for, from the
 * dev server `processToken` names. Past the one write that advertises the watcher, its state I/O is asynchronous so
 * that stimd's main thread never waits on it.
 * `warn` gets what fails, for the workspace's Metro log. Resolves the returned close once every link is closed.
 */
export function watchHostedMetro(
  root: string,
  metroPort: number,
  processToken: string,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): () => Promise<void> {
  const active: Record<string, HostedMetroRequest> = {};
  const pools = new Map<string, MetroLinkPool>();
  const reversePools = new Map<string, MetroLinkPool>();
  const stopped = new Set<string>();
  const reverseFailedAt = new Map<string, number>();
  let closed = false;
  let running: Promise<void> = Promise.resolve();
  let probingAt = 0;
  let probing = false;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let stamp = '';
  let cached: WorkspaceState | null = null;
  let queued = false;
  updateWorkspaceState(root, (state) =>
    state.supervisor?.processToken === processToken
      ? { ...state, supervisor: { ...state.supervisor, hostedMetroLinks: true } }
      : state,
  );
  const readState = async () => {
    const file = await stat(workspaceStateFile(root));
    const next = `${file.ino}:${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
    if (next !== stamp) {
      try {
        const parsed: unknown = JSON.parse(await readFile(workspaceStateFile(root), 'utf8'));
        cached = isJsonObject(parsed) ? parsed : null;
      } catch {
        cached = null;
      }
      stamp = next;
    }
    return cached;
  };
  const unpublished = new Map<string, HostedMetroLinks | null>();
  let republish: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(republish);
    for (const [session, links] of unpublished) {
      try {
        await updateWorkspaceStateAsync(root, (state) => {
          const published = { ...hostedMetroLinks(state) };
          if (state.supervisor?.processToken !== processToken) return state;
          if (links) published[session] = links;
          else delete published[session];
          return { ...state, [HOSTED_METRO_LINKS_KEY]: published };
        });
      } catch {
        if (closed) return;
        republish = setTimeout(() => void flush(), 1000);
        republish.unref();
        return;
      }
      unpublished.delete(session);
    }
  };
  const publish = (session: string, links: HostedMetroLinks | null) => {
    unpublished.delete(session);
    unpublished.set(session, links);
    void flush();
  };
  const reconcile = async () => {
    if (closed) return;
    observer.refresh();
    const state = await readState();
    if (state?.supervisor?.processToken !== processToken) return;
    const placements = [
      ...Object.values(hostedIosPlacements(state)),
      ...Object.values(hostedAndroidPlacements(state)).map((placement) =>
        Object.assign({ platform: 'android' as const }, placement),
      ),
    ];
    const sessions = new Set(placements.map((placement) => placement.session));
    const requests = Object.fromEntries(
      Object.entries(hostedMetroRequests(state)).filter(([session]) => sessions.has(session)),
    );
    if (Object.keys(requests).length !== Object.keys(hostedMetroRequests(state)).length) {
      await updateWorkspaceStateAsync(root, (current) => {
        if (current.supervisor?.processToken !== processToken) return current;
        const recorded = new Set(
          [...Object.values(hostedIosPlacements(current)), ...Object.values(hostedAndroidPlacements(current))].map(
            (placement) => placement.session,
          ),
        );
        return {
          ...current,
          [HOSTED_METRO_REQUESTS_KEY]: Object.fromEntries(
            Object.entries(hostedMetroRequests(current)).filter(([session]) => recorded.has(session)),
          ),
        };
      });
    }
    const actions = reconcileHostedMetro(requests, active);
    for (const session of actions.close) {
      pools.get(session)?.close();
      pools.delete(session);
      delete active[session];
      publish(session, null);
    }
    for (const session of actions.open) {
      const request = requests[session]!;
      active[session] = request;
      const relay =
        parseMachine(request.machine)?.transport === 'local'
          ? openAgentRelay({ machine: request.machine, session, port: hostedMetroLinks(state)[session]?.agentPort })
          : null;
      let agentPort: number | undefined;
      const listening = relay ? relay.port.then((port) => void (agentPort = port)).catch(() => {}) : Promise.resolve();
      let ready = false;
      const pool = openMetroLinks({
        machine: request.machine,
        session,
        metroPort,
        onReady: async () => {
          ready = true;
          await listening;
          if (active[session] === request && ready)
            publish(session, { id: request.id, processToken, ready: true, ...(agentPort ? { agentPort } : {}) });
        },
        onLost: () => {
          ready = false;
          if (active[session] === request)
            publish(session, { id: request.id, processToken, ...(agentPort ? { agentPort } : {}) });
        },
        onError: (message) => {
          ready = false;
          if (active[session] === request)
            publish(session, { id: request.id, processToken, error: message, ...(agentPort ? { agentPort } : {}) });
        },
      });
      pools.set(session, {
        close: () => {
          pool.close();
          relay?.close();
        },
      });
    }
    const wanted = new Map<string, { machine: string; session: string; port: number }>();
    for (const placement of placements)
      if (!stopped.has(placement.session))
        for (const port of reversePorts(state))
          wanted.set(`${placement.session}:${port}`, { machine: placement.machine, session: placement.session, port });
    for (const [key, pool] of reversePools) {
      if (wanted.has(key)) continue;
      pool.close();
      reversePools.delete(key);
    }
    for (const [key, { machine, session, port }] of wanted) {
      if (reversePools.has(key) || Date.now() - (reverseFailedAt.get(key) ?? 0) < REVERSE_RETRY_MS) continue;
      reversePools.set(
        key,
        openMetroLinks({
          machine,
          session,
          metroPort: port,
          reverse: true,
          onReady: () => {},
          onLost: () => {},
          onError: (message) => {
            warn(`reverse port ${port}: ${message}`);
            reversePools.get(key)?.close();
            reversePools.delete(key);
            reverseFailedAt.set(key, Date.now());
          },
        }),
      );
    }
    if (!probing && Date.now() >= probingAt) {
      clearTimeout(probeTimer);
      probingAt = Date.now() + 10_000;
      probing = true;
      void Promise.all(
        placements.map(async (placement) => {
          if ((await probeHostedSession(placement)).state === 'stopped' && !closed) {
            stopped.add(placement.session);
            await updateWorkspaceStateAsync(root, (current) => {
              const kept = { ...hostedMetroRequests(current) };
              delete kept[placement.session];
              return { ...current, [HOSTED_METRO_REQUESTS_KEY]: kept };
            });
          }
        }),
      )
        .catch(() => {})
        .finally(() => {
          probing = false;
          if (!closed) {
            probeTimer = setTimeout(tick, Math.max(0, probingAt - Date.now()));
            probeTimer.unref();
          }
        });
    }
  };
  const tick = () => {
    if (closed || queued) return;
    queued = true;
    running = running
      .then(() => {
        queued = false;
        return reconcile();
      })
      .catch(() => {});
  };
  const observer = watchWorkspaceState(root, tick);
  const timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
  return async () => {
    closed = true;
    observer.close();
    clearTimeout(probeTimer);
    clearTimeout(republish);
    clearInterval(timer);
    await running;
    for (const pool of [...pools.values(), ...reversePools.values()]) pool.close();
  };
}
