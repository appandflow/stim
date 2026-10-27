import { statSync } from 'node:fs';
import { workspaceStateFile } from '../workspace/paths.ts';
import {
  HOSTED_METRO_LINKS_KEY,
  hostedMetroRequests,
  hostedMetroLinks,
  hostedIosPlacements,
  hostedAndroidPlacements,
  HOSTED_METRO_REQUESTS_KEY,
  type HostedMetroRequest,
  type HostedMetroLinks,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { clearHostedMetro } from '../device-host/metro-request.ts';
import { parseMachine } from '../offload/tailnet.ts';
import { openAgentRelay } from './agent-relay.ts';
import { openMetroLinks, type MetroLinkPool } from './metro-links.ts';
import { watchWorkspaceState } from '../workspace/workspace-state-watch.ts';

export function reconcileHostedMetro(
  requests: Record<string, HostedMetroRequest>,
  active: Record<string, HostedMetroRequest>,
): { close: string[]; open: string[] } {
  const same = (session: string) => JSON.stringify(requests[session]) === JSON.stringify(active[session]);
  return {
    close: Object.keys(active).filter((session) => !same(session)),
    open: Object.keys(requests).filter((session) => !same(session)),
  };
}

export function watchHostedMetro(root: string, metroPort: number, processToken: string): () => Promise<void> {
  const active: Record<string, HostedMetroRequest> = {};
  const pools = new Map<string, MetroLinkPool>();
  let closed = false;
  let running: Promise<void> = Promise.resolve();
  let probingAt = 0;
  let probing = false;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let stamp = '';
  let cached: ReturnType<typeof readWorkspaceState> = null;
  let queued = false;
  updateWorkspaceState(root, (state) =>
    state.supervisor?.processToken === processToken
      ? { ...state, supervisor: { ...state.supervisor, hostedMetroLinks: true } }
      : state,
  );
  const readState = () => {
    const file = statSync(workspaceStateFile(root));
    const next = `${file.ino}:${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
    if (next !== stamp) {
      cached = readWorkspaceState(root);
      stamp = next;
    }
    return cached;
  };
  const unpublished = new Map<string, HostedMetroLinks | null>();
  let republish: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(republish);
    for (const [session, links] of unpublished) {
      try {
        updateWorkspaceState(root, (state) => {
          const published = { ...hostedMetroLinks(state) };
          if (state.supervisor?.processToken !== processToken) return state;
          if (links) published[session] = links;
          else delete published[session];
          return { ...state, [HOSTED_METRO_LINKS_KEY]: published };
        });
      } catch {
        if (closed) return;
        republish = setTimeout(flush, 1000);
        republish.unref();
        return;
      }
      unpublished.delete(session);
    }
  };
  const publish = (session: string, links: HostedMetroLinks | null) => {
    unpublished.delete(session);
    unpublished.set(session, links);
    flush();
  };
  const reconcile = async () => {
    if (closed) return;
    observer.refresh();
    const state = readState();
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
      updateWorkspaceState(root, (current) => {
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
    if (!probing && Date.now() >= probingAt) {
      clearTimeout(probeTimer);
      probingAt = Date.now() + 10_000;
      probing = true;
      void Promise.all(
        placements.map(async (placement) => {
          if ((await probeHostedSession(placement)).state === 'stopped' && !closed)
            clearHostedMetro(root, placement.session);
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
    for (const pool of pools.values()) pool.close();
  };
}
