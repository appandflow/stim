import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { HelloResult } from '@stim-cli/core/protocol';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  deviceHostMachinesClaims,
  deviceHostMachinesFile,
  deviceHostMachinesLock,
  acceptsShape,
  cannotHost,
  isJsonObject,
  MACHINE_CREDENTIALS_VERSION,
  readBuildMachines,
  readDeviceHostMachines,
  settingDefinition,
  type DeviceHostMachineCredential,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { withDirLock } from '../dir-lock.ts';
import { readHostPermissions } from '../offload/access-ticket.ts';
import {
  endpoint,
  findPeer,
  outdatedServer,
  parseMachine,
  reachMachine,
  realIo,
  setupRemedy,
  type GeneratedTickets,
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
    | 'not-asked'
    | 'pending'
    | 'approved'
    | 'revoked'
    | 'lapsed'
    | 'outdated'
    | 'unreachable'
    | 'credentials-unavailable'
    | 'busy';
  dnsName?: string;
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
export function hostingMachines(status: () => unknown = realIo.status): string[] | null {
  const configured = configuredMachines();
  if (configured === null) return null;
  let candidates = configured;
  try {
    const asked = readDeviceHostMachines();
    candidates = configured.filter((machine) => asked.some((each) => each.machine === machine));
  } catch {
    candidates = configured;
  }
  if (!candidates.length) return candidates;
  const current = status();
  return candidates.filter((machine) => !cannotHost(current, machine));
}

function store(machines: DeviceHostMachineCredential[]): void {
  withDirLock(
    deviceHostMachinesLock(),
    () => {
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
    },
    { ensureParent: () => mkdirSync(getConfigDir(), { recursive: true }) },
  );
}

/**
 * Reports the device-host approval of each remote machine, separate from its build approval. Only --fix makes a setup
 * ticket or forgets credentials; every server key stays pinned.
 */
export async function inspectDeviceHostMachines(
  { fix, version = '<version>', tickets = new Map() }: { fix: boolean; version?: string; tickets?: GeneratedTickets },
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
        store(kept);
        credentials = kept;
      }
    }
    if (!entries.length) return { findings: [], machines: [] };
    const status = io.status();
    if (!isJsonObject(status)) {
      return unavailable(
        'tailscale-off',
        note('Remote machines are unreachable', 'remote.machines names remote machines, but Tailscale is not running.'),
      );
    }
    const self = isJsonObject(status.Self) ? status.Self : {};
    const raw = typeof self.HostName === 'string' && self.HostName ? self.HostName : hostname();
    const deviceName =
      raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, 64) || 'Mac';
    const inspected: Inspection = { findings: [], machines: [] };
    const namedNodes = new Set<string>();
    for (const machine of new Set(entries)) {
      const parsed = parseMachine(machine);
      if (!parsed) {
        inspected.machines.push({ machine, state: 'invalid' });
        inspected.findings.push(
          note(`Remote machine ${machine} is not a tailnet name`, 'Expected `name` or `name:port`.'),
        );
        continue;
      }
      const current = io.status();
      if (!isJsonObject(current)) {
        inspected.machines.push({ machine, state: 'tailscale-off' });
        inspected.findings.push(
          note(`Remote machine ${machine} is unreachable`, 'Tailscale stopped before this connection.'),
        );
        continue;
      }
      const peer = findPeer(current, parsed.name);
      if (peer === 'missing' || peer === 'ambiguous') {
        inspected.machines.push({ machine, state: 'not-on-tailnet' });
        inspected.findings.push(
          note(
            `Remote machine ${machine} is not on this tailnet`,
            peer === 'missing' ? 'No peer has that name.' : 'Several peers match that name.',
          ),
        );
        continue;
      }
      const nodeRoute = `${peer.nodeId}:${parsed.port}`;
      if (namedNodes.has(nodeRoute)) {
        inspected.machines.push({ machine, dnsName: peer.dnsName, state: 'invalid' });
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
        inspected.machines.push({ machine, dnsName: peer.dnsName, state: 'not-asked' });
        continue;
      }
      const credential = credentials.find((each) => each.machine === machine);
      const outcome = await reachMachine({
        machine,
        access: 'device-host',
        endpoint: endpoint(peer, parsed.port),
        address: peer.dnsName,
        credential,
        other: () => readBuildMachines().find((each) => each.machine === machine),
        persist: (next) => {
          credentials = [...credentials.filter((each) => each.machine !== machine), next];
          store(credentials);
        },
        fix,
        deviceName,
        setupFlags: ['build', 'device-host'],
        serverVersion: version,
        io,
        tickets,
      });
      if (outcome.state !== 'not-asked' && outcome.credential) {
        const next = outcome.credential;
        if (JSON.stringify(next) !== JSON.stringify(credential)) {
          credentials = [...credentials.filter((each) => each.machine !== machine), next];
          store(credentials);
        }
      }
      const saved = outcome.state !== 'not-asked' ? outcome.credential : undefined;
      const known = {
        machine,
        dnsName: peer.dnsName,
        ...(saved?.deviceId ? { deviceId: saved.deviceId } : {}),
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
        inspected.machines.push({ ...known, state: 'outdated' });
        inspected.findings.push(note(outdated.title, outdated.detail, outdated.fix));
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
            : outcome.state === 'revoked'
              ? note(
                  `Remote machine ${machine} no longer accepts this machine for device hosting`,
                  `${outcome.reason} The pinned key is preserved.`,
                  'Run `stim doctor --fix` to ask again.',
                )
              : note(
                  `Remote machine ${machine} did not confirm hosting access`,
                  outcome.reason,
                  `Check stim-server and its tailnet serve route on ${machine}, then run doctor again.`,
                ),
      );
    }
    return inspected;
  } finally {
    releaseClaim(claim.acquired);
  }
}
