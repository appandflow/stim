#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { bundledStim, loginShellEnvironment } from '../src/environment.ts';
import { readAudit } from '../src/actions.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  readBuildClients,
  readDevices,
  revokeDevice,
  type PairedDevice,
} from '../src/registry.ts';
import { startServer } from '../src/server.ts';
import {
  findTailscale,
  serveCommand,
  serveRoute,
  tailnetEndpoint,
  tailscaleStatus,
  type ServeRoute,
  type TailscaleState,
} from '../src/tailscale.ts';

const DEFAULT_PORT = 7787;

const USAGE = `Usage:
  stim-server [--port <n>]          serve paired clients (default port ${DEFAULT_PORT})
  stim-server pair [--port <n>] [--control|--build] [--json]
                                    print a single-use pairing payload for the QR code;
                                    --control lets the paired device run actions;
                                    --build lets another Mac on the tailnet build here
  stim-server devices [list] [--json]
                                    list paired devices, build clients and build requests
  stim-server devices grant <id> --control|--read|--build
                                    let a paired device run actions, or only read;
                                    --build approves a Mac's request to build here
  stim-server devices revoke <id>   revoke a paired device or build client, or deny a request
  stim-server log [--json]          list the actions paired devices ran`;

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function fail(message: string): never {
  console.error(`stim-server: ${message}`);
  process.exit(1);
}

function tailscaleNote(tailscale: TailscaleState): string | null {
  const remedy = `Remote clients cannot connect until Tailscale runs; then restart stim-server, which prints the \`tailscale serve\` command to run once.`;
  if (tailscale.state === 'not-running') return `Tailscale is not running (${tailscale.backendState}). ${remedy}`;
  if (tailscale.state === 'unavailable') return `Tailscale is unavailable: ${tailscale.reason}. ${remedy}`;
  return null;
}

function routeNote(route: ServeRoute, port: number): string | null {
  if (route.state === 'missing') {
    return `No \`tailscale serve\` route reaches port ${port}, so phones cannot connect yet. Run this once to serve it on a tailnet-only port: \`${serveCommand(route.port, port)}\``;
  }
  if (route.state === 'unknown') {
    return `Could not read \`tailscale serve status --json\` (${route.reason}); assuming stim-server is served on port ${route.port}.`;
  }
  if (route.state === 'funneled') {
    const ports = route.ports.join(', ');
    return `Tailscale Funnel is on for port ${ports}, which proxies to stim-server, so the server is reachable from the public internet. Remove that handler (see \`tailscale serve status\`), then serve stim-server on a tailnet-only port: \`${serveCommand(route.port, port)}\``;
  }
  return null;
}

function macName(tailscale: TailscaleState): string {
  return (tailscale.state === 'running' && tailscale.hostName) || hostname();
}

