import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { claimRemoveCommand, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { isJsonObject, stimBuildDigest, type SetupCapability, type SetupJournal } from '@stim-cli/core/state';
import type { BuildToolchain, ServeRoute } from '@stim-cli/core/protocol';
import { BuildHost } from './build.ts';
import { discoverToolchain } from '@stim-cli/core/toolchain';
import { bundledStim } from './environment.ts';
import { decodeSecret, keyFingerprint, secretValues } from '@stim-cli/core/noise-session';
import { readLanAddresses } from './lan.ts';
import {
  dropSetupSecret,
  readBuildClients,
  readDeviceHostClients,
  serverDir,
  serverIdentity,
  storeSetupSecret,
  watchClientRegistries,
  type PairedDevice,
} from './registry.ts';
import {
  fetchHealth,
  holdingUpdateClaim,
  installJob,
  installServer,
  prepareRoute,
  recordServiceRoute,
  requireManaged,
  serverBuild,
  stableNode,
  updateInstalledService,
} from './service.ts';
import {
  applyServeEnvironment,
  compareVersions,
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
import { run, serviceManagerOrNull, serviceRoot } from './service-manager.ts';
import { SetupPrinter, setupDisplayFor, type SetupDisplay, type StepText } from './setup-output.ts';
import { pruneSetupJournals, writeSetupJournal } from './setup-journal.ts';
import { hostPermissionPanes, installHostApp, requestHostPermissions, type HostApp } from './stim-host.ts';
import {
  findTailscale,
  readRawTailscaleStatus,
  serveRoute,
  tailscaleInstall,
  type TailscaleInstall,
} from '@stim-cli/transport-tailscale';

/** The protocol whose Noise authentication setup tickets rely on; a reused server must speak it. */
const SETUP_PROTOCOL = 2;

/** How long setup waits for a server it started or reused to report its local network listener. */
const LAN_WAIT_MS = 15_000;

export interface SetupOptions {
  ticket: Buffer;
  /** The journal name both sides derive from the ticket. */
  journal: string;
  expiresAt: string;
  capabilities: SetupCapability[];
  label: string;
  port: number;
  env: string[];
  pathPrepend: string[];
  yes: boolean;
  json: boolean;
  verbose: boolean;
  noWait: boolean;
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

export function parseSetupArgs(args: string[], now: number, ticket: string | undefined): SetupOptions {
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
      verbose: { type: 'boolean' },
      'no-wait': { type: 'boolean' },
    },
  });
  if (values.ticket !== undefined)
    throw new SetupRefusal(
      'setup no longer takes --ticket, because other users on this machine can read command-line arguments. Set STIM_SETUP_TICKET=<ticket> before stim-server setup, or copy a new command from Stim Desktop.',
    );
  if (values.client !== undefined)
    throw new SetupRefusal(
      'setup no longer takes --client: the setup ticket alone names the requesting machine. Copy a new command from Stim Desktop, or run `stim doctor --fix` on the requesting machine.',
    );
  const secret = ticket ? decodeSecret(ticket) : null;
  if (!secret) throw new SetupRefusal('STIM_SETUP_TICKET takes the 43 base64url characters of the setup ticket.');
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
    ticket: secret,
    journal: secretValues(secret).journal,
    expiresAt: expires,
    capabilities,
    label,
    port,
    env,
    pathPrepend,
    yes: values.yes === true,
    json: values.json === true,
    verbose: values.verbose === true,
    noWait: values['no-wait'] === true,
  };
}

/** The record a client made for each capability by spending this run's ticket. */
export function selectGrants(
  records: PairedDevice[],
  match: { journal: string; capabilities: SetupCapability[] },
): { capability: SetupCapability; record: PairedDevice }[] {
  return match.capabilities.flatMap((capability) => {
    const record = records.find((r) => r.setupJournal === match.journal && r.capabilities.includes(capability));
    return record ? [{ capability, record }] : [];
  });
}

/**
 * Whether setup installs, updates or reuses the server. `protocol` comes from a running server's `/health`; a server
 * that reports none, or one below protocol 2, cannot take a setup ticket.
 */
