import {
  claimRemoveCommand,
  clearFreeClaimSet,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { isJsonObject } from '@stim-cli/core/state';
import type { FunnelRoute } from '@stim-cli/transport-tailscale';
import { tailscalePackage } from './tailnet-helper.ts';

/** The Tailscale calls a share route makes; tests replace them. */
export interface FunnelTool {
  status: () => Promise<unknown>;
  serveConfig: () => Promise<Record<string, unknown>>;
  add: (route: FunnelRoute) => Promise<void>;
  remove: (route: FunnelRoute) => Promise<void>;
}

export function tailscaleFunnel(
  binary: () => Promise<string | null>,
  env: NodeJS.ProcessEnv,
  status: () => Promise<unknown>,
): FunnelTool {
  const need = async (): Promise<string> => {
    const found = await binary();
    if (!found) throw new Error('the tailscale command was not found');
    return found;
  };
  return {
    status,
    serveConfig: async () => (await tailscalePackage()).readServeConfig(await need(), env),
    add: async (route) => (await tailscalePackage()).addFunnelRoute(await need(), env, route),
    remove: async (route) => (await tailscalePackage()).removeFunnelRoute(await need(), env, route),
  };
}

function routeOf(details: unknown): FunnelRoute | null {
  if (!isJsonObject(details)) return null;
  const { funnelPort, target } = details;
  return typeof funnelPort === 'number' && typeof target === 'number' ? { port: funnelPort, target } : null;
}

/** Removes `route` only while the serve config still holds exactly it. */
async function removeIfHeld(tool: FunnelTool, route: FunnelRoute): Promise<void> {
  const { holdsFunnelRoute } = await tailscalePackage();
  if (!holdsFunnelRoute(await tool.serveConfig(), route)) return;
  await tool.remove(route);
  if (holdsFunnelRoute(await tool.serveConfig(), route)) {
    throw new Error(`Funnel port ${route.port} still serves the share after \`tailscale funnel off\`.`);
  }
}

/**
 * Removes the Funnel route a stim-server that is gone left behind, then clears its claim. A route that no longer
 * matches the claim is someone else's and stays. Throws, keeping the claim, when the route cannot be checked or
 * removed, and when a live process or an unreadable claim holds the set.
 */
export async function recoverShareRoute(root: string, tool: FunnelTool): Promise<void> {
  const survey = readClaimSet(root);
  const unresolved = survey.unresolved[0];
  if (unresolved) {
    throw new Error(
      `The share route claim ${unresolved.path} cannot be resolved: ${unresolved.reason}. Check \`tailscale funnel status\`, remove any route Stim left, then run ${claimRemoveCommand(unresolved.path)}.`,
    );
  }
  for (const holder of survey.dead) {
    const route = routeOf(holder.details);
    if (route) await removeIfHeld(tool, route);
  }
  if (survey.dead.length || survey.orphans.length) {
    const cleared = clearFreeClaimSet({ root, label: 'share route' });
    if (cleared.status === 'refused' || cleared.status === 'failed') {
      throw new Error(`The share route claim at ${root} could not be cleared: ${cleared.reason}.`);
    }
  }
  const live = readClaimSet(root).live[0];
  if (live && live.owner.pid !== process.pid) {
    throw new Error(`Another stim-server (process ${live.owner.pid}) serves web shares for this Stim home.`);
  }
}

export interface OpenedRoute {
  url: string;
  port: number;
  /** Set when a reverse proxy, not Funnel, fronts the listener: `url` is then the only origin the frame socket accepts. */
  proxied?: boolean;
  /** Something the person sharing should read about how the link will work. */
  warning?: string;
}

/**
 * The one public Funnel route of this server's share listener: a whole Funnel port that nothing else uses, proxied
 * to the listener's loopback port. It is taken under an exclusive ownership claim recording the port and target, so
 * a later stim-server removes it after a crash.
 */
export class ShareRoute {
  private claim: ClaimHandle | null = null;
  private route: FunnelRoute | null = null;
  private leftover: { claim: ClaimHandle; route: FunnelRoute } | null = null;
  private recovering: Promise<void> = Promise.resolve();
  private removing: Promise<void> | null = null;
  private readonly root: string;
  private readonly tool: FunnelTool;

  constructor(root: string, tool: FunnelTool) {
    this.root = root;
    this.tool = tool;
  }

  /** Removes a route a crashed stim-server left; runs one at a time, so startup and a first share do not race. */
  recover(): Promise<void> {
    this.recovering = this.recovering.catch(() => {}).then(() => recoverShareRoute(this.root, this.tool));
    return this.recovering;
  }

  async open(target: number): Promise<OpenedRoute> {
    if (this.claim) throw new Error('The share route is already open.');
    const status = await this.tool.status();
    const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : null;
    const dnsName = self && typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
    if (!dnsName) throw new Error('Tailscale is not running on this Mac. Start Tailscale, then share again.');
    const { freeFunnelPort, funnelPorts, holdsFunnelRoute } = await tailscalePackage();
    const allowed = funnelPorts(status);
    if (!allowed) {
      throw new Error(
        'Tailscale Funnel is not enabled for this node. A tailnet admin enables it in the tailnet policy file (https://tailscale.com/kb/1223/funnel); Stim never changes tailnet settings.',
      );
    }
    await this.removeStranded();
    await this.recover();
    const port = freeFunnelPort(await this.tool.serveConfig(), allowed);
    if (port === null) {
      throw new Error(
        `Every Funnel port this node may use (${allowed.join(', ')}) already serves something. Free one (see \`tailscale serve status\`), then share again.`,
      );
    }
    const route = { port, target };
    const attempt = tryAcquireClaim({
      root: this.root,
      mode: 'exclusive',
      details: { funnelPort: port, target, dnsName },
      label: 'share route',
    });
    if (!attempt.acquired) {
      if (attempt.pending) releaseClaim(attempt.pending);
      throw new Error('Another process holds the share route claim. Try again.');
    }
    const claim = attempt.acquired;
    try {
      await this.tool.add(route);
      if (!holdsFunnelRoute(await this.tool.serveConfig(), route)) {
        throw new Error(`Funnel port ${port} does not hold the share route after \`tailscale funnel\`.`);
      }
    } catch (cause) {
      try {
        await removeIfHeld(this.tool, route);
        releaseClaim(claim);
      } catch (removal) {
        console.error(`stim-server: could not remove the share route: ${String(removal)}`);
        this.leftover = { claim, route };
      }
      throw cause;
    }
    this.claim = claim;
    this.route = route;
    return { url: port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`, port };
  }

  /** Removes the route this server added and could not remove before, if any, and releases its claim. */
  removeStranded(): Promise<void> {
    this.removing ??= (async () => {
      const leftover = this.leftover;
      if (!leftover) return;
      await removeIfHeld(this.tool, leftover.route);
      releaseClaim(leftover.claim);
      if (this.leftover === leftover) this.leftover = null;
    })().finally(() => {
      this.removing = null;
    });
    return this.removing;
  }

  /** The loopback port a route this server added and could not remove yet still points at, or null. */
  stranded(): number | null {
    return this.leftover?.route.target ?? null;
  }

  /** Removes the route and releases the claim; on failure keeps the claim, so the next open or stim-server retries. */
  async close(): Promise<void> {
    const { claim, route } = this;
    if (!claim || !route) return;
    this.claim = null;
    this.route = null;
    try {
      await removeIfHeld(this.tool, route);
    } catch (cause) {
      this.leftover = { claim, route };
      throw cause;
    }
    releaseClaim(claim);
  }
}
