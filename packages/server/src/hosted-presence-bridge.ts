import { isJsonObject } from '@stim-cli/core/state';
import type { HostConnections } from './hosted-relay.ts';
import { parseHostedAgent, type PresenceHub } from './presence.ts';

type Lease = Awaited<ReturnType<HostConnections['acquire']>>;

interface Follow {
  listeners: number;
  stop: () => void;
}

/**
 * Carries what a host Mac publishes about a hosted session into this machine's `PresenceHub`, under the key the
 * session's workspace device has, so shares and viewers of it see an agent that drives it on the host. One host
 * subscription serves every consumer of a device and none exists while nobody follows it. A host that does not list
 * `hosted-presence`, or refuses the subscription, leaves the hub with what this machine publishes itself.
 */
export class HostedPresenceBridge {
  private readonly hosts: Pick<HostConnections, 'acquire'>;
  private readonly hub: Pick<PresenceHub, 'agent'>;
  private readonly follows = new Map<string, Follow>();

  constructor(hosts: Pick<HostConnections, 'acquire'>, hub: Pick<PresenceHub, 'agent'>) {
    this.hosts = hosts;
    this.hub = hub;
  }

  /** Follows the hosted `host.session` into the hub under `key` until the returned function is called. */
  follow(key: string, host: { machine: string; session: string }): () => void {
    const id = JSON.stringify([key, host.machine, host.session]);
    let follow = this.follows.get(id);
    if (!follow) {
      let stopped = false;
      let end = () => {
        stopped = true;
      };
      follow = { listeners: 0, stop: () => end() };
      this.follows.set(id, follow);
      const entry = follow;
      void (async () => {
        const close = await this.open(
          key,
          host,
          () => stopped,
          () => {
            if (this.follows.get(id) === entry) this.follows.delete(id);
          },
        );
        end = close;
        if (stopped) close();
      })();
    }
    follow.listeners++;
    const held = follow;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.listeners > 0) return;
      held.stop();
      if (this.follows.get(id) === held) this.follows.delete(id);
    };
  }

  private async open(
    key: string,
    host: { machine: string; session: string },
    stopped: () => boolean,
    lost: () => void,
  ): Promise<() => void> {
    let lease: Lease | undefined;
    try {
      lease = await this.hosts.acquire(host);
      const { connection } = lease;
      if (stopped()) {
        lease.release();
        return () => {};
      }
      const reply = await connection.request('device-host.presence.subscribe', { session: host.session });
      if ('error' in reply || !isJsonObject(reply.result) || typeof reply.result.subscription !== 'string') {
        lease.release();
        return () => {};
      }
      const subscription = reply.result.subscription;
      const held = lease;
      let closed = false;
      const close = (hostEnded: boolean) => {
        if (closed) return;
        closed = true;
        unroute();
        if (hostEnded) held.release();
        else
          void connection
            .request('device-host.unsubscribe', { subscription })
            .catch(() => {})
            .finally(held.release);
      };
      const unroute = connection.route(`s:${subscription}`, {
        event: (event) => {
          if (Buffer.isBuffer(event) || event.event !== 'presence') return;
          for (const { command, gesture } of parseHostedAgent(event.participants))
            this.hub.agent(key, command, 'end', gesture);
        },
        closed: () => {
          lost();
          close(true);
        },
      });
      return () => close(false);
    } catch {
      lease?.release();
      return () => {};
    }
  }
}
