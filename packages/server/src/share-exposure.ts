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
  /** Whether `auto` chose the mode, so a later check may choose the other one, for example once Tailscale is up. */
  auto: boolean;
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
  return isJsonObject(status) && status.BackendState === 'Running' && tailscaleHost(status) !== null;
}

/** The DNS name of this node in a tailscale status, which is the host of its Funnel links; null without one. */
export function tailscaleHost(status: unknown): string | null {
  const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : null;
  const name = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  return name === '' ? null : name;
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
  return { mode, port, publicUrl: publicUrl?.replace(/\/+$/, '') ?? null, auto: choice === 'auto' };
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

/** Why a saved share cannot come back; `retry` when the exposure may change by itself, as Tailscale coming up does. */
export interface Unadmitted {
  why: string;
  retry: boolean;
}

/** Why a share saved under `savedOrigin` may not come back under `exposure`; null when it may. */
function unadmitted(
  exposure: ResolvedExposure,
  savedOrigin: string | undefined,
  host: string | null,
): Unadmitted | null {
  if (savedOrigin === undefined) return { why: 'it was saved without the address it was shared under', retry: false };
  if (exposure.mode === 'proxy') {
    const now = `${exposure.publicUrl ?? `http://127.0.0.1:${exposure.port}`}/s/`;
    return savedOrigin === now
      ? null
      : { why: `it was shared under ${savedOrigin}, and proxy exposure serves ${now} now`, retry: exposure.auto };
  }
  const saved = URL.parse(savedOrigin);
  if (host !== null && saved?.protocol === 'https:' && saved.hostname === host) return null;
  return {
    why: `it was shared under ${savedOrigin}, not through this node's Funnel address, which tailscale exposure serves now`,
    retry: host === null,
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
  private readonly host: () => Promise<string | null>;
  private funnelPort: number | undefined;

  constructor(
    tailscale: FunnelRoute,
    settings: () => ShareSettings,
    loggedIn: () => Promise<boolean>,
    host: () => Promise<string | null> = async () => null,
  ) {
    this.tailscale = tailscale;
    this.settings = settings;
    this.loggedIn = loggedIn;
    this.host = host;
  }

  /**
   * Why a share saved under `savedOrigin` (the link up to `/s/`) cannot come back under the exposure that would serve
   * it now, or null when it can: the same kind and the same address. A proxy link needs the address the proxy
   * settings give now; a Funnel link needs this node's Funnel host (its port is held when the route opens). A link saved
   * without an address cannot be told apart, so it is refused. Opens nothing and never runs `tailscale funnel` or
   * `tailscale serve`; `listenerOpen` says the exposure is the one the open listener already has.
   */
  async admits(savedOrigin: string | undefined, listenerOpen: boolean): Promise<Unadmitted | null> {
    const exposure =
      listenerOpen && this.current ? this.current : await resolveExposure(this.settings(), this.loggedIn);
    return unadmitted(exposure, savedOrigin, await this.host());
  }

  /**
   * Chooses the mode for the listener about to open and returns the loopback port to bind (0 for any free one). With
   * `savedOrigin`, the share being restored, the choice made here is the one checked against it, so no second answer
   * can differ from the one admitted: a different kind or address throws before anything opens, and a Funnel route
   * is opened only on the saved port.
   */
  async prepare(savedOrigin?: string): Promise<number> {
    this.current = null;
    this.funnelPort = undefined;
    const exposure = await resolveExposure(this.settings(), this.loggedIn);
    if (savedOrigin !== undefined) {
      const refused = unadmitted(exposure, savedOrigin, await this.host());
      if (refused) throw new Error(`The saved share cannot come back: ${refused.why}.`);
      if (exposure.mode === 'tailscale') this.funnelPort = Number(URL.parse(savedOrigin)?.port || 443);
    }
    this.current = exposure;
    return exposure.mode === 'proxy' ? exposure.port : 0;
  }

  /** Whether the choice `prepare` made is a reverse proxy at a public address: the only exposure whose listener is kept. */
  standing(): boolean {
    return this.current?.mode === 'proxy' && this.current.publicUrl !== null;
  }

  async open(target: number): Promise<OpenedRoute> {
    const exposure = this.current;
    if (!exposure) throw new Error('The share route was not prepared.');
    return exposure.mode === 'proxy' ? proxyBase(exposure, target) : this.tailscale.open(target, this.funnelPort);
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
