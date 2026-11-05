import { isJsonObject, SHARE_DEFAULT_PORT, settingDefinition, settingValueError } from '@stim-cli/core/state';
import type { OpenedRoute, ShareRoute } from './share-route.ts';

type FunnelRoute = Pick<ShareRoute, 'open' | 'close' | 'stranded' | 'removeStranded'>;

export interface ShareSettings {
  exposure: unknown;
  publicUrl: unknown;
  port: unknown;
}

export interface ResolvedExposure {
  mode: 'tailscale' | 'proxy';
  port: number;
  publicUrl: string | null;
}

const NO_PUBLIC_URL_WARNING =
  'Proxy mode has no share.publicUrl, so this link only works on this machine. Set the address your reverse proxy serves, then share again: stim settings set share.publicUrl https://demo.example.com';

function valid(key: string, raw: unknown): unknown {
  const setting = settingDefinition(key);
  if (!setting) throw new Error(`${key} is not a setting.`);
  if (raw === undefined) return undefined;
  const problem = settingValueError(setting, raw);
  if (problem) {
    throw new Error(
      `${key} is ${JSON.stringify(raw)}, which is not ${problem}. Fix it with stim settings set ${key} <value>.`,
    );
  }
  return raw;
}

/** Whether the tailscale status shows a node that is logged in and running, so a Funnel route can be tried. */
export function tailscaleLoggedIn(status: unknown): boolean {
  if (!isJsonObject(status) || status.BackendState !== 'Running') return false;
  const self = isJsonObject(status.Self) ? status.Self : null;
  return typeof self?.DNSName === 'string' && self.DNSName.replace(/\.$/, '') !== '';
}

/**
 * Picks how shares are exposed. `auto` is Funnel when the tailscale command is installed and logged in, otherwise
 * proxy; `tailscale` and `proxy` are never second-guessed. `loggedIn` is only read for `auto`, so `proxy` makes no
 * tailscale call at all.
 */
export async function resolveExposure(
  settings: ShareSettings,
  loggedIn: () => Promise<boolean>,
): Promise<ResolvedExposure> {
  const chosen = valid('share.exposure', settings.exposure);
  const choice = chosen === 'tailscale' || chosen === 'proxy' ? chosen : 'auto';
  const url = valid('share.publicUrl', settings.publicUrl);
  const configuredPort = valid('share.port', settings.port);
  const port = typeof configuredPort === 'number' ? configuredPort : SHARE_DEFAULT_PORT;
  const publicUrl = typeof url === 'string' ? url : null;
  if (publicUrl !== null && !URL.canParse(publicUrl)) {
    throw new Error(
      `share.publicUrl is ${JSON.stringify(publicUrl)}, which is not a valid address. Fix it with stim settings set share.publicUrl <value>.`,
    );
  }
  const mode = choice === 'auto' ? ((await loggedIn()) ? 'tailscale' : 'proxy') : choice;
  return { mode, port, publicUrl: publicUrl?.replace(/\/+$/, '') ?? null };
}

/** The link base proxy mode hands out: the public address, or the loopback listener with a warning. */
function proxyBase(exposure: ResolvedExposure, listenerPort: number): OpenedRoute {
  if (exposure.publicUrl) return { url: exposure.publicUrl, port: listenerPort, proxied: true };
  return {
    url: `http://127.0.0.1:${listenerPort}`,
    port: listenerPort,
    proxied: true,
    warning: NO_PUBLIC_URL_WARNING,
  };
}

/**
 * The route the share hub uses: Funnel through `tailscale` or a plain loopback listener for a reverse proxy,
 * whichever the settings choose when a listener is about to open. Proxy mode never reaches `tailscale`.
 */
export class ExposedRoute {
  private current: ResolvedExposure | null = null;
  private readonly tailscale: FunnelRoute;
  private readonly settings: () => ShareSettings;
  private readonly loggedIn: () => Promise<boolean>;

  constructor(tailscale: FunnelRoute, settings: () => ShareSettings, loggedIn: () => Promise<boolean>) {
    this.tailscale = tailscale;
    this.settings = settings;
    this.loggedIn = loggedIn;
  }

  /** Chooses the mode for the listener about to open and returns the loopback port to bind (0 for any free one). */
  async prepare(): Promise<number> {
    this.current = null;
    this.current = await resolveExposure(this.settings(), this.loggedIn);
    return this.current.mode === 'proxy' ? this.current.port : 0;
  }

  /** Whether the choice `prepare` made is a reverse proxy at a public address: the only exposure whose listener is kept. */
  standing(): boolean {
    return this.current?.mode === 'proxy' && this.current.publicUrl !== null;
  }

  async open(target: number): Promise<OpenedRoute> {
    const exposure = this.current;
    if (!exposure) throw new Error('The share route was not prepared.');
    return exposure.mode === 'proxy' ? proxyBase(exposure, target) : this.tailscale.open(target);
  }

  async close(): Promise<void> {
    const exposure = this.current;
    this.current = null;
    if (exposure?.mode === 'tailscale') await this.tailscale.close();
  }

  stranded(): number | null {
    return this.tailscale.stranded();
  }

  removeStranded(): Promise<void> {
    return this.tailscale.removeStranded();
  }
}
