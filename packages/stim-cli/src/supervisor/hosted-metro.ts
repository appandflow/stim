import { createMetroGateway, type MetroBridge } from '@stim-cli/core';
import {
  HOSTED_METRO_GATEWAYS_KEY,
  hostedMetroRequests,
  hostedMetroGateways,
  hostedIosPlacements,
  type HostedMetroRequest,
  type HostedMetroGateway,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { clearHostedMetro } from '../device-host/metro-gateway.ts';

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
  const bridges = new Map<string, MetroBridge>();
  let closed = false;
  let running: Promise<void> = Promise.resolve();
  let probingAt = 0;
  const publish = (session: string, gateway: HostedMetroGateway | null) =>
    updateWorkspaceState(root, (state) => {
      const gateways = { ...hostedMetroGateways(state) };
      if (state.supervisor?.processToken !== processToken) return state;
      if (gateway) gateways[session] = gateway;
      else delete gateways[session];
      return { ...state, [HOSTED_METRO_GATEWAYS_KEY]: gateways };
    });
  const reconcile = async () => {
    if (closed) return;
    const state = readWorkspaceState(root);
    if (state?.supervisor?.processToken !== processToken) return;
    const requests = hostedMetroRequests(state);
    const actions = reconcileHostedMetro(requests, active);
    for (const session of actions.close) {
      await bridges.get(session)?.close();
      bridges.delete(session);
      delete active[session];
      publish(session, null);
    }
    for (const session of actions.open) {
      const request = requests[session]!;
      active[session] = request;
      const bridge = createMetroGateway({ metroPort, peer: request.peer, secret: request.secret });
      bridges.set(session, bridge);
      try {
        const saved = hostedMetroGateways(state)[session];
        await new Promise<void>((resolve, reject) => {
          bridge.server.once('error', reject);
          bridge.server.listen(saved?.id === request.id ? (saved.port ?? 0) : 0, request.address, () => {
            bridge.server.removeListener('error', reject);
            resolve();
          });
        });
        const address = bridge.server.address();
        if (!address || typeof address === 'string') throw new Error('No gateway port.');
        publish(session, { id: request.id, processToken, port: address.port });
      } catch {
        await bridge.close();
        bridges.delete(session);
        publish(session, {
          id: request.id,
          processToken,
          error: `Could not bind the private Metro gateway for ${request.machine}. Check Tailscale, then restart Metro.`,
        });
      }
    }
    if (Date.now() >= probingAt) {
      probingAt = Date.now() + 10_000;
      await Promise.all(
        Object.values(hostedIosPlacements(state)).map(async (placement) => {
          if ((await probeHostedSession(placement)).state === 'stopped') clearHostedMetro(root, placement.session);
        }),
      );
    }
  };
  const tick = () => {
    running = running.then(reconcile).catch(() => {});
  };
  const timer = setInterval(tick, 500);
  timer.unref();
  tick();
  return async () => {
    closed = true;
    clearInterval(timer);
    await running;
    await Promise.all([...bridges.values()].map((bridge) => bridge.close()));
  };
}
