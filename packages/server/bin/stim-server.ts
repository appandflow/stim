#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readHostedSessions } from '@stim-cli/core/state';
import { discoverToolchain } from '@stim-cli/core/toolchain';
import { bundledStim } from '../src/environment.ts';
import { formatHostedSessions, readHostedSessionRows } from '../src/hosted-sessions.ts';
import { readAudit } from '../src/actions.ts';
import {
  installService,
  rollbackService,
  serviceStatus,
  statusLines,
  uninstallService,
  updateService,
} from '../src/service.ts';
import {
  applyServeEnvironment,
  DEFAULT_LABEL,
  DEFAULT_PORT,
  ServiceError,
  validateLabel,
  validatePort,
  validateRelease,
  validateServeEnvironment,
} from '../src/service-plist.ts';
import { PROTOCOL_VERSION } from '../src/protocol.ts';
import { serviceManagerOrNull } from '../src/service-manager.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  revokeDevice,
  type PairedDevice,
} from '../src/registry.ts';
import { hostFromExecutable, hostPermissionPanes } from '../src/stim-host.ts';
import { defaultSetupDeps, runSetup } from '../src/setup.ts';
import { startServer } from '../src/server.ts';
import { readDesktopBootstrap } from '../src/desktop-bootstrap.ts';
import type { ServeRoute } from '@stim-cli/core/protocol';
import { loadTransport } from '@stim-cli/transport';
import {
  findTailscale,
  serveCommand,
  serveRoute,
  tailnetEndpoint,
  readTailscaleStatus,
  isTailscaleTransport,
  type TailscaleState,
} from '@stim-cli/transport-tailscale';

const USAGE = `Usage:
  stim-server [--port <n>] [--loopback-only] [--env KEY=VALUE]... [--path-prepend <dir>]...
                                    serve paired clients (default port ${DEFAULT_PORT});
                                    --loopback-only serves this machine only (127.0.0.1, no remote peers);
                                    --env and --path-prepend apply after the login shell's environment
  STIM_SETUP_TICKET=<t> stim-server setup --client <node-id> --expires <iso>
                    [--build] [--device-host] [--port <n>] [--label <name>]
                    [--env KEY=VALUE]... [--path-prepend <dir>]... [--yes] [--json] [--verbose]
                                    worker-side approval for this node and ticket until expiry
  stim-server service install [--port <n>] [--label <name>] [--serve]
                              [--env KEY=VALUE]... [--path-prepend <dir>]...
                                    run stim-server as a macOS LaunchAgent that starts at login,
                                    a Linux systemd user service, or a Windows scheduled task;
                                    --serve adds a tailnet-only \`tailscale serve\` route
  stim-server service status [--label <name>] [--json]
  stim-server service update [--label <name>] --release <version>|--from <dir>
                                    install that stim-server release from npm, or the .tgz
                                    packages in <dir>, beside the current one, switch the
                                    service to it, and switch back if it does not answer
  stim-server service rollback [--label <name>]
                                    switch the service back to the server it ran before
  stim-server service uninstall [--label <name>]
                                    remove the service (and the route install created)
  stim-server pair [--port <n>] [--control] [--json]
                                    print a single-use pairing payload for the QR code;
                                    --control lets the paired device run actions
  stim-server devices [list] [--json]
                                    list paired devices, approved clients, access requests and hosted sessions
  stim-server devices grant <id> --control|--read|--build|--device-host
                                    let a paired device run actions, or only read;
                                    --build approves a machine's request to build here;
                                    --device-host approves its device-host request
  stim-server devices revoke <id>   revoke a paired device or client, or deny a request
  stim-server log [--json]          list the actions paired devices ran`;

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

function fail(message: string): never {
  console.error(`stim-server: ${message}`);
  process.exit(1);
}

