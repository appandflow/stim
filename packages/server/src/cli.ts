import { realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readHostedSessions } from '@stim-cli/core/state';
import { configDir } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { discoverToolchain } from '@stim-cli/core/toolchain';
import { bundledStim } from './environment.ts';
import { formatHostedSessions, readHostedSessionRows } from './hosted-sessions.ts';
import { readAudit } from './actions.ts';
import {
  installService,
  rollbackService,
  serviceStatus,
  statusLines,
  uninstallService,
  updateService,
} from './service.ts';
import {
  applyServeEnvironment,
  DEFAULT_LABEL,
  DEFAULT_PORT,
  ServiceError,
  validateLabel,
  validatePort,
  validateRelease,
} from './service-plist.ts';
import { PROTOCOL_VERSION, type Capability } from './protocol.ts';
import { serviceManagerOrNull } from './service-manager.ts';
import {
  capabilitiesFor,
  createPairingToken,
  grantDevice,
  isDesktopClient,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  readUnreadable,
  renameDevice,
  revokeDevice,
  serverIdentity,
  type PairedDevice,
  type UnreadableRecord,
} from './registry.ts';
import { keyFingerprint } from '@stim-cli/core/noise-session';
import { hostFromExecutable, hostPermissionPanes } from './stim-host.ts';
import { defaultSetupDeps, runSetup } from './setup.ts';
import { startServer } from './server.ts';
import { readDesktopBootstrap, watchLauncherLifetime } from './desktop-bootstrap.ts';
import type { ServeRoute } from '@stim-cli/core/protocol';
import { loadTransport } from '@stim-cli/transport';
import { localTransport, resolveLanAddresses } from '@stim-cli/transport-local';
import { readLanAddresses, watchServerSettings } from './lan.ts';
import {
  findTailscale,
  serveCommand,
  serveRoute,
  tailnetEndpoint,
  readTailscaleStatus,
  isTailscaleTransport,
  type TailscaleState,
} from '@stim-cli/transport-tailscale';

const pkg = { version: bundledStim().version };

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
    return `No \`tailscale serve\` route reaches port ${port}, so clients connect to this machine's tailnet address directly. For a wss:// endpoint with a certificate, run this once to serve it on a tailnet-only port: \`${serveCommand(route.port, port)}\``;
  }
  if (route.state === 'unknown') {
    return `Could not read \`tailscale serve status --json\` (${route.reason}), so clients connect to this machine's tailnet address directly.`;
  }
  if (route.state === 'funneled') {
    const ports = route.ports.join(', ');
    return `Tailscale Funnel is on for port ${ports}, which proxies to stim-server, so the server is reachable from the public internet. Remove that handler (see \`tailscale serve status\`), then serve stim-server on a tailnet-only port: \`${serveCommand(route.port, port)}\``;
  }
  return null;
}

function pairingEndpoint(ips: string[], dnsName: string, route: ServeRoute, port: number) {
  const ip = ips.find((address) => !address.includes(':')) ?? ips[0];
  if ((route.state === 'missing' || route.state === 'unknown') && ip)
    return `ws://${ip.includes(':') ? `[${ip}]` : ip}:${port}`;
  return tailnetEndpoint(dnsName, route.port);
}

function macName(tailscale: TailscaleState): string {
  return (tailscale.state === 'running' && tailscale.hostName) || hostname();
}

