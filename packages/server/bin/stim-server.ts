#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bundledStim, loginShellEnvironment } from '../src/environment.ts';
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
import { startServer } from '../src/server.ts';
import { watchTailscale } from '../src/tailscale-monitor.ts';
import {
  findTailscale,
  serveCommand,
  serveRoute,
  tailnetEndpoint,
  tailscaleStatus,
  type ServeRoute,
  type TailscaleState,
} from '../src/tailscale.ts';

const USAGE = `Usage:
  stim-server [--port <n>] [--env KEY=VALUE]... [--path-prepend <dir>]...
                                    serve paired clients (default port ${DEFAULT_PORT});
                                    --env and --path-prepend apply after the login shell's environment
  stim-server service install [--port <n>] [--label <name>] [--serve]
                              [--env KEY=VALUE]... [--path-prepend <dir>]...
                                    run stim-server as a macOS LaunchAgent that starts at login;
                                    --serve adds a tailnet-only \`tailscale serve\` route
  stim-server service status [--label <name>] [--json]
  stim-server service update [--label <name>] --release <version>|--from <dir>
                                    install that stim-server release from npm, or the .tgz
                                    packages in <dir>, beside the current one, switch the
                                    LaunchAgent to it, and switch back if it does not answer
  stim-server service rollback [--label <name>]
                                    switch the LaunchAgent back to the server it ran before
  stim-server service uninstall [--label <name>]
                                    remove the LaunchAgent (and the route install created)
  stim-server pair [--port <n>] [--control] [--json]
                                    print a single-use pairing payload for the QR code;
                                    --control lets the paired device run actions
  stim-server devices [list] [--json]
                                    list paired devices, approved clients and access requests
  stim-server devices grant <id> --control|--read|--build|--device-host
                                    let a paired device run actions, or only read;
                                    --build approves a Mac's request to build here;
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

async function serve(port: number, extraEnv: string[], pathPrepend: string[]): Promise<void> {
  const captureHost = hostFromExecutable(process.env.STIM_HOST_EXECUTABLE);
  const login = loginShellEnvironment();
  if (!login) console.error('stim-server: could not read the login shell environment; using this process environment.');
  const env = applyServeEnvironment(login ?? process.env, extraEnv, pathPrepend);
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (!process.env.STIM_HOME && env.STIM_HOME) process.env.STIM_HOME = env.STIM_HOME;
  if (process.env.STIM_HOME) env.STIM_HOME = process.env.STIM_HOME;

  const launchdLabel = process.env.XPC_SERVICE_NAME;
  const tailscaleBinary = findTailscale(env);
  const tailscale = tailscaleStatus(tailscaleBinary, env);
  const stim = bundledStim();
  const monitor = watchTailscale({ env, initial: { binary: tailscaleBinary, state: tailscale } });
  let server;
  try {
    server = await startServer({
      name: macName(tailscale),
      host: captureHost,
      hosts: ['127.0.0.1'],
      port,
      stimCli: stim.cli,
      stimVersion: stim.version,
      serverVersion: pkg.version,
      env,
      tailscale: tailscaleBinary,
      tailscaleState: tailscale,
      tailscaleMonitor: monitor,
      service: {
        label: launchdLabel && !validateLabel(launchdLabel) ? launchdLabel : null,
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
  const announce = async (binary: string | null, state: TailscaleState) => {
    let note = tailscaleNote(state);
    if (state.state === 'running' && state.dnsName) {
      const route = await serveRoute(binary, env, port, state.ips);
      if (route.state !== 'funneled') console.log(`tailnet endpoint: ${tailnetEndpoint(state.dnsName, route.port)}`);
      note = routeNote(route, port);
      if (route.state === 'funneled') note = `${note} Pairing is refused until then.`;
    }
    if (note) console.error(note);
  };
  await announce(tailscaleBinary, tailscale);
  monitor.onChange((snapshot, previous) => {
    const { state } = snapshot;
    if (state.state === 'running') console.log('Tailscale is running.');
    else if (previous.state.state === 'running') console.error('Tailscale stopped.');
    if (state.state === 'running' || previous.state.state === 'running') void announce(snapshot.binary, state);
  });
  const shutdown = () => {
    monitor.stop();
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
  build: 'run its project code on this Mac to build',
  'device-host': 'request session-owned device hosting on this Mac',
};

async function pair(port: number, json: boolean, control: boolean): Promise<void> {
  const binary = findTailscale(process.env);
  const tailscale = tailscaleStatus(binary, process.env);
  let endpoint = `ws://127.0.0.1:${port}`;
  let note = tailscaleNote(tailscale);
  if (note) note = `${note} The endpoint above only works on this Mac.`;
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

function describe(device: PairedDevice): string {
  const from =
    device.identity.kind === 'local'
      ? 'this Mac'
      : `${device.identity.nodeName || device.identity.nodeId}${device.identity.user ? ` (${device.identity.user})` : ''}`;
  if (device.pendingUntil !== undefined) {
    return `${device.id}  ${device.name}  pending ${device.requestedCapability ?? 'build'}  from ${from}  requested ${device.pairedAt}  lapses ${device.pendingUntil}`;
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
      console.log(values.json ? JSON.stringify(status) : statusLines(status, await hostPermissionPanes()).join('\n'));
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
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
    const problem = validateServeEnvironment(extraEnv, pathPrepend);
    if (problem) fail(problem);
  }
  if ((values.label !== undefined || values.serve) && !service) {
    fail(`--label and --serve apply only to \`service\`.\n${USAGE}`);
  }
  if ((values.release !== undefined || values.from !== undefined) && !service) {
    fail(`--release and --from apply only to \`service update\`.\n${USAGE}`);
  }
  if (command === undefined) return serve(port, extraEnv, pathPrepend);
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
    const capabilities = scope === 'build' || scope === 'device-host' ? [scope] : capabilitiesFor(scope === 'control');
    const outcome = grantDevice(arg, [...capabilities]);
    if (outcome === 'unknown') {
      fail(
        `no paired device ${arg}, and no pending access request with that id (requests lapse after 15 minutes). Run \`stim-server devices\` to list them.`,
      );
    }
    if (outcome === 'build-mismatch' || outcome === 'device-host-mismatch') {
      const requested = outcome === 'build-mismatch' ? 'build' : 'device-host';
      fail(
        scope === requested
          ? `${arg} is a paired device, not a Mac that asked for ${requested} access.`
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
    const devices = [...readDevices(), ...readBuildClients(), ...readDeviceHostClients()];
    if (values.json) {
      const listed = devices.map(
        ({ id, name, identity, pairedAt, lastSeenAt, capabilities, pendingUntil, requestedCapability }) => ({
          id,
          name,
          identity,
          pairedAt,
          lastSeenAt,
          capabilities,
          ...(pendingUntil ? { pendingUntil } : {}),
          ...(requestedCapability ? { requestedCapability } : {}),
        }),
      );
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
