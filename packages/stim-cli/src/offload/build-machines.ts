import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HelloResult } from '@stim-cli/core/protocol';
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
import { getConfigDir, loadConfig } from '../workspace/config.ts';
import { readAccessTicket } from './access-ticket.ts';

import { endpoint, findPeer, parseMachine, realIo, type TailnetPeer, type TailnetMachineIo } from './tailnet.ts';
export { findPeer, parseMachine, pinnedEndpoint, type Endpoint, type HelloReply } from './tailnet.ts';
export type BuildMachineIo = TailnetMachineIo;

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
  host?: NonNullable<HelloResult['host']>;
  /** For an approved machine: whether it would take this project's build now, and every reason it would not. */
  offloadable?: boolean;
  reasons?: string[];
  /** The same reasons with the code of each, in the same order. */
  problems?: OffloadProblem[];
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
  'macos-sdk': 'has another macOS SDK',
  'simulator-sdk': 'has another simulator SDK',
  cocoapods: 'has another CocoaPods',
  bundler: 'has no Bundler',
  runtime: "has no simulator for this project's iOS runtime",
  jdk: 'runs another JDK major version',
  'android-sdk': 'has no Android SDK',
  ndk: "lacks this project's NDK",
  'build-tools': "lacks this project's Android build-tools",
  'compile-sdk': "lacks this project's Android compile platform",
  disk: 'is low on disk',
  busy: 'is too busy to take builds',
};

function problemFix(code: OffloadProblem['code'], entry: string): string {
  switch (code) {
    case 'unreachable':
      return `Check that stim-server runs on ${entry} and that its tailscale serve route answers, then run \`stim doctor\` again. To keep it running there, run \`stim-server service install --serve\` on ${entry}.`;
    case 'checkout':
      return 'Offload syncs the files git lists; run Stim from a git checkout of the app.';
    case 'stim-build':
      return `Update stim-server on ${entry} to the same Stim build as this Mac: there, run \`stim-server service update --release <version>\` for this Mac's release, or \`--from <dir>\` with the packed packages of this Mac's checkout.`;
    case 'arch':
      return 'Use a build machine with the same CPU architecture as this Mac.';
    case 'xcode':
    case 'simulator-sdk':
    case 'macos-sdk':
      return `Install and select the same Xcode on ${entry} and this Mac (\`xcode-select -p\` on each).`;
    case 'cocoapods':
      return `Install the same CocoaPods version on ${entry}, on the PATH its stim-server's login shell sets.`;
    case 'bundler':
      return `Install Bundler (\`gem install bundler\`) on ${entry}, on the PATH its stim-server's login shell sets.`;
    case 'runtime':
      return `Install that iOS simulator runtime on ${entry} with at least one iPhone simulator, or set ios.runtime here to one ${entry} has.`;
    case 'jdk':
      return `Start stim-server on ${entry} with JAVA_HOME at a JDK of the same major version as this Mac's.`;
    case 'android-sdk':
    case 'ndk':
    case 'build-tools':
    case 'compile-sdk':
      return `Install the missing package with sdkmanager in the Android SDK stim-server on ${entry} uses (its ANDROID_HOME, else ~/Library/Android/sdk).`;
    case 'disk':
      return `Free space on ${entry}'s worker root (offload.workerRoot there).`;
    case 'busy':
      return `Builds stay on this Mac until ${entry} has capacity. On ${entry}, offload.maxLoadPerCore sets the load it accepts and concurrency.maxBuilds how many of its own builds it runs; it takes one offloaded build at a time.`;
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
  const ticket = readAccessTicket();
  const reply = await io.hello(endpoint(peer, port), {
    request: 'build',
    deviceName,
    ...(ticket ? { setupTicket: ticket.ticket } : {}),
  });
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
    ...(ticket ? { ticketHash: ticket.ticketHash } : {}),
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
    const host = reply.result.host ? { host: reply.result.host } : {};
    if (credential.state !== 'approved') {
      updateCredentials((credentials) =>
        credentials.map((each) => (each.machine === entry ? { ...each, state: 'approved' } : each)),
      );
    }
    if (!check) return { report: { ...paired, state: 'approved', ...host }, finding: null };
    const { capacity, problems } = await check({ ...credential, state: 'approved' });
    return {
      report: {
        ...paired,
        state: 'approved',
        ...host,
        offloadable: problems.length === 0,
        reasons: problems.map((problem) => problem.reason),
        problems,
        ...(capacity ? { capacity } : {}),
      },
      finding: null,
      extra: offloadFindings(entry, problems),
    };
  }
  if ('error' in reply && reply.error.code === 'approval-pending') {
    const ticket = fix && credential.state !== 'approved' ? readAccessTicket() : undefined;
    if (ticket && credential.ticketHash !== ticket.ticketHash) {
      return requestAccess(entry, peer, parsed.port, deviceName, io);
    }
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
    finding: note(
      `Could not reach build machine ${entry}`,
      reason,
      `Check that stim-server runs on ${entry}. To keep it running there, run \`stim-server service install --serve\` on ${entry}.`,
    ),
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
  const inspected = await Promise.all(
    entries.map((entry) => inspectMachine(entry, status, deviceName, fix, io, check)),
  );
  for (const { report, finding, extra = [] } of inspected) {
    inspection.machines.push(report);
    if (finding) inspection.findings.push(finding);
    inspection.findings.push(...extra);
  }
  return inspection;
}
