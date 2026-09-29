import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
  buildMachinesFile,
  buildMachinesLock,
  isJsonObject,
  readBuildMachines,
  type BuildMachineCredential,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import type { OffloadProblem } from './toolchain.ts';
import { withDirLock } from '../dir-lock.ts';
import { getExecutor } from '../exec.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';

const DEFAULT_SERVE_PORT = 7443;
const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;

export interface TailnetPeer {
  nodeId: string;
  dnsName: string;
  /** A tailnet address of the node; WireGuard delivers packets to it only from that node. */
  address: string;
}

export type HelloReply =
  | {
      result: {
        capabilities: string[];
        device: { id: string; name: string };
        deviceToken?: string;
        approval?: { state: 'pending'; expiresAt: string };
      };
    }
  | { error: { code: string; message: string } }
  | { failed: string };

export interface BuildMachineIo {
  /** `tailscale status --json`, or null when Tailscale is not running. */
  status: () => unknown;
  hello: (endpoint: Endpoint, auth: Record<string, string>) => Promise<HelloReply>;
}

export function parseMachine(entry: string): { name: string; port: number } | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*?)(?::(\d{1,5}))?$/.exec(entry.trim());
  if (!match) return null;
  const port = match[2] === undefined ? DEFAULT_SERVE_PORT : Number(match[2]);
  return port >= 1 && port <= 65535 ? { name: match[1]!.toLowerCase(), port } : null;
}

/**
 * The one peer in `tailscale status --json` whose MagicDNS name is `name` or starts with `name.`. `ID` there is
 * the node's StableID, the same value `tailscale whois` reports as `Node.StableID`.
 */
export function findPeer(status: unknown, name: string): TailnetPeer | 'missing' | 'ambiguous' {
  const peers = isJsonObject(status) && isJsonObject(status.Peer) ? Object.values(status.Peer) : [];
  const found = peers.flatMap((peer) => {
    if (!isJsonObject(peer) || typeof peer.ID !== 'string' || typeof peer.DNSName !== 'string') return [];
    const dnsName = peer.DNSName.replace(/\.$/, '').toLowerCase();
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
    const address = addresses.find((ip) => !ip.includes(':')) ?? addresses[0];
    if (!address || !(dnsName === name || dnsName.startsWith(`${name}.`))) return [];
    return [{ nodeId: peer.ID, dnsName, address }];
  });
  if (found.length === 0) return 'missing';
  return found.length === 1 ? found[0]! : 'ambiguous';
}

export interface Endpoint {
  url: string;
  servername: string;
  host: string;
}

/**
 * Connects to the pinned node's own tailnet address rather than resolving its name, so the socket reaches the
 * node whose ID was just checked. `tailscale serve` still needs the MagicDNS name for TLS (SNI and certificate)
 * and for its Host routing.
 */
function endpoint(peer: TailnetPeer, port: number): Endpoint {
  const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address;
  const suffix = port === 443 ? '' : `:${port}`;
  return { url: `wss://${address}${suffix}`, servername: peer.dnsName, host: `${peer.dnsName}${suffix}` };
}

function tailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output === null) continue;
    try {
      const status = JSON.parse(output) as unknown;
      return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
    } catch {
      return null;
    }
  }
  return null;
}

function hello({ url, servername, host }: Endpoint, auth: Record<string, string>): Promise<HelloReply> {
  return new Promise((resolve) => {
    const options: ClientOptions & ConnectionOptions = {
      handshakeTimeout: HELLO_TIMEOUT_MS,
      servername,
      headers: { Host: host },
    };
    const socket = new WebSocket(url, options);
    const done = (reply: HelloReply) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.close();
      resolve(reply);
    };
    const timer = setTimeout(() => done({ failed: 'no reply in time' }), HELLO_TIMEOUT_MS);
    socket.on('open', () => {
      const client = { name: 'stim', version: '1' };
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: { protocol: 1, client, auth } }));
    });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        message = null;
      }
      if (isJsonObject(message) && ('result' in message || 'error' in message)) return done(message as HelloReply);
      done({ failed: 'the reply was not a hello result' });
    });
    socket.on('error', (error) => done({ failed: error.message }));
    socket.on('close', () => done({ failed: 'the connection closed before a reply' }));
  });
}

const realIo: BuildMachineIo = { status: tailscaleStatus, hello };

