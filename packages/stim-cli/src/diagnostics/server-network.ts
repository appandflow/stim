import { isJsonObject } from '@stim-cli/core/state';
import { readTailscale, tailscaleDiagnosis } from '../offload/diagnosis.ts';
import type { Finding } from './doctor.ts';
import { describeServer, sameHome, type ServerSetup } from './server-setup.ts';

const SERVE_PORT = 7443;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '[::]']);
/** `net.ipv4.tcp_notsent_lowat` reads this, the unsigned maximum, while the kernel has no limit set. */
const LOWAT_UNLIMITED = 4_294_967_295;
const RECOMMENDED_LOWAT = 16_384;
const DEFAULT_SERVER_PORT = 7787;

export interface ServeProxy {
  port: number;
  mount: string;
  target: number;
  funnel: boolean;
}

const portOf = (hostPort: string): number => Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));

/**
 * The loopback proxies of `tailscale serve status --json`, an ipn.ServeConfig: `Web` maps `<host>:<port>` to
 * `{ Handlers: { <mount>: { Proxy } } }` and `AllowFunnel` maps `<host>:<port>` to true; `Foreground` holds the same
 * shape per foreground session.
 */
export function parseServeProxies(serve: unknown): ServeProxy[] {
  if (!isJsonObject(serve)) return [];
  const configs = [serve, ...(isJsonObject(serve.Foreground) ? Object.values(serve.Foreground) : [])].filter(
    isJsonObject,
  );
  return configs.flatMap((config) => {
    const funnelPorts = new Set(
      Object.entries(isJsonObject(config.AllowFunnel) ? config.AllowFunnel : {})
        .filter(([, allowed]) => allowed === true)
        .map(([hostPort]) => portOf(hostPort)),
    );
    const target = (address: unknown): number | null => {
      if (typeof address !== 'string') return null;
      const text = address.includes('://') ? address : `tcp://${address}`;
      if (!URL.canParse(text)) return null;
      const url = new URL(text);
      if (!LOOPBACK.has(url.hostname) && !LOOPBACK.has(`[${url.hostname}]`)) return null;
      return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    };
    const forwards = Object.entries(isJsonObject(config.TCP) ? config.TCP : {}).flatMap(([port, listener]) => {
      const to = isJsonObject(listener) ? target(listener.TCPForward) : null;
      return to === null ? [] : [{ port: Number(port), mount: '/', target: to, funnel: funnelPorts.has(Number(port)) }];
    });
    const webs = Object.entries(isJsonObject(config.Web) ? config.Web : {}).flatMap(([hostPort, web]) => {
      const handlers = isJsonObject(web) && isJsonObject(web.Handlers) ? web.Handlers : {};
      return Object.entries(handlers).flatMap(([mount, handler]): ServeProxy[] => {
        const to = isJsonObject(handler) ? target(handler.Proxy) : null;
        const port = portOf(hostPort);
        return to === null ? [] : [{ port, mount, target: to, funnel: funnelPorts.has(port) }];
      });
    });
    return forwards.concat(webs);
  });
}

function freeServePort(serve: unknown): number {
  const used = new Set<number>();
  if (isJsonObject(serve)) {
    for (const config of [serve, ...(isJsonObject(serve.Foreground) ? Object.values(serve.Foreground) : [])]) {
      if (!isJsonObject(config)) continue;
      for (const port of Object.keys(isJsonObject(config.TCP) ? config.TCP : {})) used.add(Number(port));
      for (const field of ['Web', 'AllowFunnel']) {
        for (const hostPort of Object.keys(isJsonObject(config[field]) ? config[field] : {}))
          used.add(portOf(hostPort));
      }
    }
  }
  let port = SERVE_PORT;
  while (used.has(port)) port += 1;
  return port;
}

const serveCommand = (port: number, target: number): string =>
  `tailscale serve --bg --https=${port} http://127.0.0.1:${target}`;

