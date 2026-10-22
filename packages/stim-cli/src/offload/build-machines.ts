import { withDirLockAsync, type StimContext } from '@stim-cli/core';
import { reportSignal } from '../report-runtime.ts';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HelloResult, RemoteDiagnosis } from '@stim-cli/core/protocol';
import {
  buildMachinesFile,
  buildMachinesLock,
  cannotHost,
  isJsonObject,
  MACHINE_CREDENTIALS_VERSION,
  readBuildMachines,
  readDeviceHostMachines,
  type BuildMachineCredential,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import type { OffloadProblem } from './toolchain.ts';
import { withDirLock } from '../dir-lock.ts';
import { getConfigDir } from '../workspace/config.ts';
import { configuredMachines } from '../device-host/machines.ts';
import { readHostPermissions } from './access-ticket.ts';
import { diagnosisFinding, notOnTailnetDiagnosis } from './diagnosis.ts';
import {
  diagnoseOutcome,
  diagnoseTailscale,
  endpoint,
  findPeer,
  outdatedServer,
  parseMachine,
  reachMachine,
  realIo,
  setupRemedy,
  type GeneratedTickets,
  type TailnetMachineIo,
} from './tailnet.ts';
export { resolveEndpoint, type Endpoint } from './tailnet.ts';
export type BuildMachineIo = TailnetMachineIo;

/** The `remote.machines` entries that approved this machine for builds, in that order. */
export function pairedMachines(entries: string[] = configuredMachines() ?? []): BuildMachineCredential[] {
  const credentials = readBuildMachines().filter((each) => each.state === 'approved');
  return entries.flatMap((entry) => credentials.filter((each) => each.machine === entry));
}

async function updateCredentials(
  change: (credentials: BuildMachineCredential[]) => BuildMachineCredential[],
  operation?: StimContext,
): Promise<void> {
  reportSignal(operation)?.throwIfAborted();
  const dir = getConfigDir();
  const write = () => {
    reportSignal(operation)?.throwIfAborted();
    const file = buildMachinesFile();
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: MACHINE_CREDENTIALS_VERSION, machines: change(readBuildMachines()) }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    try {
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  };
  const options = { ensureParent: () => mkdirSync(dir, { recursive: true }) };
  const signal = reportSignal(operation);
  if (signal) await withDirLockAsync(buildMachinesLock(), write, { ...options, signal });
  else withDirLock(buildMachinesLock(), write, options);
}

/**
 * Where this machine stands with one `remote.machines` entry, as `stim doctor --json` reports it under
 * `remoteMachines`. `dnsName` is the peer's MagicDNS name when the name resolved; `deviceId` is the id the worker
 * lists this machine under once it asked.
 */
interface BuildMachineReport {
  machine: string;
  state:
    | 'invalid'
    | 'tailscale-off'
    | 'not-on-tailnet'
    | 'key-changed'
    | 'not-asked'
    | 'pending'
    | 'approved'
    | 'revoked'
    | 'lapsed'
    | 'outdated'
    | 'unreachable';
  /** The layer this machine stopped at, for `tailscale-off`, `not-on-tailnet`, `outdated` and `unreachable`. */
  diagnosis?: RemoteDiagnosis;
  dnsName?: string;
  deviceId?: string;
  requestedAt?: string;
  expiresAt?: string;
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

type Inspected = { report: BuildMachineReport; finding: Finding | null };

const PROBLEM_TITLES: Record<OffloadProblem['code'], string> = {
  unreachable: 'does not answer a build offer',
  checkout: 'cannot build an app outside a git checkout',
  'stim-build': 'runs an incompatible Stim build',
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
  platform: 'cannot build this platform',
};

function problemFix(code: OffloadProblem['code'], entry: string): string {
  switch (code) {
    case 'unreachable':
      return `Check that stim-server runs on ${entry} and that its tailscale serve route answers, then run \`stim doctor\` again. To keep it running there, run \`stim-server service install --serve\` on ${entry}.`;
    case 'checkout':
      return 'Offload syncs the files git lists; run Stim from a git checkout of the app.';
    case 'stim-build':
      return `Update stim-server on ${entry} to a Stim release with the same build compatibility version as this machine (an older stim-server needs the same Stim build): there, run \`stim-server service update --release <version>\` for this machine's release, or \`--from <dir>\` with the packed packages of this machine's checkout.`;
    case 'arch':
      return 'Use a remote machine with the same CPU architecture as this machine.';
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
      return `Start stim-server on ${entry} with JAVA_HOME at a JDK of the same major version as this machine's.`;
    case 'android-sdk':
    case 'ndk':
    case 'build-tools':
    case 'compile-sdk':
      return `Install the missing package with sdkmanager in the Android SDK stim-server on ${entry} uses (its ANDROID_HOME, else ~/Library/Android/sdk on macOS or ~/Android/Sdk on Linux).`;
    case 'disk':
      return `Free space on ${entry}'s worker root (server.workerRoot there).`;
    case 'platform':
      return `iOS and macOS builds need a Mac; ${entry} can take Android builds only.`;
    case 'busy':
      return `Builds stay on this machine until ${entry} has capacity. On ${entry}, server.maxLoadPerCore sets the load it accepts and concurrency.maxBuilds how many of its own builds it runs; it takes one offloaded build at a time.`;
  }
}

const TRANSIENT: ReadonlySet<OffloadProblem['code']> = new Set(['unreachable', 'busy']);

function offloadFindings(entry: string, problems: OffloadProblem[]): Finding[] {
  return problems.map((problem) => ({
    code: `build-machine-${problem.code}`,
    level: TRANSIENT.has(problem.code) ? 'note' : 'cost',
    title: `Remote machine ${entry} ${PROBLEM_TITLES[problem.code]}`,
    detail: `Builds fall back to this machine: ${problem.reason}.`,
    fix: problemFix(problem.code, entry),
  }));
}

async function inspectMachine(
  entry: string,
  status: Record<string, unknown>,
  deviceName: string,
  fix: boolean,
  version: string,
  tickets: GeneratedTickets,
  io: BuildMachineIo,
  check: OffloadCheck | null,
  operation?: StimContext,
): Promise<Inspected & { extra?: Finding[] }> {
  const parsed = parseMachine(entry);
  if (!parsed) {
    return {
      report: { machine: entry, state: 'invalid' },
      finding: note(`Remote machine ${entry} is not a tailnet name`, 'Expected `name` or `name:port`.'),
    };
  }
  const peer = findPeer(status, parsed.name);
  if (peer === 'missing' || peer === 'ambiguous') {
    const diagnosis = notOnTailnetDiagnosis(entry, peer === 'ambiguous');
    return {
      report: { machine: entry, state: 'not-on-tailnet', diagnosis },
      finding: diagnosisFinding('build-machine', entry, diagnosis),
    };
  }
  const credential = readBuildMachines().find((each) => each.machine === entry);
  const other = () => {
    try {
      return readDeviceHostMachines().find((each) => each.machine === entry);
    } catch {
      return undefined;
    }
  };
  const persist = (next: BuildMachineCredential) =>
    updateCredentials((credentials) => [...credentials.filter((each) => each.machine !== entry), next], operation);
  reportSignal(operation)?.throwIfAborted();
  const outcome = await reachMachine({
    machine: entry,
    access: 'build',
    endpoint: endpoint(peer, parsed.port),
    address: peer.dnsName,
    credential,
    other,
    persist,
    fix,
    deviceName,
    setupFlags: cannotHost(status, entry) ? ['build'] : ['build', 'device-host'],
    serverVersion: version,
    io,
    tickets,
  });
  const known = { machine: entry, dnsName: peer.dnsName };
  reportSignal(operation)?.throwIfAborted();
  if (outcome.state !== 'not-asked' && outcome.credential) {
    const next = outcome.credential;
    if (JSON.stringify(next) !== JSON.stringify(credential))
      await updateCredentials(
        (credentials) => [...credentials.filter((each) => each.machine !== entry), next],
        operation,
      );
  }
  const paired = {
    ...known,
    ...(outcome.state !== 'not-asked' && outcome.credential?.deviceId ? { deviceId: outcome.credential.deviceId } : {}),
    ...(outcome.state !== 'not-asked' && outcome.credential ? { requestedAt: outcome.credential.requestedAt } : {}),
  };
  switch (outcome.state) {
    case 'not-asked':
      return {
        report: { ...known, state: 'not-asked' },
        finding: note(
          `Remote machine ${entry} has not approved this machine for builds`,
          'This machine has not asked it for build access.',
          'Run `stim doctor --fix` to make a setup ticket and print the command to run there.',
        ),
      };
    case 'key-changed':
      return {
        report: { ...paired, state: 'key-changed' },
        finding: note(
          `Remote machine ${entry} answered with a different server key`,
          `${peer.dnsName} did not prove it holds the stim-server key this machine pinned at approval. Stim does not connect to it.`,
          `If that machine or its Stim home was replaced, remove ${entry} from remote.machines, run \`stim doctor --fix\` to forget the old pairing, then add it back and run \`stim doctor --fix\` again.`,
        ),
      };
    case 'pending':
      return {
        report: {
          ...paired,
          state: 'pending',
          ...(outcome.credential.expiresAt ? { expiresAt: outcome.credential.expiresAt } : {}),
        },
        finding: note(
          `Remote machine ${entry} has not approved this machine for builds yet`,
          `It does not hold this machine's setup ticket yet${outcome.credential.expiresAt ? `; the ticket expires at ${outcome.credential.expiresAt}` : ''}.`,
          setupRemedy(entry, outcome.command),
        ),
      };
    case 'lapsed':
      return {
        report: { ...paired, state: 'lapsed' },
        finding: note(
          `Build request to ${entry} lapsed`,
          `${entry} did not approve this machine before its setup ticket expired at ${outcome.credential.expiresAt}.`,
          'Run `stim doctor --fix` to make a new ticket.',
        ),
      };
    case 'revoked':
      return {
        report: { ...paired, state: 'revoked' },
        finding: note(
          `Remote machine ${entry} no longer accepts this machine for builds`,
          `${outcome.reason} It was revoked.`,
          'Run `stim doctor --fix` to ask again.',
        ),
      };
    case 'outdated': {
      const outdated = outdatedServer(entry, version, outcome.command);
      const diagnosis: RemoteDiagnosis = {
        layer: 'compat',
        code: 'server-outdated',
        title: 'Server is outdated',
        message: outdated.detail,
        remedy: outdated.fix,
      };
      return {
        report: { ...paired, state: 'outdated', diagnosis },
        finding: note(outdated.title, outdated.detail, outdated.fix),
      };
    }
    case 'unreachable': {
      const diagnosis = await diagnoseOutcome(io, {
        entry,
        peer,
        port: parsed.port,
        target: endpoint(peer, parsed.port),
        reason: outcome.reason,
        transport: outcome.transport,
      });
      return {
        report: { ...paired, state: 'unreachable', diagnosis },
        finding: diagnosisFinding('build-machine', entry, diagnosis),
      };
    }
  }
  const permissions = readHostPermissions(outcome.result.host);
  const host = permissions ? { host: permissions } : {};
  if (!check) return { report: { ...paired, state: 'approved', ...host }, finding: null };
  const { capacity, problems } = await check(outcome.credential);
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

/**
 * Doctor findings and a report for each `remote.machines` entry. The worker's stim-server key is pinned on first
 * contact; every later connection must prove it holds that key. With `fix`, makes a setup ticket for a named machine
 * this machine holds no pairing for, or that revoked it, and forgets pairings of machines no longer named. With
 * `check`, each approved machine is asked for one build offer and reports every reason it would not take this
 * project's build.
 */
export async function inspectBuildMachines(
  {
    fix,
    check = null,
    version = '<version>',
    tickets = new Map(),
    operation,
  }: {
    fix: boolean;
    check?: OffloadCheck | null;
    version?: string;
    tickets?: GeneratedTickets;
    operation?: StimContext;
  },
  io: BuildMachineIo = realIo,
  entries: string[] | null = configuredMachines(),
): Promise<BuildMachinesInspection> {
  if (entries === null) {
    return {
      findings: [
        note(
          'Invalid remote.machines setting',
          'Use a remote object with machines as an array of tailnet names. Existing credentials and pinned keys are preserved.',
          'Run `stim guide settings` and correct the setting before running doctor again.',
        ),
      ],
      machines: [],
    };
  }
  const unnamed = (each: BuildMachineCredential) => !entries.includes(each.machine);
  if (fix && readBuildMachines().some(unnamed)) {
    await updateCredentials((credentials) => credentials.filter((each) => !unnamed(each)), operation);
  }
  if (entries.length === 0) return { findings: [], machines: [] };
  const status = await io.status();
  if (!isJsonObject(status)) {
    const diagnosis = await diagnoseTailscale(io);
    return {
      findings: [
        note(
          'Remote machines are unreachable',
          `remote.machines names remote machines. ${diagnosis.message}`,
          diagnosis.remedy,
        ),
      ],
      machines: entries.map((machine) => ({ machine, state: 'tailscale-off', diagnosis })),
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
    entries.map((entry) => inspectMachine(entry, status, deviceName, fix, version, tickets, io, check, operation)),
  );
  for (const { report, finding, extra = [] } of inspected) {
    inspection.machines.push(report);
    if (finding) inspection.findings.push(finding);
    inspection.findings.push(...extra);
  }
  return inspection;
}