export async function serve(
  port: number,
  extraEnv: string[],
  pathPrepend: string[],
  loopbackOnly: boolean,
  shareOnly = false,
): Promise<void> {
  const bootstrapFd = process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  const lifetimeFd = process.env.STIM_DESKTOP_LIFETIME_FD;
  delete process.env.STIM_DESKTOP_BOOTSTRAP_FD;
  delete process.env.STIM_DESKTOP_LIFETIME_FD;
  if (lifetimeFd !== undefined && lifetimeFd !== '0') fail('Desktop lifetime input is invalid or unavailable.');
  if (bootstrapFd !== undefined && bootstrapFd !== '0') fail('Desktop bootstrap input is invalid or unavailable.');
  const desktopInput =
    bootstrapFd === '0'
      ? await readDesktopBootstrap(process.stdin).catch(() =>
          fail('Desktop bootstrap input is invalid or unavailable.'),
        )
      : undefined;
  delete process.env.NODE_COMPILE_CACHE;
  const captureHost = hostFromExecutable(process.env.STIM_HOST_EXECUTABLE);
  const inherited = { ...process.env };
  const serveEnvironment = (warn?: (line: string) => void) => {
    const found = applyServeEnvironment(discoverToolchain(inherited).env, extraEnv, pathPrepend, process.env, warn);
    delete found.CLAUDE_CODE_SESSION_ID;
    delete found.CODEX_THREAD_ID;
    return found;
  };
  const env = serveEnvironment();
  if (!process.env.STIM_HOME && env.STIM_HOME) process.env.STIM_HOME = env.STIM_HOME;
  if (process.env.STIM_HOME) env.STIM_HOME = process.env.STIM_HOME;
  Object.assign(process.env, env);
  const currentEnv = () => ({ ...serveEnvironment(() => {}), ...(env.STIM_HOME ? { STIM_HOME: env.STIM_HOME } : {}) });

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
  const lanSetting = watchServerSettings();
  await Promise.race([lanSetting.ready, new Promise((done) => setTimeout(done, 1000).unref())]);
  const lan = localTransport({ entries: lanSetting.current });
  const stim = bundledStim();
  let shareClaim: ClaimHandle | null = null;
  if (shareOnly) {
    let attempt;
    try {
      attempt = tryAcquireClaim({
        root: join(configDir(), 'server', 'share-server'),
        mode: 'exclusive',
        label: 'web share server',
        details: { port },
      });
    } catch (error) {
      fail(
        `cannot record this server as the one stim share started: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      fail(`a stim-server started for web shares already runs (pid ${attempt.held?.owner.pid ?? 'unknown'}).`);
    shareClaim = attempt.acquired;
  }
  let idle: (() => void) | null = null;
  let server;
  try {
    server = await startServer({
      desktopBootstrap: desktopInput?.bootstrap,
      name: macName(tailscale),
      host: captureHost,
      hosts: ['127.0.0.1'],
      ...(loopbackOnly ? { loopbackOnly: true } : {}),
      ...(shareOnly ? { shareServer: { idle: () => idle?.() } } : {}),
      port,
      stimCli: join(dirname(stim.cli), '../dist/cli.mjs'),
      stimVersion: stim.version,
      serverVersion: pkg.version,
      env,
      currentEnv,
      transports: [transport, lan],
      keepAwake: { setting: lanSetting.keepAwake, onChange: lanSetting.onKeepAwakeChange },
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
      if (route.state !== 'funneled')
        console.log(`tailnet endpoint: ${pairingEndpoint(state.ips, state.dnsName, route, port)}`);
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
  let lanProblems = '';
  const announceLan = () => {
    const { addresses, problems } = lan.lan();
    const next = problems.join('\n');
    if (next !== lanProblems && problems.length)
      for (const problem of problems) console.error(`stim-server: server.lanAddresses: ${problem}.`);
    lanProblems = next;
    if (addresses.length)
      console.log(`local network endpoints: ${addresses.map((host) => `ws://${host}:${port}`).join(', ')}`);
  };
  const stopLan = loopbackOnly ? () => {} : lan.watch(announceLan);
  if (!loopbackOnly) announceLan();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopLan();
    lanSetting.stop();
    lan.close?.();
    transport.close?.();
    void server
      .close()
      .catch((error: unknown) => {
        reportShutdownFailure(error);
        process.exitCode = 1;
      })
      .finally(() => {
        releaseClaim(shareClaim);
        process.exit();
      });
  };
  idle = () => {
    console.log('stim-server: no web share is left; stopping.');
    shutdown();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  const launcherClosed =
    desktopInput?.closed ?? (lifetimeFd === '0' ? watchLauncherLifetime(process.stdin) : undefined);
  void launcherClosed?.then(shutdown);
  if (shareOnly) {
    const startup = await server.ready;
    if (startup.state !== 'ready') {
      console.error(
        `stim-server: not serving web shares, because ${startup.state === 'degraded' ? startup.reason : 'it did not start'}; stopping.`,
      );
      process.exitCode = 1;
      shutdown();
    }
  }
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

export async function pair(port: number, json: boolean, control: boolean): Promise<void> {
  const binary = findTailscale(process.env);
  const tailscale = await readTailscaleStatus(binary, process.env);
  const [lan] = resolveLanAddresses(await readLanAddresses(), networkInterfaces()).addresses;
  let endpoint = `ws://${lan ?? '127.0.0.1'}:${port}`;
  let note = tailscaleNote(tailscale);
  if (note)
    note = `${note} The endpoint above only works ${lan ? 'on this local network, while stim-server listens there (server.lanAddresses)' : 'on this machine'}.`;
  if (tailscale.state === 'running' && tailscale.dnsName) {
    const route = await serveRoute(binary, process.env, port, tailscale.ips);
    if (route.state === 'funneled') fail(`refusing to pair. ${routeNote(route, port)}`);
    endpoint = pairingEndpoint(tailscale.ips, tailscale.dnsName, route, port);
    note = routeNote(route, port);
  }
  const { token, expiresAt } = createPairingToken(Date.now(), capabilitiesFor(control));
  const fingerprint = keyFingerprint(serverIdentity().publicKey);
  const payload = { v: 2, name: macName(tailscale), endpoint, pairingToken: token, fingerprint };
  console.log(JSON.stringify(json ? { qr: payload, expiresAt } : payload));
  console.error(
    `The pairing token is single use and expires at ${expiresAt}. The device it pairs can ${control ? 'run actions' : 'only read'}.`,
  );
  if (note) console.error(note);
}

function describe(device: PairedDevice): string {
  const from = `${device.from ?? 'unknown'}, key ${keyFingerprint(Buffer.from(device.publicKey, 'base64url')).slice(0, 12)}`;
  const scope = device.capabilities.includes('device-host')
    ? 'device-host'
    : device.capabilities.includes('build')
      ? 'build'
      : device.capabilities.includes('control')
        ? 'control'
        : 'read';
  return `${device.id}  ${device.name}  ${scope}  from ${from}  paired ${device.pairedAt}  last seen ${device.lastSeenAt ?? 'never'}`;
}

function describeUnreadable({ file, index, id, version }: UnreadableRecord): string {
  if (version !== undefined)
    return `unreadable  ${file} registry version ${version}, written by a newer Stim  left as it is`;
  return `unreadable  ${file} entry ${index}${id ? `  ${id}` : ''}  left as it is`;
}

const KINDS = { device: 'phone', build: 'build-client', 'device-host': 'device-host-client' } as const;

const ACCESS: Record<Capability, string> = {
  read: 'view',
  control: 'control',
  build: 'build',
  'device-host': 'run-devices',
};

function listed(device: PairedDevice, registry: keyof typeof KINDS) {
  const { id, name, from, publicKey, pairedAt, lastSeenAt, capabilities, clientApp, clientVersion } = device;
  return {
    id,
    name,
    ...(from ? { from } : {}),
    keyFingerprint: keyFingerprint(Buffer.from(publicKey, 'base64url')),
    pairedAt,
    lastSeenAt,
    capabilities,
    ...(clientApp ? { clientApp } : {}),
    ...(clientVersion ? { clientVersion } : {}),
    kind: registry === 'device' && isDesktopClient(device) ? 'desktop' : KINDS[registry],
    access: capabilities.map((capability) => ACCESS[capability]),
    owner: registry === 'device' ? 'this-machine' : 'theirs-running-here',
  };
}

function refuseUnreadable(id: string): void {
  const unreadable = readUnreadable();
  const entry = unreadable.find((each) => each.id === id);
  if (entry) {
    fail(
      `${id} is an entry of ${entry.file} that this stim-server cannot read, so it is left as it is. Edit that file to change or remove it.`,
    );
  }
  const whole = unreadable.filter((each) => each.version !== undefined);
  if (whole.length) {
    fail(
      `no paired device or approved client ${id} that this stim-server can read. ${whole.map((each) => `${each.file} is registry version ${each.version}, written by a newer Stim`).join('; ')}, and is left as it is.`,
    );
  }
}

export function rename(id: string, name: string): void {
  const outcome = renameDevice(id, name);
  if (outcome === 'unknown') {
    refuseUnreadable(id);
    fail(`no paired device or approved client ${id}. Run \`stim-server devices\` to list them.`);
  }
  if (outcome === 'invalid-name') fail('the name must be 1 to 64 characters of printable text on one line.');
  console.log(`Renamed ${id}.`);
}

export async function runService(
  sub: string,
  values: {
    label?: string;
    serve?: boolean;
    json?: boolean;
    port?: string;
    env?: string[];
    'path-prepend'?: string[];
    release?: string;
    from?: string;
    'no-wait'?: boolean;
  },
  env: string[],
  pathPrepend: string[],
): Promise<void> {
  const label = values.label ?? DEFAULT_LABEL;
  const labelProblem = validateLabel(label);
  if (labelProblem) fail(labelProblem);
  try {
    if (sub === 'install') {
      const installPort = values.port === undefined ? DEFAULT_PORT : validatePort(values.port);
      if (typeof installPort === 'string') fail(installPort);
      const explicit =
        values.label !== undefined || values.port !== undefined || values.serve || env.length || pathPrepend.length;
      for (const line of await installService(
        explicit
          ? {
              label,
              port: installPort,
              env,
              pathPrepend,
              serve: values.serve === true,
            }
          : undefined,
      )) {
        console.log(line);
      }
    } else if (sub === 'status') {
      const status = await serviceStatus(label);
      const panes = status.manager === 'launchd' ? await hostPermissionPanes() : { screen: '', control: '' };
      console.log(values.json ? JSON.stringify(status) : statusLines(status, panes).join('\n'));
    } else if (sub === 'update') {
      if ((values.release === undefined) === (values.from === undefined)) {
        fail(`service update takes exactly one of --release <version> or --from <dir>.`);
      }
      const releaseProblem = values.release === undefined ? null : validateRelease(values.release);
      if (releaseProblem) fail(releaseProblem);
      const from = values.from === undefined ? null : resolve(values.from);
      if (from !== null && !statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`--from takes a directory of .tgz packages, got ${values.from}.`);
      }
      const source = from === null ? { release: values.release! } : { from };
      for (const line of await updateService(label, source, (progress) => console.log(progress), !values['no-wait']))
        console.log(line);
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

export async function setup(args: string[]): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const ticket = process.env.STIM_SETUP_TICKET;
  const fromDoctor = process.env.STIM_SETUP_ORIGIN === 'doctor';
  delete process.env.STIM_SETUP_TICKET;
  delete process.env.STIM_SETUP_ORIGIN;
  try {
    process.exitCode = await runSetup(args, pkg.version, {
      ...defaultSetupDeps(),
      ticket,
      fromDoctor,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
  if (controller.signal.aborted) process.exit(1);
}

export function grant(id: string, values: { read?: boolean; control?: boolean }): void {
  if (Boolean(values.read) === Boolean(values.control)) fail('devices grant takes exactly one of --control or --read.');
  const scope = values.control ? 'control' : 'read';
  const capabilities = capabilitiesFor(scope === 'control');
  const outcome = grantDevice(id, [...capabilities]);
  if (outcome === 'unknown') {
    refuseUnreadable(id);
    fail(`no paired device or approved client ${id}. Run \`stim-server devices\` to list them.`);
  }
  if (outcome === 'build-mismatch' || outcome === 'device-host-mismatch') {
    const requested = outcome === 'build-mismatch' ? 'build' : 'device-host';
    fail(`${id} is a ${requested} client, approved by setup; revoke it with \`stim-server devices revoke ${id}\`.`);
  }
  console.log(`${id} can now ${SCOPE_TEXT[scope]}.`);
}

export function logActions(json: boolean): void {
  const records = readAudit();
  if (json) return void console.log(JSON.stringify({ actions: records }));
  if (!records.length) console.log('No actions.');
  for (const record of records) {
    const outcome = record.ok
      ? `ok${record.reason ? ` (${record.reason})` : ''}`
      : `${record.error?.code ?? 'failed'}: ${record.error?.message ?? ''}`;
    const line = `${record.at}  ${record.device.id} (${record.device.name})  ${record.action}  ${record.workspace}  ${outcome}`;
    console.log(Array.from(line, (char) => (/\p{Cc}/u.test(char) ? '?' : char)).join(''));
  }
}

export function listPairings(json: boolean): void {
  const clients = readDeviceHostClients();
  const sources = [
    ...readDevices().map((device) => [device, 'device'] as const),
    ...readBuildClients().map((device) => [device, 'build'] as const),
    ...clients.map((device) => [device, 'device-host'] as const),
  ];
  const devices = sources.map(([device]) => device);
  let hostedSessions: ReturnType<typeof readHostedSessionRows> = [];
  try {
    hostedSessions = readHostedSessionRows(readHostedSessions(), clients);
  } catch (error) {
    console.error(`Could not read hosted sessions: ${(error as Error).message}`);
  }
  const unreadable = readUnreadable();
  if (json) {
    const rows = sources.map(([device, registry]) => listed(device, registry));
    return void console.log(JSON.stringify({ devices: rows, hostedSessions, unreadable }));
  }
  if (!devices.length) console.log('No paired devices.');
  for (const device of devices) console.log(describe(device));
  for (const entry of unreadable) console.log(describeUnreadable(entry));
  for (const line of formatHostedSessions(hostedSessions)) console.log(line);
}

export function revoke(id: string): void {
  if (!revokeDevice(id)) {
    refuseUnreadable(id);
    fail(`no paired device ${id}. Run \`stim-server devices\` to list them.`);
  }
  console.log(`Revoked ${id}.`);
}