function stimPorts(setup: ServerSetup): Set<number> {
  return new Set([
    ...setup.servers.filter((server) => server.kind !== 'share').map((server) => server.port),
    ...setup.services.map((service) => service.installed.port ?? DEFAULT_SERVER_PORT),
  ]);
}

function loggedIn(status: unknown): boolean {
  if (!isJsonObject(status) || status.BackendState !== 'Running') return false;
  const self = isJsonObject(status.Self) ? status.Self : null;
  return typeof self?.DNSName === 'string' && self.DNSName.replace(/\.$/, '') !== '';
}

function shareMode(setup: ServerSetup): 'tailscale' | 'proxy' {
  const { exposure } = setup.network.share;
  return exposure === 'auto' ? (loggedIn(setup.network.tailscaleStatus) ? 'tailscale' : 'proxy') : exposure;
}

function tailscaleFindings(setup: ServerSetup): Finding[] {
  const { network } = setup;
  const usesTailnet =
    setup.services.some((service) => service.installed.serve) || setup.clients.build + setup.clients.deviceHost > 0;
  const reading = readTailscale(network.tailscaleStatus);
  if (!usesTailnet) return [];
  const lan = setup.servers.some((server) => server.health?.lan === true);
  if (!reading.running) {
    const diagnosis = tailscaleDiagnosis(reading.code, network.host);
    return [
      {
        code: 'server-tailscale',
        level: lan ? 'note' : 'cost',
        title: 'Tailscale is not running, so no other machine or phone can reach this stim-server over the tailnet',
        detail: `${diagnosis.message} This machine has a stim service with a tailnet route or approved build or device-host clients.${lan ? ' The server also listens on the local network, which clients there can still use.' : ''}`,
        fix: diagnosis.remedy,
      },
    ];
  }
  if (network.serve === null) return [];
  const proxies = parseServeProxies(network.serve);
  return setup.servers.flatMap((server): Finding[] => {
    if (server.kind === 'share' || server.health === null || server.health.loopbackOnly) return [];
    if (!sameHome(server.health.stimHome, setup.stimHome)) return [];
    if (server.kind !== 'service' && server.port !== setup.local?.port) return [];
    if (proxies.some((proxy) => proxy.target === server.port)) return [];
    const service = server.kind === 'service' ? setup.services.find((each) => each.label === server.label) : undefined;
    const recorded = service?.installed.serve?.port;
    const elsewhere = proxies.find((proxy) => proxy.port === recorded && proxy.target !== server.port);
    if (recorded !== undefined && elsewhere) {
      return [
        {
          code: 'server-tailscale-route',
          level: 'cost',
          title: `The tailscale serve route on https port ${recorded} points at port ${elsewhere.target}, not at stim-server`,
          detail: `${describeServer(server)} listens on port ${server.port}, but the route that \`stim service install --serve\` recorded for it proxies to 127.0.0.1:${elsewhere.target}, so phones and other machines reach nothing or another program.`,
          fix: `Run \`${serveCommand(recorded, server.port)}\` to point the route at the server.`,
        },
      ];
    }
    const port = recorded ?? freeServePort(network.serve);
    return [
      {
        code: 'server-tailscale-route',
        level: recorded === undefined ? 'note' : 'cost',
        title: 'No tailscale serve route reaches this stim-server',
        detail: `${describeServer(server)} has no tailnet-only https route, so phones and other machines on the tailnet cannot connect over Tailscale.${recorded === undefined ? '' : ` The service was installed with a route on https port ${recorded}, and it is gone.`}`,
        fix: `Run \`${serveCommand(port, server.port)}\`.`,
      },
    ];
  });
}

