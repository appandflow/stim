import { withDirLockAsync, type StimContext } from '@stim-cli/core';
import { reportSignal } from '../report-runtime.ts';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HelloResult, RemoteDiagnosis } from '@stim-cli/core/protocol';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  deviceHostMachinesClaims,
  deviceHostMachinesFile,
  deviceHostMachinesLock,
  acceptsShape,
  cannotHost,
  currentTailnet,
  isJsonObject,
  localEndpoint,
  MACHINE_CREDENTIALS_VERSION,
  readBuildMachines,
  readDeviceHostMachines,
  settingDefinition,
  type DeviceHostMachineCredential,
  wrongTailnet,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { withDirLock } from '../dir-lock.ts';
import { readHostPermissions } from '../offload/access-ticket.ts';
import {
  diagnoseLocalUnreachable,
  diagnosisFinding,
  notOnTailnetDiagnosis,
  unconfirmedKeyFinding,
} from '../offload/diagnosis.ts';
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
  tailscaleStatusAsync,
  type GeneratedTickets,
  type KeyConfirmer,
  type TailnetMachineIo,
} from '../offload/tailnet.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';

interface MachineReport {
  machine: string;
  state:
    | 'invalid'
    | 'tailscale-off'
    | 'not-on-tailnet'
    | 'key-changed'
    | 'key-unconfirmed'
    | 'not-asked'
    | 'pending'
    | 'approved'
    | 'revoked'
    | 'lapsed'
    | 'outdated'
    | 'unreachable'
    | 'credentials-unavailable'
    | 'busy';
  diagnosis?: RemoteDiagnosis;
  dnsName?: string;
  /** For `key-unconfirmed`: the fingerprint of the key the machine answered with, for a person to compare. */
  fingerprint?: string;
  deviceId?: string;
  requestedAt?: string;
  expiresAt?: string;
  host?: NonNullable<HelloResult['host']>;
}

interface Inspection {
  findings: Finding[];
  machines: MachineReport[];
}

function note(title: string, detail: string, fix: string | null = null): Finding {
  return { code: 'device-host-machine', level: 'note', title, detail, fix };
}

export function configuredMachines(): string[] | null {
  const remote = loadConfig()?.remote;
  if (remote !== undefined && !isJsonObject(remote)) return null;
  const machines = remote?.machines;
  if (machines === undefined) return [];
  return acceptsShape(settingDefinition('remote.machines')!, machines) ? (machines as string[]) : null;
}

/**
 * The `remote.machines` entries this machine asked for device-host access, in setting order, without the ones the
 * tailnet reports as running another OS than macOS, which can never host; null when the setting is invalid.
 */
export async function hostingMachines(status?: () => unknown, signal?: AbortSignal): Promise<string[] | null> {
  const configured = configuredMachines();
  if (configured === null) return null;
  let candidates = configured;
  try {
    const asked = readDeviceHostMachines();
    candidates = configured.filter((machine) => asked.some((each) => each.machine === machine));
  } catch {
    candidates = configured;
  }
  if (!candidates.some((machine) => parseMachine(machine)?.transport === 'tailscale')) return candidates;
  const current = await (status ? status() : tailscaleStatusAsync(signal));
  signal?.throwIfAborted();
  return candidates.filter((machine) => !cannotHost(current, machine));
}

async function store(machines: DeviceHostMachineCredential[], operation?: StimContext): Promise<void> {
  reportSignal(operation)?.throwIfAborted();
  const write = () => {
    reportSignal(operation)?.throwIfAborted();
    const file = deviceHostMachinesFile();
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: MACHINE_CREDENTIALS_VERSION, machines }, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const options = { ensureParent: () => mkdirSync(getConfigDir(), { recursive: true }) };
  const signal = reportSignal(operation);
  if (signal) await withDirLockAsync(deviceHostMachinesLock(), write, { ...options, signal });
  else withDirLock(deviceHostMachinesLock(), write, options);
}

