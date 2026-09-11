import { WebSocket } from 'ws';

const METRO_TIMEOUT_MS = 2_000;

type Sent = { ok: true; failed?: undefined; reason?: undefined; noPeer?: undefined; unreachable?: undefined };
type Missed = { ok?: undefined; failed: true; reason: string; targets?: undefined; broadcast?: undefined };

/**
 * The four outcomes, spelled out so an impossible combination does not typecheck
 * and callers cannot branch on one that never happens.
 */
export type MetroReloadResult =
  /** Addressed to every peer matching the platform. */
  | (Sent & { targets: number; peers: number; broadcast?: undefined })
  /** Metro could not name its clients, so the reload went to all of them. */
  | (Sent & { broadcast: true; targets?: undefined; peers?: undefined })
  /**
   * Metro named its clients and none matched. A broadcast went out anyway, so
   * the app may still have reloaded; nothing here proves it did.
   */
  | (Missed & { noPeer: true; peers: number; unreachable?: undefined })
  /** Metro never answered, so nothing is known about the app. */
  | (Missed & { unreachable: true; noPeer?: undefined; peers?: undefined });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MetroReloadRole = 'ios' | 'android';

const ROLE_NAMES: Record<MetroReloadRole, string> = { ios: 'iOS', android: 'Android' };

// Metro reports each peer's connection query. @expo/cli stores it unparsed
// (`url.parse(req.url).query`, a string) while @react-native-community/cli-server-api
// parses it into an object, so both shapes reach us.
function peerQuery(metadata: unknown): URLSearchParams | null {
  if (typeof metadata === 'string') return new URLSearchParams(metadata);
  if (!metadata || typeof metadata !== 'object') return null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') query.set(key, value);
  }
  return query;
}

// Only iOS sends `role` (RCTPackagerConnection.mm), and it sends nothing else.
// Android sends `device`, `app` and `clientid` (JSPackagerClient.kt), so its
// package name is the only identifier available there.
function peerMatches(query: URLSearchParams, role: MetroReloadRole, appId: string): boolean {
  if (role === 'ios') return query.get('role')?.toLowerCase() === 'ios';
  return query.get('app') === appId;
}

export function reloadThroughMetro(
  port: number,
  { role, appId, timeoutMs = METRO_TIMEOUT_MS }: { role: MetroReloadRole; appId: string; timeoutMs?: number },
): Promise<MetroReloadResult> {
  const roleName = ROLE_NAMES[role];
  return new Promise((resolve) => {
    const requestId = `stim-reload-${process.pid}-${Date.now()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`);
    let settled = false;
    const finish = (result: MetroReloadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ failed: true, unreachable: true, reason: `Metro did not answer on port ${port}.` }),
      timeoutMs,
    );

    socket.once('open', () => {
      socket.send(JSON.stringify({ version: 2, method: 'getpeers', target: 'server', id: requestId }));
    });
    socket.on('message', (data) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (message.id !== requestId) return;
      if (message.result && typeof message.result === 'object') {
        const entries = Object.entries(message.result);
        const peers = entries.length;
        const rolePeers = entries.filter(([, metadata]) => {
          const query = peerQuery(metadata);
          return query ? peerMatches(query, role, appId) : false;
        });
        if (rolePeers.length === 0) {
          // Matching is best-effort -- a peer can carry no query at all, or a
          // shape these matchers do not read -- so an unmatched app may still be
          // connected. Take the free shot with a broadcast before giving up, but
          // report the miss: nothing here proves the app got it.
          socket.send(JSON.stringify({ version: 2, method: 'reload' }));
          const others =
            peers === 0
              ? ' Nothing at all is connected to it, so the broadcast Stim sent anyway reached nothing.'
              : ` Metro has ${peers} other connected client${peers === 1 ? '' : 's'}, and Stim broadcast a reload to them in case one is this app unmatched.`;
          finish({
            failed: true,
            noPeer: true,
            peers,
            reason: `No ${roleName} React Native app is connected to Metro on port ${port}.${others}`,
          });
          return;
        }
        // A Stim Metro serves one app, so several matching peers are that app on
        // several devices, not several apps. Reload each of them. iOS could not
        // pick one anyway: its peers carry only `role`.
        for (const [id] of rolePeers) socket.send(JSON.stringify({ version: 2, method: 'reload', target: id }));
        finish({ ok: true, peers, targets: rolePeers.length });
        return;
      }
      // @react-native-community/cli-server-api reads `otherWs.upgradeReq.url` to
      // answer getpeers, a property ws dropped in 3.0, so every published version
      // of the bare dev server throws there rather than listing its clients. Its
      // broadcast path never touches that property. Note what this costs: the
      // throw only happens when some other client exists, so it proves a client
      // is connected but not which, and the target app may not be among them.
      socket.send(JSON.stringify({ version: 2, method: 'reload' }));
      finish({ ok: true, broadcast: true });
    });
    socket.once('error', (error) =>
      finish({ failed: true, unreachable: true, reason: `Metro reload failed: ${describe(error)}` }),
    );
  });
}