async function serve(port: number): Promise<void> {
  const login = loginShellEnvironment();
  if (!login) console.error('stim-server: could not read the login shell environment; using this process environment.');
  const env: NodeJS.ProcessEnv = { ...(login ?? process.env) };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (!process.env.STIM_HOME && env.STIM_HOME) process.env.STIM_HOME = env.STIM_HOME;
  if (process.env.STIM_HOME) env.STIM_HOME = process.env.STIM_HOME;

  const tailscaleBinary = findTailscale(env);
  const tailscale = tailscaleStatus(tailscaleBinary, env);
  const stim = bundledStim();
  const hosts = ['127.0.0.1', ...(tailscale.state === 'running' ? tailscale.ips : [])];
  let server;
  try {
    server = await startServer({
      name: macName(tailscale),
      hosts,
      port,
      stimCli: stim.cli,
      stimVersion: stim.version,
      serverVersion: pkg.version,
      env,
      tailscale: tailscaleBinary,
      tailscaleState: tailscale,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail(`port ${port} is in use; another stim-server may already be running. Pass --port to use another port.`);
    }
    throw error;
  }
  console.log(`stim-server ${pkg.version} (stim ${stim.version}, protocol ${PROTOCOL_VERSION})`);
  for (const { host, port: bound } of server.addresses) {
    console.log(`listening on ws://${host.includes(':') ? `[${host}]` : host}:${bound}`);
  }
  let note = tailscaleNote(tailscale);
  if (tailscale.state === 'running' && tailscale.dnsName) {
    const route = await serveRoute(tailscaleBinary, env, port, tailscale.ips);
    if (route.state !== 'funneled') console.log(`tailnet endpoint: ${tailnetEndpoint(tailscale.dnsName, route.port)}`);
    note = routeNote(route, port);
    if (route.state === 'funneled') note = `${note} Pairing is refused until then.`;
  }
  if (note) console.error(note);
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

type Scope = 'read' | 'control' | 'build';

const SCOPE_TEXT: Record<Scope, string> = {
  read: 'only read',
  control: 'run actions',
  build: 'run its project code on this Mac to build',
};

async function pair(port: number, json: boolean, scope: Scope): Promise<void> {
  const binary = findTailscale(process.env);
  const tailscale = tailscaleStatus(binary, process.env);
  let endpoint = `ws://127.0.0.1:${port}`;
  let note = tailscaleNote(tailscale);
  if (scope === 'build' && note) fail(`refusing to pair for builds. ${note}`);
  if (note) note = `${note} The endpoint above only works on this Mac.`;
  if (tailscale.state === 'running' && tailscale.dnsName) {
    const route = await serveRoute(binary, process.env, port, tailscale.ips);
    if (route.state === 'funneled') fail(`refusing to pair. ${routeNote(route, port)}`);
    if (scope === 'build' && route.state !== 'routed') fail(`refusing to pair for builds. ${routeNote(route, port)}`);
    endpoint = tailnetEndpoint(tailscale.dnsName, route.port);
    note = routeNote(route, port);
  }
  const node = tailscale.state === 'running' ? tailscale.nodeId : undefined;
  if (scope === 'build' && (!node || !endpoint.startsWith('wss://'))) {
    fail('refusing to pair for builds: `tailscale status --json` named no DNS name or node ID for this Mac.');
  }
  const capabilities = scope === 'build' ? (['build'] as const) : capabilitiesFor(scope === 'control');
  const { token, expiresAt } = createPairingToken(Date.now(), [...capabilities]);
  const payload = {
    v: 1,
    name: macName(tailscale),
    endpoint,
    ...(scope === 'build' ? { node } : {}),
    pairingToken: token,
  };
  if (json) return void console.log(JSON.stringify({ qr: payload, expiresAt }));
  console.log(JSON.stringify(payload));
  const holder = scope === 'build' ? 'Mac that spends it' : 'device it pairs';
  console.error(`The pairing token is single use and expires at ${expiresAt}. The ${holder} can ${SCOPE_TEXT[scope]}.`);
  if (note) console.error(note);
}

function describe(device: PairedDevice): string {
  const from =
    device.identity.kind === 'local'
      ? 'this Mac'
      : `${device.identity.nodeName || device.identity.nodeId}${device.identity.user ? ` (${device.identity.user})` : ''}`;
  if (device.pendingUntil !== undefined) {
    return `${device.id}  ${device.name}  pending build  from ${from}  requested ${device.pairedAt}  lapses ${device.pendingUntil}`;
  }
  const scope = device.capabilities.includes('build')
    ? 'build'
    : device.capabilities.includes('control')
      ? 'control'
      : 'read';
  return `${device.id}  ${device.name}  ${scope}  from ${from}  paired ${device.pairedAt}  last seen ${device.lastSeenAt ?? 'never'}`;
}

function scopeFlag(values: { read?: boolean; control?: boolean; build?: boolean }): Scope | null | 'many' {
  const set = (['read', 'control', 'build'] as const).filter((scope) => values[scope] === true);
  if (set.length > 1) return 'many';
  return set[0] ?? null;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      json: { type: 'boolean' },
      control: { type: 'boolean' },
      read: { type: 'boolean' },
      build: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(pkg.version);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, got ${values.port}.`);
  const [command, sub, arg, ...rest] = positionals;
  if (command === undefined) return serve(port);
  const grant = command === 'devices' && sub === 'grant';
  if (values.read && !grant) fail(`--read applies only to \`devices grant\`.\n${USAGE}`);
  for (const flag of ['control', 'build'] as const) {
    if (values[flag] && !grant && command !== 'pair') {
      fail(`--${flag} applies only to \`pair\` and \`devices grant\`.\n${USAGE}`);
    }
  }
  const scope = scopeFlag(values);
  if (command === 'pair' && sub === undefined) {
    if (scope === 'many' || scope === 'read') fail('pair takes at most one of --control or --build.');
    return pair(port, values.json === true, scope ?? 'read');
  }
  if (grant && arg !== undefined && rest.length === 0) {
    if (scope === null || scope === 'many') fail('devices grant takes exactly one of --control, --read or --build.');
    const capabilities = scope === 'build' ? (['build'] as const) : capabilitiesFor(scope === 'control');
    const outcome = grantDevice(arg, [...capabilities]);
    if (outcome === 'unknown') {
      fail(
        `no paired device ${arg}, and no pending build request with that id (requests lapse after 15 minutes). Run \`stim-server devices\` to list them.`,
      );
    }
    if (outcome === 'build-mismatch') {
      fail(
        scope === 'build'
          ? `${arg} is a paired device, not a Mac that asked to build here. A Mac asks with a build request or \`stim-server pair --build\`.`
          : `${arg} is a build client; it takes only --build. Revoke it with \`stim-server devices revoke ${arg}\`.`,
      );
    }
    console.log(`${arg} can now ${SCOPE_TEXT[scope]}.`);
    return;
  }
  if (command === 'log' && sub === undefined) {
    const records = readAudit();
    if (values.json) return void console.log(JSON.stringify({ actions: records }));
    if (!records.length) console.log('No actions.');
    for (const record of records) {
      const outcome = record.ok
        ? `ok${record.reason ? ` (${record.reason})` : ''}`
        : `${record.error?.code ?? 'failed'}: ${record.error?.message ?? ''}`;
      const line = `${record.at}  ${record.device.id} (${record.device.name})  ${record.action}  ${record.workspace}  ${outcome}`;
      console.log(Array.from(line, (char) => (/\p{Cc}/u.test(char) ? '?' : char)).join(''));
    }
    return;
  }
  if (command === 'devices' && (sub === undefined || sub === 'list') && arg === undefined) {
    const devices = [...readDevices(), ...readBuildClients()];
    if (values.json) {
      const listed = devices.map(({ id, name, identity, pairedAt, lastSeenAt, capabilities, pendingUntil }) => ({
        id,
        name,
        identity,
        pairedAt,
        lastSeenAt,
        capabilities,
        ...(pendingUntil ? { pendingUntil } : {}),
      }));
      return void console.log(JSON.stringify({ devices: listed }));
    }
    if (!devices.length) console.log('No paired devices.');
    for (const device of devices) console.log(describe(device));
    return;
  }
  if (command === 'devices' && sub === 'revoke' && arg !== undefined && rest.length === 0) {
    if (!revokeDevice(arg)) fail(`no paired device ${arg}. Run \`stim-server devices\` to list them.`);
    console.log(`Revoked ${arg}.`);
    return;
  }
  fail(`unknown command.\n${USAGE}`);
}

await main();