/**
 * The endpoint of a paired machine's pinned node, or why Stim does not connect to it. The name must still
 * resolve to exactly the pinned node; the token is never sent anywhere else.
 */
export function pinnedEndpoint(
  credential: BuildMachineCredential,
  status: () => unknown = tailscaleStatus,
): Endpoint | string {
  const parsed = parseMachine(credential.machine);
  if (!parsed) return `${credential.machine} is not a tailnet name`;
  const current = status();
  if (!isJsonObject(current)) return 'Tailscale is not running';
  const peer = findPeer(current, parsed.name);
  if (peer === 'missing') return `no peer on this tailnet is named ${parsed.name}`;
  if (peer === 'ambiguous') return `several tailnet peers match ${parsed.name}`;
  if (peer.nodeId !== credential.nodeId) {
    return `${peer.dnsName} is now node ${peer.nodeId}, not the pinned ${credential.nodeId}; run stim doctor`;
  }
  return endpoint(peer, parsed.port);
}

/** The build machines named in `offload.machines` that this Mac asked for build access, in that order. */
export function pairedMachines(entries: string[] = configuredMachines()): BuildMachineCredential[] {
  const credentials = readBuildMachines();
  return entries.flatMap((entry) => credentials.filter((each) => each.machine === entry));
}

function configuredMachines(): string[] {
  const machines = loadConfig()?.offload?.machines;
  return Array.isArray(machines) ? machines.filter((entry): entry is string => typeof entry === 'string') : [];
}

function updateCredentials(change: (credentials: BuildMachineCredential[]) => BuildMachineCredential[]): void {
  const dir = getConfigDir();
  withDirLock(
    buildMachinesLock(),
    () => {
      const file = buildMachinesFile();
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, machines: change(readBuildMachines()) }, null, 2)}\n`, {
        mode: 0o600,
      });
      try {
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    },
    { ensureParent: () => mkdirSync(dir, { recursive: true }) },
  );
}

/**
 * Where this Mac stands with one `offload.machines` entry, as `stim doctor --json` reports it under
 * `buildMachines`. `dnsName` is the peer's MagicDNS name when the name resolved; `deviceId` is the id the worker
 * lists this Mac under once it asked.
 */
interface BuildMachineReport {
  machine: string;
  state:
    | 'invalid'
    | 'tailscale-off'
    | 'not-on-tailnet'
    | 'node-changed'
    | 'not-asked'
    | 'pending'
    | 'approved'
    | 'revoked'
    | 'unreachable';
  dnsName?: string;
  deviceId?: string;
  requestedAt?: string;
  /** For an approved machine: whether it would take this project's build now, and every reason it would not. */
  offloadable?: boolean;
  reasons?: string[];
  /** The machine's reported capacity, when it answered an offer. */
  capacity?: Record<string, unknown>;
}

/** Asks one approved machine for an offer the way placement does, and returns every reason it would not build. */
export type OffloadCheck = (
  credential: BuildMachineCredential,
) => Promise<{ capacity: Record<string, unknown> | null; problems: OffloadProblem[] }>;

export interface BuildMachinesInspection {
  findings: Finding[];
  machines: BuildMachineReport[];
}

function note(title: string, detail: string, fix: string | null = null): Finding {
  return { code: 'build-machine', level: 'note', title, detail, fix };
}

const approval = (entry: string, deviceId: string) =>
  `A person on ${entry} approves it with \`stim-server devices grant ${deviceId} --build\`.`;

type Inspected = { report: BuildMachineReport; finding: Finding | null };

const PROBLEM_TITLES: Record<OffloadProblem['code'], string> = {
  unreachable: 'does not answer a build offer',
  checkout: 'cannot build an app outside a git checkout',
  'stim-build': 'runs another Stim build',
  arch: 'has another CPU architecture',
  xcode: 'has another Xcode',
  'simulator-sdk': 'has another simulator SDK',
  cocoapods: 'has another CocoaPods',
  runtime: "has no simulator for this project's iOS runtime",
  disk: 'is low on disk',
  busy: 'is too busy to take builds',
};

