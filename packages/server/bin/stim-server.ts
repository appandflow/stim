#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { bundledStim, loginShellEnvironment } from '../src/environment.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';
import { createPairingToken, readDevices, revokeDevice, serverDir, type PairedDevice } from '../src/registry.ts';
import { startServer } from '../src/server.ts';
import { findTailscale, tailscaleStatus, type TailscaleState } from '../src/tailscale.ts';

const DEFAULT_PORT = 7787;

const USAGE = `Usage:
  stim-server [--port <n>]          serve paired clients (default port ${DEFAULT_PORT})
  stim-server pair [--port <n>]     print a single-use pairing payload for the QR code
  stim-server devices [list]        list paired devices
  stim-server devices revoke <id>   revoke a paired device`;

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function fail(message: string): never {
  console.error(`stim-server: ${message}`);
  process.exit(1);
}

function tailscaleNote(tailscale: TailscaleState, port: number): string | null {
  const remedy = `Remote clients cannot connect until Tailscale runs; then restart stim-server and run \`tailscale serve --bg http://127.0.0.1:${port}\` once.`;
  if (tailscale.state === 'not-running') return `Tailscale is not running (${tailscale.backendState}). ${remedy}`;
  if (tailscale.state === 'unavailable') return `Tailscale is unavailable: ${tailscale.reason}. ${remedy}`;
  return null;
}

function macName(tailscale: TailscaleState): string {
  return (tailscale.state === 'running' && tailscale.hostName) || hostname();
}

async function serve(port: number): Promise<void> {
  const login = loginShellEnvironment(serverDir());
  if (!login) console.error('stim-server: could not read the login shell environment; using this process environment.');
  const env: NodeJS.ProcessEnv = { ...(login ?? process.env) };
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
  if (tailscale.state === 'running' && tailscale.dnsName) console.log(`tailnet endpoint: wss://${tailscale.dnsName}`);
  const note = tailscaleNote(tailscale, port);
  if (note) console.error(note);
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

function pair(port: number): void {
  const tailscale = tailscaleStatus(findTailscale(process.env), process.env);
  const { token, expiresAt } = createPairingToken();
  const running = tailscale.state === 'running';
  const payload = {
    v: 1,
    name: macName(tailscale),
    endpoint: running && tailscale.dnsName ? `wss://${tailscale.dnsName}` : `ws://127.0.0.1:${port}`,
    pairingToken: token,
  };
  console.log(JSON.stringify(payload));
  console.error(`The pairing token is single use and expires at ${expiresAt}.`);
  const note = tailscaleNote(tailscale, port);
  if (note) console.error(`${note} The endpoint above only works on this Mac.`);
}

function describe(device: PairedDevice): string {
  const from =
    device.identity.kind === 'local'
      ? 'this Mac'
      : `${device.identity.nodeName || device.identity.nodeId}${device.identity.user ? ` (${device.identity.user})` : ''}`;
  return `${device.id}  ${device.name}  from ${from}  paired ${device.pairedAt}  last seen ${device.lastSeenAt ?? 'never'}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
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
  if (command === 'pair' && sub === undefined) return pair(port);
  if (command === 'devices' && (sub === undefined || sub === 'list') && arg === undefined) {
    const devices = readDevices();
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