function tailscaleNote(tailscale: TailscaleState): string | null {
  const remedy = `Remote clients cannot connect until Tailscale runs; stim-server checks again every few seconds and then prints the \`tailscale serve\` command to run once.`;
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

async function serve(port: number, extraEnv: string[], pathPrepend: string[], loopbackOnly: boolean): Promise<void> {
  const bootstrapFd = process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  delete process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  if (bootstrapFd !== undefined && bootstrapFd !== '0') fail('Desktop bootstrap input is invalid or unavailable.');
  const desktopInput =
    bootstrapFd === '0'
      ? await readDesktopBootstrap(process.stdin).catch(() =>
          fail('Desktop bootstrap input is invalid or unavailable.'),
        )
      : undefined;
  delete process.env.NODE_COMPILE_CACHE;
  const captureHost = hostFromExecutable(process.env.STIM_HOST_EXECUTABLE);
  const env = applyServeEnvironment(discoverToolchain(process.env).env, extraEnv, pathPrepend);
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (!process.env.STIM_HOME && env.STIM_HOME) process.env.STIM_HOME = env.STIM_HOME;
  if (process.env.STIM_HOME) env.STIM_HOME = process.env.STIM_HOME;
  Object.assign(process.env, env);

  const loaded = await loadTransport({
    reference: '@stim-cli/transport-tailscale',
    load: () => import('@stim-cli/transport-tailscale'),
    input: { env, options: {} },
  });
  if ('unavailable' in loaded) fail(`the Tailscale transport is unavailable: ${loaded.unavailable}`);
  if (!isTailscaleTransport(loaded.transport))
    fail('@stim-cli/transport-tailscale did not create a Tailscale transport');
  const transport = loaded.transport;
  const { state: tailscale } = transport.snapshot();
  const stim = bundledStim();
  let server;
  try {
    server = await startServer({
      desktopBootstrap: desktopInput?.bootstrap,
      name: macName(tailscale),
      host: captureHost,
      hosts: ['127.0.0.1'],
      ...(loopbackOnly ? { loopbackOnly: true } : {}),
      port,
      stimCli: stim.cli,
      stimVersion: stim.version,
      serverVersion: pkg.version,
      env,
      transports: [transport],
      service: {
        label: serviceManagerOrNull()?.runningLabel(process.env) ?? null,
        node: process.execPath,
        script: realpathSync(process.argv[1] ?? ''),
      },
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
  const announce = async (state: TailscaleState) => {
    let note = tailscaleNote(state);
    if (state.state === 'running' && state.dnsName) {
      const route = await transport.serveRoute(port);
      if (route.state !== 'funneled') console.log(`tailnet endpoint: ${tailnetEndpoint(state.dnsName, route.port)}`);
      note = routeNote(route, port);
      if (route.state === 'funneled') note = `${note} Pairing is refused until then.`;
    }
    if (note) console.error(note);
  };
  if (!loopbackOnly)
    transport.monitor?.onChange((snapshot, previous) => {
      const { state } = snapshot;
      if (state.state === 'running') console.log('Tailscale is running.');
      else if (previous.state.state === 'running') console.error('Tailscale stopped.');
      if (state.state === 'running' || previous.state.state === 'running') void announce(state);
    });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    transport.close?.();
    void server
      .close()
      .catch((error: unknown) => {
        reportShutdownFailure(error);
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  void desktopInput?.closed.then(shutdown);
  if (!loopbackOnly) await announce(tailscale);
}

function reportShutdownFailure(failure: unknown): void {
  if (failure instanceof AggregateError) {
    for (const kept of failure.errors) reportShutdownFailure(kept);
  } else {
    process.stderr.write(`stim-server: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  }
}

type Scope = 'read' | 'control' | 'build' | 'device-host';

const SCOPE_TEXT: Record<Scope, string> = {
  read: 'only read',
  control: 'run actions',
  build: 'run its project code on this machine to build',
  'device-host': 'request session-owned device hosting on this machine',
};

async function pair(port: number, json: boolean, control: boolean): Promise<void> {
  const binary = findTailscale(process.env);
  const tailscale = await readTailscaleStatus(binary, process.env);
  let endpoint = `ws://127.0.0.1:${port}`;
  let note = tailscaleNote(tailscale);
  if (note) note = `${note} The endpoint above only works on this machine.`;
  if (tailscale.state === 'running' && tailscale.dnsName) {
    const route = await serveRoute(binary, process.env, port, tailscale.ips);
    if (route.state === 'funneled') fail(`refusing to pair. ${routeNote(route, port)}`);
    endpoint = tailnetEndpoint(tailscale.dnsName, route.port);
    note = routeNote(route, port);
  }
  const { token, expiresAt } = createPairingToken(Date.now(), capabilitiesFor(control));
  const payload = { v: 1, name: macName(tailscale), endpoint, pairingToken: token };
  if (json) return void console.log(JSON.stringify({ qr: payload, expiresAt }));
  console.log(JSON.stringify(payload));
  console.error(
    `The pairing token is single use and expires at ${expiresAt}. The device it pairs can ${control ? 'run actions' : 'only read'}.`,
  );
  if (note) console.error(note);
}

function nodeOf(client: PairedDevice): string | null {
  return client.identity.kind === 'tailnet' ? client.identity.nodeId : null;
}

function ambiguousGrant(id: string): string {
  const registries = [
    { capability: 'build', clients: readBuildClients() },
    { capability: 'device-host', clients: readDeviceHostClients() },
  ];
  const registry = registries.find(({ clients }) => clients.some((client) => client.id === id));
  const target = registry?.clients.find((client) => client.id === id);
  const pending = (registry?.clients ?? []).filter(
    (client) => target && client.pendingUntil !== undefined && nodeOf(client) === nodeOf(target),
  );
  return [
    `${id} is one of several pending ${registry?.capability ?? 'access'} requests from the same Mac, and any process on this Mac can file one in its name:`,
    ...pending.map((client) => `  ${describe(client)}`),
    `The requesting Mac printed its own request id in its remedy (\`stim-server devices grant <id> --${registry?.capability ?? 'build'}\`); the name and request time above are whatever the requester sent. Revoke every other request with \`stim-server devices revoke <id>\`, then grant that id.`,
  ].join('\n');
}

function describe(device: PairedDevice): string {
  const from =
    device.identity.kind === 'local'
      ? 'this machine'
      : `${device.identity.nodeName || device.identity.nodeId}${device.identity.user ? ` (${device.identity.user})` : ''}`;
  if (device.pendingUntil !== undefined) {
    return `${device.id}  ${device.name}  pending ${device.requestedCapability ?? 'build'}  from ${from}  requested ${device.pairedAt}  lapses ${device.pendingUntil}  ${device.setupTicketHash ? 'with setup ticket' : 'no setup ticket'}`;
  }
  const scope = device.capabilities.includes('device-host')
    ? 'device-host'
    : device.capabilities.includes('build')
      ? 'build'
      : device.capabilities.includes('control')
        ? 'control'
        : 'read';
  return `${device.id}  ${device.name}  ${scope}  from ${from}  paired ${device.pairedAt}  last seen ${device.lastSeenAt ?? 'never'}`;
}

function scopeFlag(values: {
  read?: boolean;
  control?: boolean;
  build?: boolean;
  'device-host'?: boolean;
}): Scope | null | 'many' {
  const set = (['read', 'control', 'build', 'device-host'] as const).filter((scope) => values[scope] === true);
  if (set.length > 1) return 'many';
  return set[0] ?? null;
}

async function runService(
  sub: string | undefined,
  extra: string | undefined,
  values: {
    label?: string;
    serve?: boolean;
    json?: boolean;
    port?: string;
    env?: string[];
    'path-prepend'?: string[];
    release?: string;
    from?: string;
  },
  env: string[],
  pathPrepend: string[],
): Promise<void> {
  const label = values.label ?? DEFAULT_LABEL;
  const labelProblem = validateLabel(label);
  if (labelProblem) fail(labelProblem);
  if (extra !== undefined || !['install', 'status', 'update', 'rollback', 'uninstall'].includes(sub ?? '')) {
    fail(`unknown command.\n${USAGE}`);
  }
  if (sub !== 'update' && (values.release !== undefined || values.from !== undefined)) {
    fail(`--release and --from apply only to \`service update\`.\n${USAGE}`);
  }
  if (sub !== 'install' && (values.serve || values.port !== undefined || values.env || values['path-prepend'])) {
    fail(`--port, --serve, --env and --path-prepend apply only to \`service install\`.\n${USAGE}`);
  }
  if (sub !== 'status' && values.json) fail(`--json applies only to \`service status\`.\n${USAGE}`);
  try {
    if (sub === 'install') {
      const installPort = values.port === undefined ? DEFAULT_PORT : validatePort(values.port);
      if (typeof installPort === 'string') fail(installPort);
      for (const line of await installService({
        label,
        port: installPort,
        env,
        pathPrepend,
        serve: values.serve === true,
      })) {
        console.log(line);
      }
    } else if (sub === 'status') {
      const status = await serviceStatus(label);
      const panes = status.manager === 'launchd' ? await hostPermissionPanes() : { screen: '', control: '' };
      console.log(values.json ? JSON.stringify(status) : statusLines(status, panes).join('\n'));
    } else if (sub === 'update') {
      if ((values.release === undefined) === (values.from === undefined)) {
        fail(`service update takes exactly one of --release <version> or --from <dir>.\n${USAGE}`);
      }
      const releaseProblem = values.release === undefined ? null : validateRelease(values.release);
      if (releaseProblem) fail(releaseProblem);
      const from = values.from === undefined ? null : resolve(values.from);
      if (from !== null && !statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`--from takes a directory of .tgz packages, got ${values.from}.`);
      }
      const source = from === null ? { release: values.release! } : { from };
      for (const line of await updateService(label, source, (progress) => console.log(progress))) console.log(line);
    } else if (sub === 'rollback') {
      for (const line of await rollbackService(label, (progress) => console.log(progress))) console.log(line);
    } else {
      for (const line of await uninstallService(label)) console.log(line);
    }
  } catch (error) {
    if (error instanceof ServiceError) fail(error.message);
    throw error;
  }
}

async function setup(): Promise<void> {
  if (process.argv.slice(3).some((arg) => arg === '--help' || arg === '-h')) return void console.log(USAGE);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const ticket = process.env.STIM_SETUP_TICKET;
  delete process.env.STIM_SETUP_TICKET;
  try {
    process.exitCode = await runSetup(process.argv.slice(3), pkg.version, {
      ...defaultSetupDeps(),
      ticket,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  if (controller.signal.aborted) process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'setup') return setup();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'loopback-only': { type: 'boolean' },
      json: { type: 'boolean' },
      control: { type: 'boolean' },
      read: { type: 'boolean' },
      build: { type: 'boolean' },
      'device-host': { type: 'boolean' },
      label: { type: 'string' },
      serve: { type: 'boolean' },
      env: { type: 'string', multiple: true },
      'path-prepend': { type: 'string', multiple: true },
      release: { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(pkg.version);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, got ${values.port}.`);
  const [command, sub, arg, ...rest] = positionals;
  const extraEnv = values.env ?? [];
  const pathPrepend = values['path-prepend'] ?? [];
  const service = command === 'service';
  if ((values.env || values['path-prepend']) && command !== undefined && !service) {
    fail(`--env and --path-prepend apply only to serving and \`service install\`.\n${USAGE}`);
  }
  if (values.env || values['path-prepend']) {
    const problem = validateServeEnvironment(extraEnv, pathPrepend, command === undefined);
    if (problem) fail(problem);
  }
  if ((values.label !== undefined || values.serve) && !service) {
    fail(`--label and --serve apply only to \`service\`.\n${USAGE}`);
  }
  if ((values.release !== undefined || values.from !== undefined) && !service) {
    fail(`--release and --from apply only to \`service update\`.\n${USAGE}`);
  }
  if (values['loopback-only'] && command !== undefined) {
    fail(`--loopback-only applies only to serving.\n${USAGE}`);
  }
  if (command === undefined) return serve(port, extraEnv, pathPrepend, values['loopback-only'] === true);
  const grant = command === 'devices' && sub === 'grant';
  if (values.read && !grant) fail(`--read applies only to \`devices grant\`.\n${USAGE}`);
  if (values.build && !grant) fail(`--build applies only to \`devices grant\`.\n${USAGE}`);
  if (values['device-host'] && !grant) fail(`--device-host applies only to \`devices grant\`.\n${USAGE}`);
  if (values.control && !grant && command !== 'pair') {
    fail(`--control applies only to \`pair\` and \`devices grant\`.\n${USAGE}`);
  }
  if (service) return runService(sub, arg, values, extraEnv, pathPrepend);
  const scope = scopeFlag(values);
  if (command === 'pair' && sub === undefined) return pair(port, values.json === true, values.control === true);
  if (grant && arg !== undefined && rest.length === 0) {
    if (scope === null || scope === 'many')
      fail('devices grant takes exactly one of --control, --read, --build or --device-host.');
    if (scope === 'device-host' && process.platform !== 'darwin')
      fail('Hosting simulators needs a Mac. This machine takes build requests only; approve them with --build.');
    const capabilities = scope === 'build' || scope === 'device-host' ? [scope] : capabilitiesFor(scope === 'control');
    const outcome = grantDevice(arg, [...capabilities]);
    if (outcome === 'ambiguous') fail(ambiguousGrant(arg));
    if (outcome === 'unknown') {
      fail(
        `no paired device ${arg}, and no pending access request with that id (requests lapse after 15 minutes). Run \`stim-server devices\` to list them.`,
      );
    }
    if (outcome === 'build-mismatch' || outcome === 'device-host-mismatch') {
      const requested = outcome === 'build-mismatch' ? 'build' : 'device-host';
      fail(
        scope === requested
          ? `${arg} is a paired device, not a machine that asked for ${requested} access.`
          : `${arg} is a ${requested} client; it takes only --${requested}. Revoke it with \`stim-server devices revoke ${arg}\`.`,
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
    const clients = readDeviceHostClients();
    const devices = [...readDevices(), ...readBuildClients(), ...clients];
    let hostedSessions: ReturnType<typeof readHostedSessionRows> = [];
    try {
      hostedSessions = readHostedSessionRows(readHostedSessions(), clients);
    } catch (error) {
      console.error(`Could not read hosted sessions: ${(error as Error).message}`);
    }
    if (values.json) {
      const listed = devices.map(
        ({
          id,
          name,
          identity,
          pairedAt,
          lastSeenAt,
          capabilities,
          pendingUntil,
          requestedCapability,
          setupTicketHash,
        }) => ({
          id,
          name,
          identity,
          pairedAt,
          lastSeenAt,
          capabilities,
          ...(pendingUntil ? { pendingUntil, setupTicket: setupTicketHash !== undefined } : {}),
          ...(requestedCapability ? { requestedCapability } : {}),
        }),
      );
      return void console.log(JSON.stringify({ devices: listed, hostedSessions }));
    }
    if (!devices.length) console.log('No paired devices.');
    for (const device of devices) console.log(describe(device));
    for (const line of formatHostedSessions(hostedSessions)) console.log(line);
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