function problemFix(code: OffloadProblem['code'], entry: string): string {
  switch (code) {
    case 'unreachable':
      return `Check that stim-server runs on ${entry} and that its tailscale serve route answers, then run \`stim doctor\` again.`;
    case 'checkout':
      return 'Offload syncs the files git lists; run Stim from a git checkout of the app.';
    case 'stim-build':
      return `Update Stim on ${entry} to the same build as this Mac (install it from the same commit or release), then restart its stim-server.`;
    case 'arch':
      return 'Use a build machine with the same CPU architecture as this Mac.';
    case 'xcode':
    case 'simulator-sdk':
      return `Install and select the same Xcode on ${entry} and this Mac (\`xcode-select -p\` on each).`;
    case 'cocoapods':
      return `Install the same CocoaPods version on ${entry}, on the PATH its stim-server's login shell sets.`;
    case 'runtime':
      return `Install that iOS simulator runtime on ${entry} with at least one iPhone simulator, or set ios.runtime here to one ${entry} has.`;
    case 'disk':
      return `Free space on ${entry}'s worker root (offload.workerRoot there).`;
    case 'busy':
      return `Builds stay on this Mac until ${entry} has capacity; offload.maxLoadPerCore on ${entry} sets the load it accepts.`;
  }
}

const TRANSIENT: ReadonlySet<OffloadProblem['code']> = new Set(['unreachable', 'busy']);

function offloadFindings(entry: string, problems: OffloadProblem[]): Finding[] {
  return problems.map((problem) => ({
    code: `build-machine-${problem.code}`,
    level: TRANSIENT.has(problem.code) ? 'note' : 'cost',
    title: `Build machine ${entry} ${PROBLEM_TITLES[problem.code]}`,
    detail: `Builds fall back to this Mac: ${problem.reason}.`,
    fix: problemFix(problem.code, entry),
  }));
}

async function requestAccess(
  entry: string,
  peer: TailnetPeer,
  port: number,
  deviceName: string,
  io: BuildMachineIo,
): Promise<Inspected> {
  const reply = await io.hello(endpoint(peer, port), { request: 'build', deviceName });
  if (!('result' in reply) || !reply.result.approval || !reply.result.deviceToken) {
    const reason = 'failed' in reply ? reply.failed : 'error' in reply ? reply.error.message : 'it granted no request';
    return {
      report: { machine: entry, state: 'unreachable', dnsName: peer.dnsName },
      finding: note(`Could not ask ${entry} for build access`, reason),
    };
  }
  const credential: BuildMachineCredential = {
    machine: entry,
    nodeId: peer.nodeId,
    dnsName: peer.dnsName,
    deviceId: reply.result.device.id,
    deviceToken: reply.result.deviceToken,
    state: 'pending',
    requestedAt: new Date().toISOString(),
  };
  updateCredentials((credentials) => [...credentials.filter((each) => each.machine !== entry), credential]);
  return {
    report: {
      machine: entry,
      state: 'pending',
      dnsName: peer.dnsName,
      deviceId: credential.deviceId,
      requestedAt: credential.requestedAt,
    },
    finding: note(
      `Asked ${entry} for build access`,
      `The request lapses at ${reply.result.approval.expiresAt}.`,
      approval(entry, credential.deviceId),
    ),
  };
}