function notOnTailnet(
  machine: string,
  ambiguous: boolean,
  stored: DeviceHostMachineCredential | undefined,
  current: unknown,
) {
  const diagnosis = notOnTailnetDiagnosis(machine, ambiguous, stored ? wrongTailnet(stored, current) : null);
  return {
    diagnosis,
    report: {
      machine,
      state: 'not-on-tailnet' as const,
      ...(stored?.tailnet ? { tailnet: stored.tailnet } : {}),
      diagnosis,
    },
  };
}

/**
 * Reports the device-host approval of each remote machine, separate from its build approval. Only --fix makes a setup
 * ticket or forgets credentials; every server key stays pinned.
 */
export async function inspectDeviceHostMachines(
  {
    fix,
    version = '<version>',
    tickets = new Map(),
    operation,
    confirmKey,
  }: {
    fix: boolean;
    version?: string;
    tickets?: GeneratedTickets;
    operation?: StimContext;
    confirmKey?: KeyConfirmer;
  },
  io: TailnetMachineIo = realIo,
  entries: string[] | null = configuredMachines(),
): Promise<Inspection> {
  if (entries === null) {
    return {
      findings: [
        note(
          'Invalid remote.machines setting',
          'Use a remote object with machines as an array of tailnet names. Existing hosting credentials and pinned keys are preserved.',
          'Run `stim guide settings` and correct the setting before running doctor again.',
        ),
      ],
      machines: [],
    };
  }
  const unavailable = (state: MachineReport['state'], finding: Finding): Inspection => ({
    findings: [finding],
    machines: entries.map((machine) => ({ machine, state })),
  });
  const unreadable = () =>
    unavailable(
      'credentials-unavailable',
      note(
        'Hosting credentials are unreadable',
        `Stim preserves ${deviceHostMachinesFile()} and its pinned keys.`,
        'Restore the existing file from a trusted backup or restore read access before running doctor again.',
      ),
    );
  if (!entries.length) {
    if (!fix) return { findings: [], machines: [] };
    try {
      if (!readDeviceHostMachines().length) return { findings: [], machines: [] };
    } catch {
      return unreadable();
    }
  }
  const claim = tryAcquireClaim({
    root: deviceHostMachinesClaims(),
    mode: 'exclusive',
    label: 'device-host approval',
  });
  if (!claim.acquired) {
    releaseClaim(claim.pending);
    return unavailable(
      'busy',
      note(
        'Device-host approval is in use',
        'Another doctor run holds the hosting credential claim. Run doctor again after it finishes.',
      ),
    );
  }
  try {
    let credentials: DeviceHostMachineCredential[];
    try {
      credentials = readDeviceHostMachines();
    } catch {
      return unreadable();
    }
    if (fix) {
      const kept = credentials.filter((each) => entries.includes(each.machine));
      if (kept.length !== credentials.length) {
        await store(kept, operation);
        credentials = kept;
      }
    }
    if (!entries.length) return { findings: [], machines: [] };
    const tailnet = entries.some((entry) => parseMachine(entry)?.transport !== 'local');
    const status = tailnet ? await io.status() : null;
    const inspected: Inspection = { findings: [], machines: [] };
    let off: RemoteDiagnosis | null = null;
    if (tailnet && !isJsonObject(status)) {
      off = await diagnoseTailscale(io);
      inspected.findings.push(
        note('Remote machines are unreachable', `remote.machines names remote machines. ${off.message}`, off.remedy),
      );
    }
    const self = isJsonObject(status) && isJsonObject(status.Self) ? status.Self : {};
    const raw = typeof self.HostName === 'string' && self.HostName ? self.HostName : hostname();
    const deviceName =
      raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, 64) || 'Mac';
    const namedNodes = new Set<string>();
    for (const machine of new Set(entries)) {
      const parsed = parseMachine(machine);
      if (!parsed) {
        inspected.machines.push({ machine, state: 'invalid' });
        inspected.findings.push(
          note(
            `Remote machine ${machine} is not a tailnet name or local: address`,
            'Expected `name`, `name:port`, `local:<host>` or `local:<host>:port`.',
          ),
        );
        continue;
      }
      const local = parsed.transport === 'local';
      if (!local && off) {
        inspected.machines.push({ machine, state: 'tailscale-off', diagnosis: off });
        continue;
      }
      const current = local ? null : await io.status();
      if (!local && !isJsonObject(current)) {
        const diagnosis = await diagnoseTailscale(io);
        inspected.machines.push({ machine, state: 'tailscale-off', diagnosis });
        inspected.findings.push(diagnosisFinding('device-host-machine', machine, diagnosis));
        continue;
      }
      const peer = local ? null : findPeer(current, parsed.name);
      if (peer === 'missing' || peer === 'ambiguous') {
        const { report, diagnosis } = notOnTailnet(
          machine,
          peer === 'ambiguous',
          credentials.find((each) => each.machine === machine),
          current,
        );
        inspected.machines.push(report);
        inspected.findings.push(diagnosisFinding('device-host-machine', machine, diagnosis));
        continue;
      }
      const signedIn = local ? null : currentTailnet(current);
      const target = peer ? endpoint(peer, parsed.port) : localEndpoint(parsed.name, parsed.port);
      const dnsName = peer ? { dnsName: peer.dnsName } : {};
      const nodeRoute = peer ? `${peer.nodeId}:${parsed.port}` : `local:${parsed.name}:${parsed.port}`;
      if (namedNodes.has(nodeRoute)) {
        inspected.machines.push({ machine, ...dnsName, state: 'invalid' });
        inspected.findings.push(
          note(
            `Remote machine ${machine} repeats a named node`,
            'Name each tailnet node and serve port only once in remote.machines.',
          ),
        );
        continue;
      }
      namedNodes.add(nodeRoute);
      if (cannotHost(current, machine)) {
        inspected.machines.push({ machine, ...dnsName, state: 'not-asked' });
        continue;
      }
      const credential = credentials.find((each) => each.machine === machine);
      reportSignal(operation)?.throwIfAborted();
      const outcome = await reachMachine({
        machine,
        access: 'device-host',
        endpoint: target,
        address: peer?.dnsName ?? parsed.name,
        ...(signedIn ? { tailnet: signedIn } : {}),
        credential,
        other: () => readBuildMachines().find((each) => each.machine === machine),
        persist: async (next) => {
          credentials = [...credentials.filter((each) => each.machine !== machine), next];
          await store(credentials, operation);
        },
        fix,
        deviceName,
        setupFlags: ['build', 'device-host'],
        serverVersion: version,
        io,
        tickets,
        ...(local
          ? { confirmKey: (serverKey: string) => confirmKey?.(machine, serverKey) ?? Promise.resolve(false) }
          : {}),
      });
      reportSignal(operation)?.throwIfAborted();
      if (outcome.state !== 'not-asked' && outcome.credential) {
        const next = outcome.credential;
        if (JSON.stringify(next) !== JSON.stringify(credential)) {
          credentials = [...credentials.filter((each) => each.machine !== machine), next];
          await store(credentials, operation);
        }
      }
      const saved = outcome.state !== 'not-asked' ? outcome.credential : undefined;
      const known = {
        machine,
        ...dnsName,
        ...(saved?.deviceId ? { deviceId: saved.deviceId } : {}),
        ...(saved?.tailnet ? { tailnet: saved.tailnet } : {}),
        ...(saved ? { requestedAt: saved.requestedAt } : {}),
      };
      if (outcome.state === 'approved') {
        const host = readHostPermissions(outcome.result.host);
        if (host && (host.screenRecording === false || host.accessibility === false)) {
          const panes = [
            ...(host.screenRecording === false
              ? ['Screen & System Audio Recording (Screen Recording on macOS 14)']
              : []),
            ...(host.accessibility === false
              ? ['Device Control and Data Access (Accessibility on macOS 26 and earlier)']
              : []),
          ];
          const detail = [
            ...(host.screenRecording === false ? ['Viewing hosted macOS apps needs Screen Recording.'] : []),
            ...(host.accessibility === false ? ['Controlling them needs the control permission.'] : []),
          ];
          inspected.findings.push(
            note(
              `Remote Mac ${machine} needs ${panes.join(' and ')} for ${host.name}`,
              detail.join(' '),
              `On ${machine}, approve ${host.name} in System Settings > Privacy & Security, or run \`stim-server service install\` there again to show the requests.`,
            ),
          );
        }
        inspected.machines.push({ ...known, state: 'approved', ...(host ? { host } : {}) });
        continue;
      }
      if (outcome.state === 'pending') {
        inspected.machines.push({
          ...known,
          state: 'pending',
          ...(outcome.credential.expiresAt ? { expiresAt: outcome.credential.expiresAt } : {}),
        });
        inspected.findings.push(
          note(
            `Remote machine ${machine} has not approved this machine for device hosting yet`,
            `It does not hold this machine's setup ticket yet${outcome.credential.expiresAt ? `; the ticket expires at ${outcome.credential.expiresAt}` : ''}.`,
            setupRemedy(machine, outcome.command),
          ),
        );
        continue;
      }
      if (outcome.state === 'not-asked') {
        inspected.machines.push({ ...known, state: 'not-asked' });
        inspected.findings.push(
          note(
            `Remote machine ${machine} has not approved this machine for device hosting`,
            'This machine has not asked for hosting access.',
            'Run `stim doctor --fix` to make a setup ticket and print the command to run there.',
          ),
        );
        continue;
      }
      if (outcome.state === 'outdated') {
        const outdated = outdatedServer(machine, version, outcome.command);
        inspected.machines.push({
          ...known,
          state: 'outdated',
          diagnosis: {
            layer: 'compat',
            code: 'server-outdated',
            title: 'Server is outdated',
            message: outdated.detail,
            remedy: outdated.fix,
          },
        });
        inspected.findings.push(note(outdated.title, outdated.detail, outdated.fix));
        continue;
      }
      if (outcome.state === 'unconfirmed') {
        inspected.machines.push({ ...known, state: 'key-unconfirmed', fingerprint: outcome.fingerprint });
        inspected.findings.push(unconfirmedKeyFinding('device-host-machine', machine, outcome.fingerprint));
        continue;
      }
      if (outcome.state === 'unreachable') {
        const failure = {
          entry: machine,
          port: parsed.port,
          target,
          reason: outcome.reason,
          transport: outcome.transport,
        };
        const startup =
          !peer && outcome.transport?.kind === 'http' && outcome.transport.status === 503
            ? await io.startup?.(target)
            : null;
        const diagnosis = peer
          ? await diagnoseOutcome(io, { ...failure, peer })
          : diagnoseLocalUnreachable({ ...failure, startup });
        inspected.machines.push({ ...known, state: 'unreachable', diagnosis });
        inspected.findings.push(diagnosisFinding('device-host-machine', machine, diagnosis));
        continue;
      }
      inspected.machines.push({ ...known, state: outcome.state });
      inspected.findings.push(
        outcome.state === 'key-changed'
          ? note(
              `Remote machine ${machine} answered with a different server key`,
              'Stim refuses to connect to a stim-server that does not prove it holds the key pinned at approval.',
              `If that machine or its Stim home was replaced, remove ${machine} from remote.machines, run \`stim doctor --fix\`, then add it back and run \`stim doctor --fix\` again.`,
            )
          : outcome.state === 'lapsed'
            ? note(
                `Hosting request to ${machine} lapsed`,
                `${machine} did not approve this machine before its setup ticket expired at ${outcome.credential.expiresAt}.`,
                'Run `stim doctor --fix` to make a new ticket.',
              )
            : note(
                `Remote machine ${machine} no longer accepts this machine for device hosting`,
                `${outcome.reason} The pinned key is preserved.`,
                'Run `stim doctor --fix` to ask again.',
              ),
      );
    }
    return inspected;
  } finally {
    releaseClaim(claim.acquired);
  }
}
