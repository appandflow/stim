import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import {
  deviceHostMachinesClaims,
  deviceHostMachinesFile,
  deviceHostMachinesLock,
  acceptsShape,
  isJsonObject,
  readDeviceHostMachines,
  settingDefinition,
  type DeviceHostMachineCredential,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { withDirLock } from '../dir-lock.ts';
import {
  endpoint,
  findPeer,
  parseMachine,
  realIo,
  type TailnetMachineIo,
  type TailnetPeer,
} from '../offload/tailnet.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';

interface MachineReport {
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
    | 'unreachable'
    | 'credentials-unavailable'
    | 'busy';
  dnsName?: string;
  deviceId?: string;
  requestedAt?: string;
}

interface Inspection {
  findings: Finding[];
  machines: MachineReport[];
}

function note(title: string, detail: string, fix: string | null = null): Finding {
  return { code: 'device-host-machine', level: 'note', title, detail, fix };
}

const approval = (machine: string, id: string) =>
  `A person on ${machine} approves it with \`stim-server devices grant ${id} --device-host\`.`;

export function configuredMachines(): string[] | null {
  const hosting = loadConfig()?.hosting;
  if (hosting !== undefined && !isJsonObject(hosting)) return null;
  const machines = hosting?.machines;
  if (machines === undefined) return [];
  return acceptsShape(settingDefinition('hosting.machines')!, machines) ? (machines as string[]) : null;
}

function store(machines: DeviceHostMachineCredential[]): void {
  withDirLock(
    deviceHostMachinesLock(),
    () => {
      const file = deviceHostMachinesFile();
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify({ version: 1, machines }, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    { ensureParent: () => mkdirSync(getConfigDir(), { recursive: true }) },
  );
}

async function request(
  machine: string,
  peer: TailnetPeer,
  port: number,
  deviceName: string,
  io: TailnetMachineIo,
): Promise<{ report: MachineReport; finding: Finding; credential?: DeviceHostMachineCredential }> {
  const reply = await io.hello(endpoint(peer, port), { request: 'device-host', deviceName });
  if (
    !('result' in reply) ||
    reply.result?.approval?.state !== 'pending' ||
    typeof reply.result.deviceToken !== 'string' ||
    !reply.result.deviceToken ||
    typeof reply.result.device?.id !== 'string' ||
    !reply.result.device.id ||
    typeof reply.result.approval.expiresAt !== 'string' ||
    !reply.result.approval.expiresAt
  ) {
    return {
      report: { machine, dnsName: peer.dnsName, state: 'unreachable' },
      finding: note(`Could not ask ${machine} for hosting access`, 'The worker did not return a pending request.'),
    };
  }
  const credential: DeviceHostMachineCredential = {
    machine,
    nodeId: peer.nodeId,
    dnsName: peer.dnsName,
    deviceId: reply.result.device.id,
    deviceToken: reply.result.deviceToken,
    state: 'pending',
    requestedAt: new Date().toISOString(),
  };
  return {
    report: {
      machine,
      dnsName: peer.dnsName,
      state: 'pending',
      deviceId: credential.deviceId,
      requestedAt: credential.requestedAt,
    },
    finding: note(
      `Asked ${machine} for hosting access`,
      `The request lapses at ${reply.result.approval.expiresAt}.`,
      approval(machine, credential.deviceId),
    ),
    credential,
  };
}

/** Reports separately approved hosting machines. Only --fix asks or forgets credentials; every token stays pinned. */
export async function inspectDeviceHostMachines(
  { fix }: { fix: boolean },
  io: TailnetMachineIo = realIo,
  entries: string[] | null = configuredMachines(),
): Promise<Inspection> {
  if (entries === null) {
    return {
      findings: [
        note(
          'Invalid hosting.machines setting',
          'Use a hosting object with machines as an array of tailnet names. Existing hosting credentials and pinned nodes are preserved.',
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
        `Stim preserves ${deviceHostMachinesFile()} and its pinned nodes.`,
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
    label: 'hosting machine approval',
  });
  if (!claim.acquired) {
    releaseClaim(claim.pending);
    return unavailable(
      'busy',
      note(
        'Hosting machine approval is in use',
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
        note(
          'Hosting machines are unreachable',
          'hosting.machines names hosting machines, but Tailscale is not running.',
        ),
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
          note(`Hosting machine ${machine} is not a tailnet name`, 'Expected `name` or `name:port`.'),
        );
        continue;
      }
      const current = io.status();
      if (!isJsonObject(current)) {
        inspected.machines.push({ machine, state: 'tailscale-off' });
        inspected.findings.push(
          note(`Hosting machine ${machine} is unreachable`, 'Tailscale stopped before this connection.'),
        );
        continue;
      }
      const peer = findPeer(current, parsed.name);
      if (peer === 'missing' || peer === 'ambiguous') {
        inspected.machines.push({ machine, state: 'not-on-tailnet' });
        inspected.findings.push(
          note(
            `Hosting machine ${machine} is not on this tailnet`,
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
            `Hosting machine ${machine} repeats a named node`,
            'Name each tailnet node and serve port only once in hosting.machines.',
          ),
        );
        continue;
      }
      namedNodes.add(nodeRoute);
      const credential = credentials.find((each) => each.machine === machine);
      const known = {
        machine,
        dnsName: peer.dnsName,
        ...(credential ? { deviceId: credential.deviceId, requestedAt: credential.requestedAt } : {}),
      };
      if (credential && credential.nodeId !== peer.nodeId) {
        inspected.machines.push({ ...known, state: 'node-changed' });
        inspected.findings.push(
          note(
            `Hosting machine ${machine} is a different tailnet node`,
            'Stim refuses to connect or send the saved token.',
            `If that Mac was replaced, remove ${machine} from hosting.machines, run \`stim doctor --fix\`, then add it back and run \`stim doctor --fix\` again to request approval on the new node.`,
          ),
        );
        continue;
      }
      let ask = !credential && fix;
      if (credential) {
        const reply = await io.hello(endpoint(peer, parsed.port), { deviceToken: credential.deviceToken });
        if (
          'result' in reply &&
          reply.result?.device?.id === credential.deviceId &&
          Array.isArray(reply.result.capabilities) &&
          reply.result.capabilities.includes('device-host')
        ) {
          if (credential.state !== 'approved') {
            credentials = credentials.map((each) => (each.machine === machine ? { ...each, state: 'approved' } : each));
            store(credentials);
          }
          const host = reply.result.host;
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
                `Hosting machine ${machine} needs ${panes.join(' and ')} for ${host.name}`,
                detail.join(' '),
                `On ${machine}, approve ${host.name} in System Settings > Privacy & Security, or run \`stim-server service install\` there again to show the requests.`,
              ),
            );
          }
          inspected.machines.push({ ...known, state: 'approved' });
          continue;
        }
        if ('error' in reply && reply.error?.code === 'approval-pending') {
          inspected.machines.push({ ...known, state: 'pending' });
          inspected.findings.push(
            note(
              `Hosting machine ${machine} has not approved this Mac yet`,
              `Requested at ${credential.requestedAt}.`,
              approval(machine, credential.deviceId),
            ),
          );
          continue;
        }
        const revoked = 'error' in reply && reply.error?.code === 'unauthorized';
        ask = revoked && fix;
        if (!ask) {
          inspected.machines.push({ ...known, state: revoked ? 'revoked' : 'unreachable' });
          inspected.findings.push(
            note(
              `Hosting machine ${machine} ${revoked ? 'no longer accepts this Mac' : 'did not confirm hosting access'}`,
              'The saved token and pinned node are preserved.',
              revoked
                ? 'Run `stim doctor --fix` to ask again.'
                : `Check stim-server and its tailnet serve route on ${machine}, then run doctor again.`,
            ),
          );
          continue;
        }
      }
      if (ask) {
        const result = await request(machine, peer, parsed.port, deviceName, io);
        if (result.credential) {
          credentials = [...credentials.filter((each) => each.machine !== machine), result.credential];
          store(credentials);
        }
        inspected.machines.push(result.report);
        inspected.findings.push(result.finding);
      } else {
        inspected.machines.push({ ...known, state: 'not-asked' });
        inspected.findings.push(
          note(
            `Hosting machine ${machine} has not approved this Mac`,
            'This Mac has not asked for hosting access.',
            'Run `stim doctor --fix` to ask.',
          ),
        );
      }
    }
    return inspected;
  } finally {
    releaseClaim(claim.acquired);
  }
}