function funnelFindings(setup: ServerSetup): Finding[] {
  const { network } = setup;
  const funnels = parseServeProxies(network.serve).filter((proxy) => proxy.funnel);
  if (funnels.length === 0) return [];
  const ports = stimPorts(setup);
  const sharesOverFunnel = shareMode(setup) === 'tailscale';
  const open = (network.shares ?? []).filter((share) => share.auth === 'none');
  const exposed = funnels.flatMap((funnel): Finding[] =>
    ports.has(funnel.target)
      ? [
          {
            code: 'server-funnel',
            level: 'cost',
            title: 'PUBLIC: a Tailscale Funnel route exposes stim-server to the internet',
            detail: `https port ${funnel.port} is a Funnel port and proxies to stim-server on port ${funnel.target}, so anyone on the internet can reach it. stim-server serves only tailnet routes; stim service install refuses this.`,
            fix: `Run \`tailscale funnel --https=${funnel.port} off\`, then check \`tailscale serve status\`.`,
          },
        ]
      : [],
  );
  const candidates = funnels.filter(
    (funnel) => !ports.has(funnel.target) && funnel.mount === '/' && sharesOverFunnel && open.length > 0,
  );
  if (candidates.length === 0) return exposed;
  const names = open.map((share) => `${share.id} (${share.workspace})`).join(', ');
  const routes = [...new Set(candidates.map((funnel) => `https port ${funnel.port} (to 127.0.0.1:${funnel.target})`))];
  return [
    ...exposed,
    {
      code: 'server-funnel',
      level: 'cost',
      title: 'PUBLIC: a Tailscale Funnel route is open while a share has no password',
      detail: `${open.length === 1 ? 'This share has' : 'These shares have'} no password, so its URL token is the only secret: ${names}. Shares are served through a Funnel route and ${routes.join(', ')} ${routes.length === 1 ? 'is' : 'are'} public; share rows carry no listener port, so doctor cannot tell which route is the share's.`,
      fix: 'End the share with `stim share stop` in its workspace (`stim share list` names them) and start it again with a password. Stim removes its Funnel route when the last share ends.',
    },
  ];
}

function shareFindings(setup: ServerSetup): Finding[] {
  const { network, servers } = setup;
  const { exposure, publicUrl } = network.share;
  const mode = shareMode(setup);
  const sharing = servers.some((server) => server.kind === 'share') || (network.shares ?? []).length > 0;
  const findings: Finding[] = [];
  if (mode === 'proxy' && publicUrl === null && (exposure === 'proxy' || sharing)) {
    findings.push({
      code: 'server-share-proxy',
      level: 'note',
      title: 'Shares run in proxy mode with no share.publicUrl',
      detail: `${exposure === 'proxy' ? '`share.exposure` is proxy' : 'Tailscale is not signed in, so `share.exposure` auto chose proxy mode'}, which binds the share listener to 127.0.0.1 for your reverse proxy. Without \`share.publicUrl\` the links it prints are loopback addresses that work only on this machine.`,
      fix: 'Set the https address your reverse proxy serves: `stim settings set share.publicUrl https://demo.example.com`. Or sign in to Tailscale and set `share.exposure` to tailscale to share through Funnel.',
    });
  }
  const shareHost = sharing || (mode === 'proxy' && publicUrl !== null);
  if (shareHost && network.notsentLowat !== null && network.notsentLowat >= LOWAT_UNLIMITED) {
    findings.push({
      code: 'server-tcp-lowat',
      level: 'note',
      title: 'This share host leaves net.ipv4.tcp_notsent_lowat unlimited',
      detail: `The kernel buffers an unlimited amount of unsent data per socket, so a slow viewer's video frames queue up and the share lags. Doctor changes no kernel setting; this is advice.`,
      fix: `Run \`sudo sysctl -w net.ipv4.tcp_notsent_lowat=${RECOMMENDED_LOWAT}\`, and keep it after a reboot with \`net.ipv4.tcp_notsent_lowat = ${RECOMMENDED_LOWAT}\` in a file under /etc/sysctl.d/.`,
    });
  }
  return findings;
}

export function serverNetworkFindings(setup: ServerSetup): Finding[] {
  return [...tailscaleFindings(setup), ...funnelFindings(setup), ...shareFindings(setup)];
}