export function setupVersionDecision(
  current: { version: string; protocol?: number; running: boolean } | null,
  desired: string,
  managed: boolean,
): 'install' | 'update' | 'reuse' | 'too-old' {
  if (current === null) return 'install';
  if (managed && compareVersions(current.version, desired) < 0) return 'update';
  return current.running && (current.protocol ?? 0) < SETUP_PROTOCOL ? 'too-old' : 'reuse';
}

function tailscaleRefusal(install: TailscaleInstall, platform: SetupDeps['platform']): string {
  if (install === 'none')
    return platform === 'darwin'
      ? 'Install Tailscale on this Mac and sign in to the same tailnet: https://tailscale.com/download/mac'
      : `Install Tailscale on this machine and sign in to the same tailnet: https://tailscale.com/download/${platform === 'win32' ? 'windows' : 'linux'}`;
  if (install === 'app') return 'Turn on Tailscale from its menu bar icon on this Mac, then run this again.';
  return `Run tailscale up on this ${platform === 'darwin' ? 'Mac' : 'machine'}, then run this again.`;
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
  /** The local network endpoints the server listens on, when setup ran without Tailscale. */
  lan?: string[];
  /** The fingerprint of this server's key, which the requesting machine shows before it pins a local network worker. */
  fingerprint: string;
  server: ServerBuild;
  managed: boolean;
  granted: { capability: SetupCapability; id: string; client: { name: string } }[];
  permissions: { screenRecording: PermissionState; deviceControl: PermissionState };
  tools: Tool[];
  warnings: string[];
}

