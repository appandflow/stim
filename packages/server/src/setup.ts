import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { claimRemoveCommand, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { isJsonObject, stimBuildDigest, type SetupCapability, type SetupJournal } from '@stim-cli/core/state';
import type { BuildToolchain } from '@stim-cli/core/protocol';
import { BuildHost } from './build.ts';
import { bundledStim, loginShellEnvironment } from './environment.ts';
import { grantDevice, readBuildClients, readDeviceHostClients, serverDir, type PairedDevice } from './registry.ts';
import {
  fetchHealth,
  holdingUpdateClaim,
  installJob,
  installServer,
  prepareRoute,
  recordServiceRoute,
  requireManaged,
  run,
  serverBuild,
  serviceRoot,
  stableNode,
  updateInstalledService,
} from './service.ts';
import {
  applyServeEnvironment,
  DEFAULT_LABEL,
  DEFAULT_PORT,
  planServe,
  ServiceError,
  validateLabel,
  validatePort,
  validateServeEnvironment,
  type InstalledService,
  type ServerBuild,
} from './service-plist.ts';
import { pruneSetupJournals, writeSetupJournal } from './setup-journal.ts';
import {
  hostPermissionPanes,
  installHostApp,
  readHostPermissions,
  requestHostPermissions,
  type HostApp,
} from './stim-host.ts';
import { findTailscale, readRawTailscaleStatus, serveRoute, type ServeRoute } from './tailscale.ts';

const SETUP_MIN_VERSION = '1.16.0';

export interface SetupOptions {
  nodeId: string;
  ticketHash: string;
  expiresAt: string;
  capabilities: SetupCapability[];
  label: string;
  port: number;
  env: string[];
  pathPrepend: string[];
  yes: boolean;
  json: boolean;
}

class SetupRefusal extends Error {
  readonly expired: boolean;
  readonly fix?: string;
  constructor(message: string, expired = false, fix?: string) {
    super(message);
    this.expired = expired;
    this.fix = fix;
  }
}

export function parseSetupArgs(args: string[], now: number): SetupOptions {
  const { values } = parseArgs({
    args,
    options: {
      client: { type: 'string' },
      ticket: { type: 'string' },
      expires: { type: 'string' },
      build: { type: 'boolean' },
      'device-host': { type: 'boolean' },
      port: { type: 'string' },
      label: { type: 'string' },
      env: { type: 'string', multiple: true },
      'path-prepend': { type: 'string', multiple: true },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  if (!values.client?.trim()) throw new SetupRefusal('--client takes a tailnet node id.');
  if (!values.ticket || !/^[A-Za-z0-9_-]{43}$/.test(values.ticket))
    throw new SetupRefusal('--ticket takes 43 base64url characters.');
  const capabilities = (['build', 'device-host'] as const).filter((cap) => values[cap]);
  if (!capabilities.length) throw new SetupRefusal('setup needs --build or --device-host.');
  const expires = values.expires;
  const until = Date.parse(expires ?? '');
  if (
    !expires ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expires) ||
    !Number.isFinite(until) ||
    new Date(expires.slice(0, 10)).toISOString().slice(0, 10) !== expires.slice(0, 10)
  ) {
    throw new SetupRefusal('--expires takes an ISO timestamp with a timezone.');
  }
  if (until <= now) throw new SetupRefusal('This setup ticket expired. Generate a new command.', true);
  if (until > now + 2 * 60 * 60_000) throw new SetupRefusal('--expires must be at most 2 hours ahead.');
  const port = validatePort(values.port ?? String(DEFAULT_PORT));
  if (typeof port === 'string') throw new SetupRefusal(port);
  const label = values.label ?? DEFAULT_LABEL;
  const env = values.env ?? [];
  const pathPrepend = values['path-prepend'] ?? [];
  const problem = validateLabel(label) ?? validateServeEnvironment(env, pathPrepend);
  if (problem) throw new SetupRefusal(problem);
  return {
    nodeId: values.client.trim(),
    ticketHash: createHash('sha256').update(values.ticket).digest('hex'),
    expiresAt: expires,
    capabilities,
    label,
    port,
    env,
    pathPrepend,
    yes: values.yes === true,
    json: values.json === true,
  };
}

export function selectGrants(
  records: PairedDevice[],
  match: {
    nodeId: string;
    ticketHash: string;
    capabilities: SetupCapability[];
    now: number;
  },
): { capability: SetupCapability; record: PairedDevice; approved: boolean }[] {
  return match.capabilities.flatMap((capability) => {
    const candidates = records.filter(
      (r) =>
        r.requestedCapability === capability &&
        r.identity.kind === 'tailnet' &&
        r.identity.nodeId === match.nodeId &&
        r.setupTicketHash === match.ticketHash &&
        (r.pendingUntil === undefined ? r.capabilities.includes(capability) : Date.parse(r.pendingUntil) > match.now),
    );
    const approved = candidates.filter((r) => r.pendingUntil === undefined);
    if (approved.length > 1 || (approved.length === 0 && candidates.length > 1)) {
      throw new SetupRefusal(
        `More than one ${capability} request matches this ticket; refusing to choose. Revoke the extra request and rerun.`,
      );
    }
    const record = approved[0] ?? candidates[0];
    return record ? [{ capability, record, approved: record.pendingUntil === undefined }] : [];
  });
}

const parseVersion = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v);

function compareVersions(a: string, b: string): number {
  const aa = parseVersion(a),
    bb = parseVersion(b);
  if (!aa || !bb) throw new SetupRefusal(`Cannot compare stim-server versions ${a} and ${b}.`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(aa[i]) - Number(bb[i]);
    if (diff) return diff;
  }
  if (!aa[4] || !bb[4]) return aa[4] ? -1 : bb[4] ? 1 : 0;
  const ap = aa[4].split('.'),
    bp = bb[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i],
      y = bp[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function setupVersionDecision(
  current: string | null,
  desired: string,
  managed: boolean,
): 'install' | 'update' | 'reuse' | 'too-old' {
  if (current === null) return 'install';
  if (managed && compareVersions(current, desired) < 0) return 'update';
  return compareVersions(current.replace(/-.*/, ''), SETUP_MIN_VERSION) < 0 ? 'too-old' : 'reuse';
}

export function setupExitCode(journal: SetupJournal): number {
  if (journal.steps.some((s) => s.state === 'failed')) return 1;
  if (journal.granted.length === 0) return 2;
  if (
    journal.capabilities.some((c) => !journal.granted.some((g) => g.capability === c)) ||
    journal.steps.some((s) => s.state === 'pending' || s.state === 'running' || s.state === 'skipped')
  )
    return 3;
  return 0;
}

type PermissionState = 'granted' | 'denied' | 'skipped' | 'not-needed';
type Tool = { tool: string; state: 'present' | 'missing' | 'not-needed'; detail: string; fix: string };
interface SetupOutput {
  ok: boolean;
  label: string;
  port: number;
  route: { state: string; dnsName: string | null; port: number };
  server: ServerBuild;
  managed: boolean;
  granted: { capability: SetupCapability; id: string; client: { nodeId: string; name: string } }[];
  permissions: { screenRecording: PermissionState; deviceControl: PermissionState };
  tools: Tool[];
  warnings: string[];
}

export interface SetupDeps {
  signal?: AbortSignal;
  now(): number;
  sleep(ms: number): Promise<void>;
  tty: boolean;
  stdout(line: string): void;
  stderr(line: string): void;
  confirm(question: string, timeoutMs: number): Promise<boolean>;
  permissionWait(ms: number): Promise<boolean>;
  preflight(options: SetupOptions): Promise<{ dnsName: string }>;
  claim(): () => void;
  write: typeof writeSetupJournal;
  prune: typeof pruneSetupJournals;
  withInstallClaim<T>(label: string, work: () => Promise<T>): Promise<T>;
  installed(label: string): Promise<InstalledService | null>;
  health: typeof fetchHealth;
  build: typeof serverBuild;
  install: typeof installServer;
  update: typeof updateInstalledService;
  installHost: typeof installHostApp;
  installJob: typeof installJob;
  route(port: number): Promise<ServeRoute>;
  prepareRoute: typeof prepareRoute;
  recordRoute: typeof recordServiceRoute;
  createRoute(args: string[]): Promise<void>;
  records(now: number): PairedDevice[];
  grant: typeof grantDevice;
  panes: typeof hostPermissionPanes;
  permissions: typeof readHostPermissions;
  requestPermissions: typeof requestHostPermissions;
  openPane(pane: string): Promise<void>;
  toolchain(options: SetupOptions): Promise<BuildToolchain | null>;
  node: string;
  versions(label: string): string;
  stimBuild: string | null;
}

export function setupClaim(): () => void {
  const root = join(serverDir(), 'setup.claims');
  const attempt = tryAcquireClaim({ root, mode: 'exclusive', label: 'stim-server setup' });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired) {
    const path = attempt.held?.path ?? root;
    throw new SetupRefusal(
      `Another setup holds ${path}. If nothing is using it, remove it with ${claimRemoveCommand(path)}.`,
    );
  }
  return () => {
    releaseClaim(attempt.acquired!);
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const binary = () => findTailscale(process.env);

async function interruptible<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.race([Promise.reject(new SetupRefusal('interrupted')), work]);
  let abort: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new SetupRefusal('interrupted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort!);
  }
}

export async function confirmSetup(input: Interface, question: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new SetupRefusal('interrupted'));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  input.on('SIGINT', interrupt);
  input.on('close', interrupt);
  try {
    return /^(y|yes)$/i.test((await input.question(question, { signal: controller.signal })).trim());
  } catch (error) {
    if (controller.signal.reason instanceof SetupRefusal) throw controller.signal.reason;
    if ((error as Error).name === 'AbortError') return false;
    throw error;
  } finally {
    clearTimeout(timer);
    input.off('SIGINT', interrupt);
    input.off('close', interrupt);
    input.close();
  }
}

export function defaultSetupDeps(): SetupDeps {
  return {
    now: Date.now,
    sleep,
    tty: process.stdin.isTTY === true,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    confirm: (question, timeoutMs) =>
      confirmSetup(createInterface({ input: process.stdin, output: process.stderr }), question, timeoutMs),
    permissionWait(ms) {
      if (!process.stdin.isTTY) return sleep(ms).then(() => false);
      return new Promise((resolve, reject) => {
        const raw = process.stdin.isRaw;
        const done = (skip: boolean, interrupted = false) => {
          clearTimeout(timer);
          process.stdin.off('data', onData);
          process.stdin.setRawMode(raw);
          process.stdin.pause();
          if (interrupted) reject(new SetupRefusal('Permission wait interrupted.'));
          else resolve(skip);
        };
        const onData = (data: Buffer) => {
          if (data.includes(3)) done(false, true);
          else if (data.toString().toLowerCase().includes('s')) done(true);
        };
        const timer = setTimeout(() => done(false), ms);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
      });
    },
    async preflight(options) {
      if (process.platform !== 'darwin') throw new SetupRefusal('setup runs only on macOS.');
      if (compareVersions(process.versions.node, '22.12.0') < 0)
        throw new SetupRefusal('setup needs Node 22.12 or later.');
      const status = await readRawTailscaleStatus(binary(), process.env);
      if (
        !isJsonObject(status) ||
        !isJsonObject(status.Self) ||
        typeof status.Self.DNSName !== 'string' ||
        !status.Self.DNSName
      ) {
        throw new SetupRefusal('Start Tailscale on this Mac: tailscale up.');
      }
      if (
        !isJsonObject(status.Peer) ||
        !Object.values(status.Peer).some((p) => isJsonObject(p) && p.ID === options.nodeId)
      ) {
        throw new SetupRefusal('That Mac is not on this tailnet');
      }
      const gui = await run('launchctl', ['print', `gui/${process.getuid?.()}`]);
      if (!gui.ok) throw new SetupRefusal('Log in to a GUI session on this Mac before running setup.');
      return { dnsName: status.Self.DNSName.replace(/\.$/, '') };
    },
    claim: setupClaim,
    write: writeSetupJournal,
    prune: pruneSetupJournals,
    withInstallClaim: holdingUpdateClaim,
    installed: requireManaged,
    health: fetchHealth,
    build: serverBuild,
    install: installServer,
    update: updateInstalledService,
    installHost: installHostApp,
    installJob,
    async route(port) {
      const raw = await readRawTailscaleStatus(binary(), process.env);
      const ips =
        isJsonObject(raw) && Array.isArray(raw.TailscaleIPs)
          ? raw.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
          : [];
      return serveRoute(binary(), process.env, port, ips);
    },
    prepareRoute,
    recordRoute: recordServiceRoute,
    async createRoute(args) {
      const result = await run(binary() ?? 'tailscale', args);
      if (!result.ok) throw new ServiceError(result.stderr.trim());
    },
    records: (now) => [...readBuildClients(now), ...readDeviceHostClients(now)],
    grant: grantDevice,
    panes: hostPermissionPanes,
    permissions: readHostPermissions,
    requestPermissions: requestHostPermissions,
    async openPane(pane) {
      const result = await run('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
      if (!result.ok) throw new ServiceError(result.stderr.trim());
    },
    async toolchain(options) {
      const env = applyServeEnvironment(loginShellEnvironment() ?? process.env, options.env, options.pathPrepend);
      const host = new BuildHost({
        worker: join(dirname(bundledStim().cli), 'offload-worker.mjs'),
        env,
        ready: () => false,
      });
      try {
        return await host.toolchain();
      } finally {
        await host.close();
      }
    },
    node: stableNode(process.env.PATH),
    versions: (label) => join(serviceRoot(label), 'versions'),
    stimBuild: stimBuildDigest(dirname(bundledStim().cli)),
  };
}

function requireApprovalMode(deps: SetupDeps, options: SetupOptions): void {
  if (deps.tty || options.yes) return;
  const approved = selectGrants(deps.records(deps.now()), { ...options, now: deps.now() }).filter((g) => g.approved);
  if (approved.length !== options.capabilities.length)
    throw new SetupRefusal('To approve requests, rerun with --yes or in a terminal.');
}

type StepWriter = (
  id: string,
  state: SetupJournal['steps'][number]['state'],
  title: string,
  detail?: string,
  fix?: string,
) => void;

async function checkPermissions(
  deps: SetupDeps,
  options: SetupOptions,
  host: HostApp,
  desktop: boolean,
  output: SetupOutput,
  report: StepWriter,
): Promise<void> {
  const wait = <T>(work: Promise<T>) => interruptible(work, deps.signal);
  const panes = await wait(deps.panes());
  for (const [key, field, title, pane, feature] of [
    ['screenRecording', 'screenRecording', panes.screen, 'Privacy_ScreenCapture', 'viewing hosted simulators'],
    ['deviceControl', 'accessibility', panes.control, 'Privacy_Accessibility', 'controlling hosted simulators'],
  ] as const) {
    const id = `permissions.${key}`;
    const read = async () =>
      desktop ? ((await wait(deps.health(options.port)))?.host ?? null) : wait(deps.permissions(host.executable));
    let permissions = await read();
    if (permissions?.[field]) {
      output.permissions[key] = 'granted';
      report(id, 'ok', title);
      continue;
    }
    report(
      id,
      'running',
      title,
      `Click Allow for ${desktop ? 'the app serving this port' : host.name}. Prompts appear on this Mac's screen. Press s in a terminal to skip.`,
    );
    if (!desktop) await wait(deps.requestPermissions(host.app));
    const start = deps.now();
    let opened = false,
      skipped = false;
    while (
      !(field === 'screenRecording' ? permissions?.screenRecording : permissions?.accessibility) &&
      (deps.tty || deps.now() - start < 5 * 60_000)
    ) {
      if (!opened && deps.now() - start >= 10_000) {
        await wait(deps.openPane(pane));
        opened = true;
      }
      if (await wait(deps.permissionWait(2000))) {
        skipped = true;
        break;
      }
      permissions = await read();
    }
    output.permissions[key] = permissions?.[field] ? 'granted' : skipped ? 'skipped' : 'denied';
    report(
      id,
      permissions?.[field] ? 'ok' : skipped ? 'skipped' : 'pending',
      title,
      permissions?.[field] ? 'Granted.' : `${skipped ? 'skipped' : 'pending'}: ${feature} will not work.`,
      `System Settings > Privacy & Security > ${title}`,
    );
  }
}

function summarizeSetup(output: SetupOutput, options: SetupOptions, log: (line: string) => void): void {
  for (const capability of options.capabilities) {
    if (!output.granted.some((g) => g.capability === capability))
      output.warnings.push(`${capability === 'build' ? 'Builds' : 'Hosted simulators'} have no approval.`);
  }
  if (options.capabilities.includes('device-host')) {
    for (const [key, feature] of [
      ['screenRecording', 'Viewing hosted simulators'],
      ['deviceControl', 'Controlling hosted simulators'],
    ] as const) {
      if (output.permissions[key] !== 'granted') output.warnings.push(`${feature} requires a macOS permission grant.`);
    }
  }
  for (const tool of output.tools)
    if (tool.state === 'missing')
      output.warnings.push(`${tool.tool}: builds or hosting requiring this tool will not work.`);
  log(
    `Summary: ${output.label}, port ${output.port}, route https ${output.route.port}; ${output.granted.length} grant(s).`,
  );
  log(`Server: ${output.server.version}; ${output.managed ? output.label : 'existing app server'}.`);
  for (const grant of output.granted) {
    log(`${grant.capability}: ${grant.client.name} (${grant.client.nodeId}), request ${grant.id}.`);
    log(`Undo: stim-server devices revoke ${grant.id}`);
  }
  log(
    `Permissions: screen recording ${output.permissions.screenRecording}; device control ${output.permissions.deviceControl}.`,
  );
  for (const tool of output.tools) log(`${tool.tool}: ${tool.state}.`);
  for (const warning of output.warnings) log(warning);
  if (output.managed) log(`Undo: stim-server service uninstall --label ${output.label}`);
}

export async function runSetup(args: string[], version: string, deps: SetupDeps): Promise<number> {
  const json = args.includes('--json');
  let options: SetupOptions | undefined;
  let journal: SetupJournal = {
    v: 1,
    client: { nodeId: 'unknown' },
    expiresAt: new Date(deps.now()).toISOString(),
    capabilities: [],
    steps: [],
    granted: [],
    done: false,
  };
  const output: SetupOutput = {
    ok: false,
    label: DEFAULT_LABEL,
    port: DEFAULT_PORT,
    route: { state: 'pending', dnsName: null, port: 7443 },
    server: { version, stimBuild: deps.stimBuild },
    managed: false,
    granted: [],
    permissions: { screenRecording: 'not-needed', deviceControl: 'not-needed' },
    tools: [],
    warnings: [],
  };
  const log = (line: string) => (json ? deps.stderr : deps.stdout)(line);
  const wait = <T>(work: Promise<T>) => interruptible(work, deps.signal);
  let release: (() => void) | undefined;
  let active = 'args';
  let writable = true;
  const save = () => {
    if (release && options && writable) {
      try {
        deps.write(options.ticketHash, journal);
      } catch (error) {
        writable = false;
        throw error;
      }
    }
  };
  const step = (
    id: string,
    state: SetupJournal['steps'][number]['state'],
    title: string,
    detail?: string,
    fix?: string,
  ) => {
    if (deps.signal?.aborted && state !== 'failed') throw new SetupRefusal('interrupted');
    active = id;
    const value = { id, state, title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
    const index = journal.steps.findIndex((s) => s.id === id);
    if (index < 0) journal.steps.push(value);
    else journal.steps[index] = value;
    save();
    log(
      `${state === 'ok' ? '[ok]' : state === 'failed' ? '[failed]' : `[${state}]`} ${title}${detail ? `: ${detail}` : ''}${fix ? `\nFix: ${fix}` : ''}`,
    );
  };
  try {
    options = parseSetupArgs(args, deps.now());
    Object.assign(output, { label: options.label, port: options.port });
    if (options.capabilities.includes('device-host'))
      output.permissions = { screenRecording: 'denied', deviceControl: 'denied' };
    journal = {
      ...journal,
      client: { nodeId: options.nodeId },
      capabilities: options.capabilities,
      expiresAt: options.expiresAt,
    };
    const preflight = await wait(deps.preflight(options));
    output.route.dnsName = preflight.dnsName;
    requireApprovalMode(deps, options);
    release = deps.claim();
    deps.prune(deps.now());
    step('preflight', 'ok', 'Preflight');
    const opts = options;
    let installed: InstalledService | null = null;
    let host: HostApp | undefined;
    let script = '';
    let desktop = false;
    await deps.withInstallClaim(opts.label, async () => {
      step('server', 'running', 'stim-server');
      installed = await wait(deps.installed(opts.label));
      if (installed && installed.port !== opts.port)
        throw new SetupRefusal(`${opts.label} uses port ${installed.port}; rerun with that --port or another --label.`);
      const health = await wait(deps.health(opts.port));
      if (health && realpathSync(health.stimHome) !== realpathSync(process.env.STIM_HOME ?? join(serverDir(), '..'))) {
        throw new SetupRefusal(
          'The server on this port uses another STIM_HOME; use its exported STIM_HOME or another --port.',
        );
      }
      desktop = health !== null && installed === null;
      output.managed = !desktop;
      const current = health ?? (installed?.script ? deps.build(installed.script) : null);
      const decision = setupVersionDecision(current?.version ?? null, version, !desktop);
      const fix = desktop
        ? `npm install --global @stim-cli/server@${version}`
        : `stim-server service update --label ${opts.label} --release ${version}`;
      if (decision === 'too-old')
        throw new SetupRefusal(
          `This server predates setup support (${current?.version}); needs >= ${SETUP_MIN_VERSION}. ${desktop ? "Update and restart the app's server, then rerun setup." : 'Update the service, then rerun setup.'}`,
          false,
          fix,
        );
      if (decision === 'update') {
        if (!installed?.script || !installed.node || installed.port === null)
          throw new SetupRefusal('The managed service has no usable server invocation.');
        for (const note of await wait(
          deps.update(
            opts.label,
            { ...installed, script: installed.script, node: installed.node, port: installed.port },
            { release: version },
            log,
          ),
        ))
          log(note);
        installed = await wait(deps.installed(opts.label));
        const updated = await wait(deps.health(opts.port));
        if (!updated) throw new SetupRefusal('The updated server is not answering.');
        output.server = { version: updated.version, stimBuild: updated.stimBuild ?? null };
        script = installed?.script ?? '';
      } else if (decision === 'install') {
        const target = await wait(deps.install(deps.versions(opts.label), { release: version }, deps.node, log));
        script = target.script;
        output.server = target.build;
      } else {
        output.server = { version: current!.version, stimBuild: current!.stimBuild ?? null };
        script = installed?.script ?? '';
      }
      step(
        'server',
        'ok',
        `stim-server ${output.server.version}`,
        desktop
          ? "Using the existing server; permissions are that app's."
          : decision === 'reuse'
            ? 'Already installed; never downgrades.'
            : 'Installed exact release.',
      );
      step('host', 'running', 'Stim Host');
      host = await wait(deps.installHost());
      step('host', 'ok', 'Stim Host', host.app);
      if (installed?.host) {
        const app = dirname(dirname(dirname(installed.host)));
        host = { ...host, executable: installed.host, app, name: basename(app, '.app') };
      }
      step('service', 'running', 'Service');
      if (!desktop) {
        for (const note of await wait(
          deps.installJob({ ...opts, serve: false }, { script, host, requestPermissions: false }),
        ))
          log(note);
        const ready = await wait(deps.health(opts.port));
        if (!ready || (ready.startup && ready.startup.state !== 'ready'))
          throw new SetupRefusal('The installed server is not ready; check service status.');
      }
      step(
        'service',
        'ok',
        'Service',
        desktop ? 'Reusing app server; no LaunchAgent installed.' : `${opts.label} running.`,
      );
    });
    const previous = desktop ? null : await wait(deps.installed(opts.label));
    step('route', 'running', 'Tailnet route');
    const route = await wait(deps.route(opts.port));
    output.route.state = route.state;
    output.route.port = route.port;
    const plan = planServe(route, opts.port, previous?.serve ?? null);
    if ('refusal' in plan)
      throw new SetupRefusal(
        plan.refusal,
        false,
        route.state === 'funneled'
          ? route.ports.map((p) => `tailscale funnel --https=${p} off`).join('\n')
          : 'tailscale serve status --json',
      );
    const prepared = await wait(deps.prepareRoute(opts.port, previous));
    if (desktop && prepared.create)
      throw new SetupRefusal(
        'The app server needs an existing tailnet route; setup cannot record route ownership for it.',
        false,
        `tailscale ${prepared.create.join(' ')}`,
      );
    let routeCreated = false;
    let verified: ServeRoute;
    try {
      if (prepared.create) {
        await deps.createRoute(prepared.create);
        routeCreated = true;
      }
      verified = await wait(deps.route(opts.port));
      output.route.state = verified.state;
      output.route.port = verified.port;
      if (verified.state !== 'routed')
        throw new SetupRefusal('Tailnet route could not be verified.', false, 'tailscale serve status --json');
      if (!desktop) await deps.recordRoute(opts.label, opts.port, prepared.record);
    } catch (error) {
      if (routeCreated) {
        try {
          await deps.createRoute(['serve', `--https=${prepared.record.port}`, 'off']);
          output.route.state = 'missing';
        } catch (rollbackError) {
          throw new SetupRefusal(
            `${(error as Error).message}; could not remove the route: ${(rollbackError as Error).message}`,
            false,
            `tailscale serve --https=${prepared.record.port} off`,
          );
        }
      }
      throw error;
    }
    step('route', 'ok', 'Tailnet route', `${preflight.dnsName}: https port ${verified.port}`);
    step('approve', 'running', 'Access approval', `Waiting until ${opts.expiresAt}.`);
    const declined = new Set<SetupCapability>();
    requireApprovalMode(deps, opts);
    while (deps.now() < Date.parse(opts.expiresAt)) {
      const remaining = opts.capabilities.filter(
        (c) => !declined.has(c) && !journal.granted.some((g) => g.capability === c),
      );
      if (!remaining.length) break;
      const grants = selectGrants(deps.records(deps.now()), { ...opts, capabilities: remaining, now: deps.now() });
      for (const { capability, record, approved } of grants) {
        const verb = capability === 'build' ? 'build on this Mac' : 'host simulators on this Mac';
        if (!approved && !opts.yes && !deps.tty)
          throw new SetupRefusal('To approve requests, rerun with --yes or in a terminal.');
        if (!approved && !opts.yes) {
          log(
            capability === 'build'
              ? 'This runs its project code on this Mac to build.'
              : 'This runs its native app code in session-owned simulators on this Mac.',
          );
          const yes = await wait(
            deps.confirm(
              `${record.name} (node ${opts.nodeId.slice(0, 4)}...) asks to ${verb}. Approve? [y/N] `,
              Math.max(1, Date.parse(opts.expiresAt) - deps.now()),
            ),
          );
          if (deps.now() >= Date.parse(opts.expiresAt)) break;
          if (!yes) {
            declined.add(capability);
            deps.stderr(`stim-server: ${capability} approval refused.`);
            step(`approve.${capability}`, 'failed', `${capability} refused`, 'No approval given.');
            continue;
          }
        }
        if (deps.now() >= Date.parse(opts.expiresAt)) break;
        if (!approved && deps.grant(record.id, [capability], deps.now()) !== 'granted')
          throw new SetupRefusal(`Request ${record.id} lapsed or changed; rerun with a new request.`);
        journal.granted.push({ capability, id: record.id });
        output.granted.push({ capability, id: record.id, client: { nodeId: opts.nodeId, name: record.name } });
        step(
          `approve.${capability}`,
          'ok',
          `${approved ? 'Already approved' : 'Approved'} ${record.name} (${opts.nodeId}) for ${capability === 'build' ? 'builds' : 'hosted simulators'}`,
          `request ${record.id}`,
        );
      }
      if (opts.capabilities.every((c) => declined.has(c) || journal.granted.some((g) => g.capability === c))) break;
      await wait(deps.sleep(Math.min(1000, Math.max(0, Date.parse(opts.expiresAt) - deps.now()))));
    }
    step(
      'approve',
      journal.granted.length === opts.capabilities.length ? 'ok' : 'pending',
      'Access approval',
      journal.granted.length === opts.capabilities.length
        ? 'Chosen capabilities approved.'
        : 'Missing approval: builds or hosted simulators will not work. Generate a new command after expiry.',
    );
    if (journal.granted.length) {
      if (opts.capabilities.includes('device-host')) await checkPermissions(deps, opts, host!, desktop, output, step);
      step('tools', 'running', 'Tools');
      const tools = await wait(deps.toolchain(opts));
      if (!tools) throw new SetupRefusal('Could not read the local build toolchain.');
      const checks: [string, boolean, string, string][] = [
        [
          'Xcode',
          !!tools.xcode && !!tools.simulatorSdk,
          tools.xcode ?? 'Missing Xcode or iOS SDK',
          'Install Xcode from the App Store; sudo xcodebuild -runFirstLaunch',
        ],
        [
          'iOS runtime',
          tools.runtimes.length > 0,
          tools.runtimes.join(', ') || 'No iOS simulator runtime',
          'xcodebuild -downloadPlatform iOS',
        ],
        [
          'CocoaPods',
          !!tools.cocoapods,
          tools.cocoapods ?? 'Missing CocoaPods',
          'brew install cocoapods; or gem install bundler',
        ],
        ['JDK', !!tools.jdk, tools.jdk ?? 'Missing JDK', 'brew install --cask zulu@17'],
        [
          'Android SDK',
          !!tools.androidSdk?.platforms.length && !!tools.androidSdk.buildTools.length && !!tools.androidSdk.ndk.length,
          tools.androidSdk ? JSON.stringify(tools.androidSdk) : 'Missing Android SDK',
          'Install Android Studio or set ANDROID_HOME',
        ],
        [
          'Stim build',
          !!output.server.stimBuild && output.server.stimBuild === tools.stimBuild,
          `${output.server.stimBuild ?? 'unknown'} (setup: ${tools.stimBuild ?? 'unknown'})`,
          "Install This Mac's Build from Stim Desktop > Settings > Build machines",
        ],
      ];
      for (const [tool, present, detail, fix] of checks) {
        const needed =
          opts.capabilities.includes('build') || tool === 'Xcode' || tool === 'iOS runtime' || tool === 'Stim build';
        output.tools.push({ tool, state: !needed ? 'not-needed' : present ? 'present' : 'missing', detail, fix });
        step(
          `tools.${tool}`,
          present || !needed ? 'ok' : 'pending',
          tool,
          !needed
            ? 'Not needed for hosted simulators.'
            : present
              ? detail
              : `${detail}; ${opts.capabilities.includes('build') ? 'builds requiring this tool' : 'hosted simulators'} will not work.`,
          present || !needed ? undefined : fix,
        );
      }
      step('tools', 'ok', 'Tools', 'Checked; installs nothing.');
    }
  } catch (error) {
    const message = deps.signal?.aborted ? 'interrupted' : error instanceof Error ? error.message : String(error);
    const expired = !deps.signal?.aborted && error instanceof SetupRefusal && error.expired;
    try {
      step(
        active,
        expired ? 'pending' : 'failed',
        expired ? 'Ticket expired' : 'Setup refused',
        message,
        error instanceof SetupRefusal ? error.fix : undefined,
      );
    } catch (writeError) {
      const detail = `Could not write the setup journal: ${(writeError as Error).message}`;
      deps.stderr(`stim-server: ${detail}`);
      output.warnings.push(detail);
    }
    const code = (error as { code?: string }).code;
    deps.stderr(`stim-server: ${code ? `${code}: ` : ''}${message}`);
    output.warnings.push(message);
  } finally {
    try {
      journal.steps.push({
        id: 'summary',
        state: 'ok',
        title: 'Summary',
        detail: `${output.label}, port ${output.port}, route https ${output.route.port}.`,
      });
      journal.done = true;
      journal.exit = setupExitCode(journal);
      try {
        save();
      } catch (error) {
        const message = `Could not finish the setup journal: ${(error as Error).message}`;
        journal.steps.push({ id: 'journal', state: 'failed', title: 'Setup journal', detail: message });
        journal.exit = setupExitCode(journal);
        deps.stderr(`stim-server: ${message}`);
        output.warnings.push(message);
      }
      output.ok = journal.exit === 0;
      if (options) summarizeSetup(output, options, log);
      if (json) deps.stdout(JSON.stringify(output));
    } finally {
      release?.();
    }
  }
  return journal.exit!;
}