async function inspectMachine(
  entry: string,
  status: Record<string, unknown>,
  deviceName: string,
  fix: boolean,
  io: BuildMachineIo,
  check: OffloadCheck | null,
): Promise<Inspected & { extra?: Finding[] }> {
  const parsed = parseMachine(entry);
  if (!parsed) {
    return {
      report: { machine: entry, state: 'invalid' },
      finding: note(`Build machine ${entry} is not a tailnet name`, 'Expected `name` or `name:port`.'),
    };
  }
  const peer = findPeer(status, parsed.name);
  if (peer === 'missing' || peer === 'ambiguous') {
    const detail = peer === 'missing' ? 'No peer on this tailnet has that name.' : 'Several peers match that name.';
    return {
      report: { machine: entry, state: 'not-on-tailnet' },
      finding: note(`Build machine ${entry} is not on this tailnet`, detail),
    };
  }
  const credential = readBuildMachines().find((each) => each.machine === entry);
  const known = { machine: entry, dnsName: peer.dnsName };
  if (credential && credential.nodeId !== peer.nodeId) {
    return {
      report: { ...known, state: 'node-changed', deviceId: credential.deviceId, requestedAt: credential.requestedAt },
      finding: note(
        `Build machine ${entry} is a different tailnet node`,
        `This Mac paired with node ${credential.nodeId}, but ${peer.dnsName} is now node ${peer.nodeId}. Stim does not connect to it.`,
        `If that Mac was replaced, remove ${entry} from offload.machines, run \`stim doctor --fix\` to forget the old pairing, then add it back and run \`stim doctor --fix\` again.`,
      ),
    };
  }
  if (!credential) {
    if (fix) return requestAccess(entry, peer, parsed.port, deviceName, io);
    return {
      report: { ...known, state: 'not-asked' },
      finding: note(
        `Build machine ${entry} has not approved this Mac`,
        'This Mac has not asked it for build access.',
        'Run `stim doctor --fix` to ask.',
      ),
    };
  }
  const paired = { ...known, deviceId: credential.deviceId, requestedAt: credential.requestedAt };
  const reply = await io.hello(endpoint(peer, parsed.port), { deviceToken: credential.deviceToken });
  if ('result' in reply && reply.result.capabilities.includes('build')) {
    if (credential.state !== 'approved') {
      updateCredentials((credentials) =>
        credentials.map((each) => (each.machine === entry ? { ...each, state: 'approved' } : each)),
      );
    }
    if (!check) return { report: { ...paired, state: 'approved' }, finding: null };
    const { capacity, problems } = await check({ ...credential, state: 'approved' });
    return {
      report: {
        ...paired,
        state: 'approved',
        offloadable: problems.length === 0,
        reasons: problems.map((problem) => problem.reason),
        ...(capacity ? { capacity } : {}),
      },
      finding: null,
      extra: offloadFindings(entry, problems),
    };
  }
  if ('error' in reply && reply.error.code === 'approval-pending') {
    return {
      report: { ...paired, state: 'pending' },
      finding: note(
        `Build machine ${entry} has not approved this Mac yet`,
        `Requested at ${credential.requestedAt}.`,
        approval(entry, credential.deviceId),
      ),
    };
  }
  if ('error' in reply && reply.error.code === 'unauthorized') {
    if (fix) return requestAccess(entry, peer, parsed.port, deviceName, io);
    return {
      report: { ...paired, state: 'revoked' },
      finding: note(
        `Build machine ${entry} no longer accepts this Mac`,
        `${reply.error.message} It was revoked, or the request lapsed before approval.`,
        'Run `stim doctor --fix` to ask again.',
      ),
    };
  }
  const reason = 'failed' in reply ? reply.failed : 'error' in reply ? reply.error.message : 'unexpected reply';
  return {
    report: { ...paired, state: 'unreachable' },
    finding: note(`Could not reach build machine ${entry}`, reason),
  };
}

/**
 * Doctor findings and a report for each `offload.machines` entry. The worker's node is pinned when access is
 * requested; a later connection goes only to the current MagicDNS name of that same node, checked before the token
 * is sent. With `fix`, requests access from a named machine this Mac holds no pairing for, requests again when the
 * pinned node forgot this Mac, and forgets pairings of machines no longer named. With `check`, each approved
 * machine is asked for one build offer and reports every reason it would not take this project's build.
 */
export async function inspectBuildMachines(
  { fix, check = null }: { fix: boolean; check?: OffloadCheck | null },
  io: BuildMachineIo = realIo,
  entries: string[] = configuredMachines(),
): Promise<BuildMachinesInspection> {
  const unnamed = (each: BuildMachineCredential) => !entries.includes(each.machine);
  if (fix && readBuildMachines().some(unnamed)) {
    updateCredentials((credentials) => credentials.filter((each) => !unnamed(each)));
  }
  if (entries.length === 0) return { findings: [], machines: [] };
  const status = io.status();
  if (!isJsonObject(status)) {
    return {
      findings: [
        note('Build machines are unreachable', 'offload.machines names build machines, but Tailscale is not running.'),
      ],
      machines: entries.map((machine) => ({ machine, state: 'tailscale-off' })),
    };
  }
  const self = isJsonObject(status.Self) ? status.Self : {};
  const raw = typeof self.HostName === 'string' && self.HostName ? self.HostName : hostname();
  const deviceName =
    raw
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 64) || 'Mac';
  const inspection: BuildMachinesInspection = { findings: [], machines: [] };
  for (const entry of entries) {
    const { report, finding, extra = [] } = await inspectMachine(entry, status, deviceName, fix, io, check);
    inspection.machines.push(report);
    if (finding) inspection.findings.push(finding);
    inspection.findings.push(...extra);
  }
  return inspection;
}