export interface SetupDeps {
  /**
   * Where setup runs. On Linux and Windows it approves builds only, under a systemd user service or a scheduled task,
   * with no Stim Host.
   */
  platform: 'darwin' | 'linux' | 'win32';
  /** The setup ticket, from `STIM_SETUP_TICKET`; other users can read a process's arguments, not its environment. */
  ticket?: string;
  /** Whether Doctor generated this setup command and needs a client reconnect afterward. */
  fromDoctor?: boolean;
  display?: SetupDisplay;
  signal?: AbortSignal;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  tty: boolean;
  stdout(line: string): void;
  stderr(line: string): void;
  confirm(question: string, timeoutMs: number): Promise<boolean>;
  permissionWait(ms: number): Promise<boolean>;
  /**
   * The tailnet name, null without Tailscale, and whether `server.lanAddresses` is set: a local network worker, whose
   * setup checks that listener instead of a tailnet route.
   */
  preflight(options: SetupOptions): Promise<{ dnsName: string | null; lan?: boolean }>;
  /** This server's key fingerprint. */
  fingerprint(): string;
  /** Whether the macOS application firewall is on, or null when it cannot be read or the platform has none. */
  firewall(): Promise<boolean | null>;
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
  records(): PairedDevice[];
  watchRecords(changed: () => void): () => void;
  storeSecret: typeof storeSetupSecret;
  dropSecret: typeof dropSetupSecret;
  panes: typeof hostPermissionPanes;
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
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
    return /^(|y|yes)$/i.test((await input.question(question, { signal: controller.signal })).trim());
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

const discardInput = () => undefined;

export async function discardTypedAhead(stream: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<void> {
  if (!stream.isTTY) return;
  stream.on('data', discardInput);
  stream.resume();
  await sleep(300);
  stream.off('data', discardInput);
  stream.pause();
}

export function defaultSetupDeps(): SetupDeps {
  const manager = serviceManagerOrNull();
  const platform = manager?.name === 'systemd' ? 'linux' : manager?.name === 'taskscheduler' ? 'win32' : 'darwin';
  return {
    platform,
    now: Date.now,
    sleep,
    tty: process.stdin.isTTY === true,
    display: setupDisplayFor(process.stdout.isTTY === true, process.env, (text) => void process.stdout.write(text)),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    confirm: async (question, timeoutMs) => {
      await discardTypedAhead(process.stdin);
      return confirmSetup(createInterface({ input: process.stdin, output: process.stderr }), question, timeoutMs);
    },
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
    async preflight() {
      if (!manager) throw new SetupRefusal('setup runs only on macOS, Linux and Windows.');
      if (compareVersions(process.versions.node, '22.12.0') < 0)
        throw new SetupRefusal('setup needs Node 22.12 or later.');
      const status = await readRawTailscaleStatus(binary(), process.env);
      const dnsName =
        isJsonObject(status) && isJsonObject(status.Self) && typeof status.Self.DNSName === 'string'
          ? status.Self.DNSName.replace(/\.$/, '')
          : '';
      const lan = (await readLanAddresses()).length > 0;
      if (!dnsName && !lan) {
        throw new SetupRefusal(
          `${tailscaleRefusal(tailscaleInstall(process.env), platform)} To set this ${platform === 'darwin' ? 'Mac' : 'machine'} up on the local network without Tailscale, set server.lanAddresses first: npx --yes stim settings set server.lanAddresses '["en0"]', with this machine's network interface or private IPv4 address.`,
        );
      }
      const problem = await manager.sessionProblem();
      if (problem) throw new SetupRefusal(problem);
      return { dnsName: dnsName || null, lan };
    },
    fingerprint: () => keyFingerprint(serverIdentity().publicKey),
    async firewall() {
      if (platform !== 'darwin') return null;
      const result = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
      const state = result.ok ? /State = (\d)/.exec(result.stdout)?.[1] : undefined;
      return state === undefined ? null : state !== '0';
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
    records: () => [...readBuildClients(), ...readDeviceHostClients()],
    watchRecords: watchClientRegistries,
    storeSecret: storeSetupSecret,
    dropSecret: dropSetupSecret,
    panes: hostPermissionPanes,
    requestPermissions: requestHostPermissions,
    async openPane(pane) {
      const result = await run('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
      if (!result.ok) throw new ServiceError(result.stderr.trim());
    },
    async toolchain(options) {
      const env = applyServeEnvironment(discoverToolchain(process.env).env, options.env, options.pathPrepend);
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
  if (selectGrants(deps.records(), options).length !== options.capabilities.length)
    throw new SetupRefusal('To approve requests, rerun with --yes or in a terminal.');
}

type StepView = Pick<StepText, 'text' | 'running' | 'hidden'>;

type StepWriter = (
  id: string,
  state: SetupJournal['steps'][number]['state'],
  title: string,
  detail?: string,
  fix?: string,
  view?: StepView,
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
  for (const [key, field, title, pane, feature, label] of [
    [
      'screenRecording',
      'screenRecording',
      panes.screen,
      'Privacy_ScreenCapture',
      'viewing hosted simulators',
      'Screen recording',
    ],
    [
      'deviceControl',
      'accessibility',
      panes.control,
      'Privacy_Accessibility',
      'controlling hosted simulators',
      'Device control',
    ],
  ] as const) {
    const id = `permissions.${key}`;
    const read = async () => (await wait(deps.health(options.port)))?.host ?? null;
    let permissions = await read();
    if (permissions?.[field]) {
      output.permissions[key] = 'granted';
      report(id, 'ok', title, 'Already granted.', undefined, { text: `${label} permission already granted` });
      continue;
    }
    report(
      id,
      'running',
      title,
      `Click Allow for ${desktop ? 'the app serving this port' : host.name}. Prompts appear on this Mac's screen. Press s in a terminal to skip.`,
      undefined,
      {
        running: `${label} permission: click Allow for ${desktop ? 'the app serving this port' : host.name} on this Mac's screen (press s to skip)`,
      },
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
      {
        text: permissions?.[field]
          ? `${label} permission granted`
          : `${label} permission ${skipped ? 'skipped' : 'not granted'}: ${feature} will not work`,
      },
    );
  }
}

function toolChecks(
  tools: BuildToolchain,
  stimBuild: string | null,
  platform: SetupDeps['platform'],
): [string, boolean, string, string][] {
  return [
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
    [
      'JDK',
      !!tools.jdk,
      tools.jdk ?? 'Missing JDK',
      platform === 'linux'
        ? 'Install JDK 17 (for example sudo apt install openjdk-17-jdk-headless) and rerun setup with --env JAVA_HOME=<jdk>'
        : platform === 'win32'
          ? 'Install JDK 17 (for example winget install EclipseAdoptium.Temurin.17.JDK) and rerun setup with --env JAVA_HOME=<jdk>'
          : 'brew install --cask zulu@17',
    ],
    [
      'Android SDK',
      !!tools.androidSdk,
      tools.androidSdk ? JSON.stringify(tools.androidSdk) : 'Missing Android SDK',
      platform === 'linux'
        ? 'Install the Android SDK in ~/Android/Sdk, or rerun setup with --env ANDROID_HOME=<sdk>'
        : platform === 'win32'
          ? 'Install the Android SDK in %LOCALAPPDATA%\\Android\\Sdk, or rerun setup with --env ANDROID_HOME=<sdk>'
          : 'Install Android Studio or set ANDROID_HOME',
    ],
    [
      'Stim build',
      !!stimBuild && stimBuild === tools.stimBuild,
      `${stimBuild ?? 'unknown'} (setup: ${tools.stimBuild ?? 'unknown'})`,
      "Install This Mac's Build from Stim Desktop > Settings > Remote Machines",
    ],
  ];
}

function reportTools(
  tools: BuildToolchain,
  opts: SetupOptions,
  output: SetupOutput,
  report: StepWriter,
  platform: SetupDeps['platform'],
): void {
  const checks = toolChecks(tools, output.server.stimBuild, platform);
  for (const [tool, present, detail, fix] of checks) {
    const appleTool = tool === 'Xcode' || tool === 'iOS runtime' || tool === 'CocoaPods';
    const needed =
      platform !== 'darwin'
        ? !appleTool
        : opts.capabilities.includes('build') || tool === 'Xcode' || tool === 'iOS runtime' || tool === 'Stim build';
    output.tools.push({ tool, state: !needed ? 'not-needed' : present ? 'present' : 'missing', detail, fix });
    report(
      `tools.${tool}`,
      present || !needed ? 'ok' : 'pending',
      tool,
      !needed
        ? platform !== 'darwin'
          ? `Not needed on ${platform === 'win32' ? 'Windows' : 'Linux'}, which builds Android only.`
          : 'Not needed for hosted simulators.'
        : present
          ? detail
          : `${detail}; ${opts.capabilities.includes('build') ? 'builds requiring this tool' : 'hosted simulators'} will not work.`,
      present || !needed ? undefined : fix,
      { hidden: present || !needed },
    );
  }
}

const capabilityNoun = (capability: SetupCapability) => (capability === 'build' ? 'builds' : 'hosted simulators');

function approvalQuestion(concise: boolean, capability: SetupCapability, here: string): string {
  if (!concise) {
    const verb = capability === 'build' ? `build on ${here}` : `host simulators on ${here}`;
    return `Let the machine holding this setup ticket ${verb}? [Y/n] `;
  }
  const action =
    capability === 'build' ? 'build here (runs its project code' : 'host simulators here (runs its app code';
  return `Approve the machine holding this ticket to ${action} on ${here})? [Y/n] `;
}

function serverText(desktop: boolean, decision: string, version: string): string {
  if (desktop) return `using the app's stim-server ${version}`;
  return `stim-server ${version} ${decision === 'reuse' ? 'already installed' : 'installed'}`;
}

function approvalView(complete: boolean): StepView {
  return complete
    ? { hidden: true }
    : { text: 'no approval before the ticket expired: builds or hosted simulators will not work' };
}

function printSuccess(
  output: SetupOutput,
  options: SetupOptions,
  concise: { printer: SetupPrinter; gaps: { subject: string; fix: string }[]; exit: number | undefined },
): void {
  const { printer, gaps, exit } = concise;
  const machine = output.route.dnsName?.split('.')[0] ?? output.label;
  const client = output.granted[0]?.client.name ?? 'the requesting machine';
  const names = { build: 'build', 'device-host': 'host simulators' };
  const what = options.capabilities.map((c) => names[c]).join(' and ');
  if (exit === 0) printer.headline('ok', `${machine} is ready to ${what} for ${client}`);
  else if (exit === 1) printer.headline('failed', 'Setup did not finish');
  else if (exit === 2) printer.headline('pending', 'No request was approved before the ticket expired');
  else printer.headline('pending', `${machine} is set up, with gaps`);
  printer.result(
    output.granted.map((g) => ({
      state: 'ok' as const,
      text: `${capabilityNoun(g.capability)}: approved for ${g.client.name} (request ${g.id})`,
    })),
  );
  for (const gap of gaps) printer.line(`  Fix (${gap.subject}): ${gap.fix}`);
  const undo = [
    ...output.granted.map((g) => `stim-server devices revoke ${g.id}`),
    ...(output.managed && output.granted.length ? [`stim-server service uninstall --label ${output.label}`] : []),
  ];
  if (undo.length) printer.dim(`To undo: ${undo.join('; ')}`);
  if (output.fingerprint) printer.dim(`Server key fingerprint: ${output.fingerprint}`);
}

function summarizeSetup(
  output: SetupOutput,
  options: SetupOptions,
  log: (line: string) => void,
  concise?: { printer: SetupPrinter; gaps: { subject: string; fix: string }[]; exit: number | undefined },
): void {
  if (concise) return printSuccess(output, options, concise);
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
  if (output.fingerprint) log(`Server key fingerprint: ${output.fingerprint}.`);
  if (output.lan) log(`Local network: ${output.lan.join(', ')}.`);
  for (const grant of output.granted) {
    log(`${grant.capability}: ${grant.client.name}, request ${grant.id}.`);
    log(`Undo: stim-server devices revoke ${grant.id}`);
  }
  log(
    `Permissions: screen recording ${output.permissions.screenRecording}; device control ${output.permissions.deviceControl}.`,
  );
  for (const tool of output.tools) log(`${tool.tool}: ${tool.state}.`);
  for (const warning of output.warnings) log(warning);
  if (output.managed) log(`Undo: stim-server service uninstall --label ${output.label}`);
}

/**
 * Waits for the server to report its local network listener, and names what a person must allow before other machines
 * reach it. Setup never changes the firewall.
 */
async function localNetwork(
  deps: SetupDeps,
  opts: SetupOptions,
  desktop: boolean,
  wait: <T>(work: Promise<T>) => Promise<T>,
): Promise<{ endpoints: string[]; warnings: string[] }> {
  const deadline = deps.now() + LAN_WAIT_MS;
  let lan = (await wait(deps.health(opts.port)))?.lan;
  while (!lan?.addresses.length && deps.now() < deadline) {
    await wait(deps.sleep(1000));
    lan = (await wait(deps.health(opts.port)))?.lan;
  }
  if (!lan?.addresses.length)
    throw new SetupRefusal(
      'stim-server does not listen on any address server.lanAddresses names. Its log names each entry it cannot use.',
      false,
      desktop
        ? 'Check server.lanAddresses with `npx --yes stim settings get server.lanAddresses`, then quit and reopen Stim Desktop.'
        : `Check server.lanAddresses with \`npx --yes stim settings get server.lanAddresses\`, and the log \`stim-server service status --label ${opts.label}\` names.`,
    );
  const { port } = lan;
  const endpoints = lan.addresses.map((address) => `ws://${address}:${port}`);
  if ((await wait(deps.firewall())) !== true) return { endpoints, warnings: [] };
  const service = desktop ? null : await wait(deps.installed(opts.label));
  const node = desktop ? "the node that runs Stim Desktop's stim-server" : (service?.node ?? deps.node);
  return {
    endpoints,
    warnings: [
      `The macOS firewall is on: when macOS asks whether ${node} may accept incoming network connections, choose Allow, or allow it in System Settings > Network > Firewall > Options. Other machines cannot connect until then.`,
    ],
  };
}

export async function runSetup(args: string[], version: string, deps: SetupDeps): Promise<number> {
  const json = args.includes('--json');
  let options: SetupOptions | undefined;
  let journal: SetupJournal = {
    v: 1,
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
    fingerprint: '',
    server: { version, stimBuild: deps.stimBuild },
    managed: false,
    granted: [],
    permissions: { screenRecording: 'not-needed', deviceControl: 'not-needed' },
    tools: [],
    warnings: [],
  };
  const log = (line: string) => (json ? deps.stderr : deps.stdout)(line);
  const verbose = args.includes('--verbose');
  const display = deps.display ?? { tty: false, color: false, raw: () => {} };
  const printer = new SetupPrinter(log, display, json || verbose);
  const concise = !json && !verbose;
  const chatter = concise ? () => {} : log;
  const gaps: { subject: string; fix: string }[] = [];
  if (!json) printer.banner();
  const androidOnly = deps.platform !== 'darwin';
  const here = androidOnly ? 'this machine' : 'this Mac';
  const serviceNoun =
    deps.platform === 'linux' ? 'systemd user service' : deps.platform === 'win32' ? 'scheduled task' : 'LaunchAgent';
  const wait = <T>(work: Promise<T>) => interruptible(work, deps.signal);
  let release: (() => void) | undefined;
  let secretStored = false;
  let active = 'args';
  let writable = true;
  const save = () => {
    if (release && options && writable) {
      try {
        deps.write(options.journal, journal);
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
    view: StepView = {},
  ) => {
    if (deps.signal?.aborted && state !== 'failed') throw new SetupRefusal('interrupted');
    active = id;
    const value = { id, state, title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
    const index = journal.steps.findIndex((s) => s.id === id);
    if (index < 0) journal.steps.push(value);
    else journal.steps[index] = value;
    save();
    if (fix && state !== 'ok' && state !== 'running') gaps.push({ subject: title, fix });
    printer.step({ ...value, ...view });
  };
  try {
    options = parseSetupArgs(args, deps.now(), deps.ticket);
    Object.assign(output, { label: options.label, port: options.port });
    if (androidOnly && options.capabilities.includes('device-host'))
      throw new SetupRefusal(
        `Hosting simulators needs a Mac. On ${deps.platform === 'win32' ? 'Windows' : 'Linux'}, run setup with --build only.`,
      );
    if (options.capabilities.includes('device-host'))
      output.permissions = { screenRecording: 'denied', deviceControl: 'denied' };
    journal = {
      ...journal,
      capabilities: options.capabilities,
      expiresAt: options.expiresAt,
    };
    const preflight = await wait(deps.preflight(options));
    output.route.dnsName = preflight.dnsName;
    output.fingerprint = deps.fingerprint();
    requireApprovalMode(deps, options);
    release = deps.claim();
    deps.prune(deps.now());
    step('preflight', 'ok', 'Preflight', undefined, undefined, { hidden: true });
    const opts = options;
    let installed: InstalledService | null = null;
    let host: HostApp | null = null;
    let script = '';
    let desktop = false;
    await deps.withInstallClaim(opts.label, async () => {
      step('server', 'running', 'stim-server', undefined, undefined, { running: 'Checking stim-server' });
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
      const decision = setupVersionDecision(
        current && { version: current.version, protocol: health?.protocol, running: health !== null },
        version,
        !desktop,
      );
      const fix = desktop
        ? `If Stim Desktop runs this server, update Stim Desktop with Check for Updates in its app menu. Otherwise run npm install --global @stim-cli/server@${version} and restart the server.`
        : `stim-server service update --label ${opts.label} --release ${version}${opts.noWait ? ' --no-wait' : ''}`;
      if (decision === 'too-old')
        throw new SetupRefusal(
          `This server predates setup support (${current?.version} speaks protocol ${health?.protocol ?? 1}; setup needs protocol ${SETUP_PROTOCOL}). ${desktop ? "Update and restart the app's server, then rerun setup." : 'Update the service, then rerun setup.'}`,
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
            chatter,
            !opts.noWait,
          ),
        ))
          chatter(note);
        installed = await wait(deps.installed(opts.label));
        const updated = await wait(deps.health(opts.port));
        if (!updated) throw new SetupRefusal('The updated server is not answering.');
        output.server = { version: updated.version, stimBuild: updated.stimBuild ?? null };
        script = installed?.script ?? '';
      } else if (decision === 'install') {
        const target = await wait(deps.install(deps.versions(opts.label), { release: version }, deps.node, chatter));
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
        undefined,
        {
          text: serverText(desktop, decision, output.server.version),
        },
      );
      if (!androidOnly) {
        step('host', 'running', 'Stim Host', undefined, undefined, { running: 'Installing Stim Host' });
        const installedHost = await wait(deps.installHost());
        host = installedHost;
        step('host', 'ok', 'Stim Host', installedHost.app, undefined, { text: 'Stim Host installed' });
        if (installed?.host) {
          const app = dirname(dirname(dirname(installed.host)));
          host = { ...installedHost, executable: installed.host, app, name: basename(app, '.app') };
        }
      }
      step('service', 'running', 'Service', undefined, undefined, { running: 'Starting the service' });
      if (!desktop) {
        for (const note of await wait(
          deps.installJob({ ...opts, serve: false }, { script, host, requestPermissions: false }),
        ))
          chatter(note);
        const ready = await wait(deps.health(opts.port));
        if (!ready || (ready.startup && ready.startup.state !== 'ready'))
          throw new SetupRefusal('The installed server is not ready; check service status.');
      }
      step(
        'service',
        'ok',
        'Service',
        desktop ? `Reusing app server; no ${serviceNoun} installed.` : `${opts.label} running.`,
        undefined,
        { text: desktop ? `reusing the app server (no ${serviceNoun})` : `${serviceNoun} ${opts.label} running` },
      );
    });
    if (preflight.lan) {
      step('route', 'running', 'Local network', undefined, undefined, {
        running: 'Checking the local network listener',
      });
      const lan = await localNetwork(deps, opts, desktop, wait);
      output.route.state = 'local-network';
      output.lan = lan.endpoints;
      step('route', 'ok', 'Local network', lan.endpoints.join(', '), undefined, {
        text: `local network ${lan.endpoints.join(', ')} (no Tailscale)`,
      });
      for (const warning of lan.warnings) {
        output.warnings.push(warning);
        printer.clear();
        log(warning);
      }
    } else {
      const previous = desktop ? null : await wait(deps.installed(opts.label));
      step('route', 'running', 'Tailnet route', undefined, undefined, { running: 'Checking the tailnet route' });
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
      step('route', 'ok', 'Tailnet route', `${preflight.dnsName}: https port ${verified.port}`, undefined, {
        text: `tailnet route https ${verified.port} (no Funnel)`,
      });
    }
    step('approve', 'running', 'Access approval', `Waiting until ${opts.expiresAt}.`, undefined, {
      running: `Waiting for approval until ${opts.expiresAt}`,
    });
    requireApprovalMode(deps, opts);
    const recorded = (capabilities: SetupCapability[]) =>
      selectGrants(deps.records(), { journal: opts.journal, capabilities }).filter(
        (grant) => !journal.granted.some((g) => g.capability === grant.capability),
      );
    const note = (grant: { capability: SetupCapability; record: PairedDevice }, already: boolean) => {
      journal.granted.push({ capability: grant.capability, id: grant.record.id });
      output.granted.push({ capability: grant.capability, id: grant.record.id, client: { name: grant.record.name } });
      step(
        `approve.${grant.capability}`,
        'ok',
        `${already ? 'Already approved' : 'Approved'} ${grant.record.name} for ${grant.capability === 'build' ? 'builds' : 'hosted simulators'}`,
        `request ${grant.record.id}`,
        undefined,
        {
          text: `${already ? 'already approved' : 'approved'} ${grant.record.name} for ${capabilityNoun(grant.capability)}`,
        },
      );
    };
    for (const grant of recorded(opts.capabilities)) note(grant, true);
    const approved: SetupCapability[] = [];
    for (const capability of opts.capabilities) {
      if (journal.granted.some((g) => g.capability === capability)) continue;
      if (!opts.yes) {
        printer.clear();
        if (!concise)
          log(
            capability === 'build'
              ? `This runs its project code on ${here} to build.`
              : 'This runs its native app code in session-owned simulators on this Mac.',
          );
        const yes = await wait(
          deps.confirm(
            approvalQuestion(concise, capability, here),
            Math.max(1, Date.parse(opts.expiresAt) - deps.now()),
          ),
        );
        if (deps.now() >= Date.parse(opts.expiresAt)) break;
        if (!yes) {
          printer.clear();
          if (!(concise && display.tty)) deps.stderr(`stim-server: ${capability} approval refused.`);
          step(`approve.${capability}`, 'failed', `${capability} refused`, 'No approval given.');
          continue;
        }
      }
      approved.push(capability);
    }
    if (approved.length && deps.now() < Date.parse(opts.expiresAt)) {
      let changed = false;
      let sleeping: AbortController | undefined;
      const stopWatching = deps.watchRecords(() => {
        changed = true;
        sleeping?.abort();
      });
      try {
        deps.storeSecret(opts.ticket, approved, opts.expiresAt, deps.now());
        secretStored = true;
        const waiting = preflight.lan
          ? `Waiting for the requesting machine to reconnect. Run \`stim doctor --fix\` in a terminal on that machine: it shows this machine's server key fingerprint, ${output.fingerprint}, and pins the key only after you confirm it matches.`
          : deps.fromDoctor
            ? 'Waiting for the requesting machine to reconnect. Run `stim doctor` on that machine to finish.'
            : 'Waiting for the requesting machine to connect. Stim Desktop sends this automatically.';
        step('approve', 'running', 'Access approval', waiting, undefined, { running: waiting });
        while (deps.now() < Date.parse(opts.expiresAt)) {
          changed = false;
          for (const grant of recorded(approved)) note(grant, false);
          if (approved.every((c) => journal.granted.some((g) => g.capability === c))) break;
          if (changed) continue;
          sleeping = new AbortController();
          await wait(deps.sleep(Math.min(1000, Math.max(0, Date.parse(opts.expiresAt) - deps.now())), sleeping.signal));
          sleeping = undefined;
        }
      } finally {
        sleeping?.abort();
        stopWatching();
      }
    }

    step(
      'approve',
      journal.granted.length === opts.capabilities.length ? 'ok' : 'pending',
      'Access approval',
      journal.granted.length === opts.capabilities.length
        ? 'Chosen capabilities approved.'
        : 'Missing approval: builds or hosted simulators will not work. Generate a new command after expiry.',
      undefined,
      approvalView(journal.granted.length === opts.capabilities.length),
    );
    if (journal.granted.length) {
      if (opts.capabilities.includes('device-host')) await checkPermissions(deps, opts, host!, desktop, output, step);
      step('tools', 'running', 'Tools', undefined, undefined, { running: 'Checking build tools' });
      const tools = await wait(deps.toolchain(opts));
      if (!tools) throw new SetupRefusal('Could not read the local build toolchain.');
      reportTools(tools, opts, output, step, deps.platform);
      step('tools', 'ok', 'Tools', 'Checked; installs nothing.', undefined, {
        text: 'build tools ready',
        hidden: output.tools.some((t) => t.state === 'missing'),
      });
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
      printer.clear();
      deps.stderr(`stim-server: ${detail}`);
      output.warnings.push(detail);
    }
    const code = (error as { code?: string }).code;
    printer.clear();
    if (!(concise && display.tty)) deps.stderr(`stim-server: ${code ? `${code}: ` : ''}${message}`);
    output.warnings.push(message);
  } finally {
    if (secretStored && options) {
      try {
        deps.dropSecret(options.journal);
      } catch (error) {
        deps.stderr(`stim-server: could not delete the setup ticket's secret: ${(error as Error).message}`);
      }
    }
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
        printer.clear();
        deps.stderr(`stim-server: ${message}`);
        output.warnings.push(message);
      }
      output.ok = journal.exit === 0;
      if (options) summarizeSetup(output, options, log, concise ? { printer, gaps, exit: journal.exit } : undefined);
      if (json) deps.stdout(JSON.stringify(output));
    } finally {
      release?.();
    }
  }
  return journal.exit!;
}
