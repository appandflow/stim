import { isJsonObject, portOf, runTailscale } from './shared.ts';

const TIMEOUT_MS = 5000;
const FUNNEL_TIMEOUT_MS = 20_000;
const DEFAULT_FUNNEL_PORTS = [443, 8443, 10000];
const FUNNEL_PORTS_CAP = 'https://tailscale.com/cap/funnel-ports?ports=';

/** A public Funnel route that proxies one whole HTTPS port to `http://127.0.0.1:<target>`. */
export interface FunnelRoute {
  port: number;
  target: number;
}

/**
 * Whether the node may use Funnel and on which ports, from `tailscale status --json` `Self.CapMap`: the `funnel`
 * capability, and `https://tailscale.com/cap/funnel-ports?ports=443,8443,10000` naming the ports the tailnet policy
 * allows.
 */
export function funnelPorts(status: unknown): number[] | null {
  const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : null;
  const caps = self && isJsonObject(self.CapMap) ? Object.keys(self.CapMap) : [];
  if (!caps.includes('funnel')) return null;
  const listed = caps.find((cap) => cap.startsWith(FUNNEL_PORTS_CAP));
  if (!listed) return DEFAULT_FUNNEL_PORTS;
  const ports = listed
    .slice(FUNNEL_PORTS_CAP.length)
    .split(',')
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return ports.length ? ports : null;
}

function configs(serve: Record<string, unknown>): Record<string, unknown>[] {
  return [serve, ...(isJsonObject(serve.Foreground) ? Object.values(serve.Foreground) : [])].filter(isJsonObject);
}

function usedPorts(serve: Record<string, unknown>): Set<number> {
  const used = new Set<number>();
  for (const config of configs(serve)) {
    for (const port of Object.keys(isJsonObject(config.TCP) ? config.TCP : {})) used.add(Number(port));
    for (const field of ['Web', 'AllowFunnel']) {
      for (const hostPort of Object.keys(isJsonObject(config[field]) ? config[field] : {})) used.add(portOf(hostPort));
    }
  }
  return used;
}

/** The first allowed Funnel port that nothing in the node's serve config, foreground sessions included, uses. */
export function freeFunnelPort(serve: unknown, allowed: number[]): number | null {
  if (!isJsonObject(serve)) return null;
  const used = usedPorts(serve);
  return allowed.find((port) => !used.has(port)) ?? null;
}

/**
 * Whether port `route.port` of the background serve config holds exactly the route a share adds: HTTPS, one `/`
 * handler proxying to `http://127.0.0.1:<target>`, Funnel on, and nothing for that port in a foreground session.
 */
export function holdsFunnelRoute(serve: unknown, route: FunnelRoute): boolean {
  if (!isJsonObject(serve)) return false;
  const tcp = isJsonObject(serve.TCP) ? serve.TCP : {};
  const listener = tcp[String(route.port)];
  if (!isJsonObject(listener) || listener.HTTPS !== true || Object.keys(listener).length !== 1) return false;
  const webs = Object.entries(isJsonObject(serve.Web) ? serve.Web : {}).filter(
    ([hostPort]) => portOf(hostPort) === route.port,
  );
  const [web, ...otherWebs] = webs;
  if (!web || otherWebs.length) return false;
  const handlers = isJsonObject(web[1]) && isJsonObject(web[1].Handlers) ? web[1].Handlers : {};
  const [handler, ...otherHandlers] = Object.entries(handlers);
  if (!handler || otherHandlers.length || handler[0] !== '/') return false;
  if (!isJsonObject(handler[1]) || handler[1].Proxy !== `http://127.0.0.1:${route.target}`) return false;
  const [funnel, ...otherFunnels] = Object.entries(isJsonObject(serve.AllowFunnel) ? serve.AllowFunnel : {}).filter(
    ([hostPort]) => portOf(hostPort) === route.port,
  );
  if (!funnel || otherFunnels.length || funnel[1] !== true) return false;
  const foreground = isJsonObject(serve.Foreground) ? Object.values(serve.Foreground).filter(isJsonObject) : [];
  return foreground.every((config) => !usedPorts(config).has(route.port));
}

async function run(binary: string, env: NodeJS.ProcessEnv, args: string[], timeout: number): Promise<string> {
  const { error, stdout, stderr } = await runTailscale(binary, env, args, { timeout });
  if (!error) return stdout;
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  throw new Error(
    `\`tailscale ${args.join(' ')}\` ${error.killed ? 'timed out' : 'failed'}${detail ? `: ${detail}` : ''}`,
  );
}

/** `tailscale serve status --json`, an ipn.ServeConfig; `{}` when nothing is served. */
export async function readServeConfig(binary: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const printed = await run(binary, env, ['serve', 'status', '--json'], TIMEOUT_MS);
  let parsed: unknown;
  try {
    parsed = printed.trim() ? JSON.parse(printed) : {};
  } catch {
    throw new Error('`tailscale serve status --json` printed output that is not JSON');
  }
  if (!isJsonObject(parsed)) throw new Error('`tailscale serve status --json` printed no serve config');
  return parsed;
}

/**
 * Adds the background Funnel route. A foreground `tailscale funnel` would end with its process, but the macOS app's
 * CLI refuses foreground sessions from a process without a terminal, so the route is a background one.
 */
export async function addFunnelRoute(binary: string, env: NodeJS.ProcessEnv, route: FunnelRoute): Promise<void> {
  await run(
    binary,
    env,
    ['funnel', '--bg', '--yes', `--https=${route.port}`, `http://127.0.0.1:${route.target}`],
    FUNNEL_TIMEOUT_MS,
  );
}

/** Removes the whole serve config of `route.port`. Callers check {@link holdsFunnelRoute} first. */
export async function removeFunnelRoute(binary: string, env: NodeJS.ProcessEnv, route: FunnelRoute): Promise<void> {
  await run(binary, env, ['funnel', `--https=${route.port}`, 'off'], FUNNEL_TIMEOUT_MS);
}
