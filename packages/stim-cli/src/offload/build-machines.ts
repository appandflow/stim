import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import {
  buildMachinesFile,
  buildMachinesLock,
  isJsonObject,
  readBuildMachines,
  type BuildMachineCredential,
} from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { withDirLock } from '../dir-lock.ts';
import { getExecutor } from '../exec.ts';
import { getConfigDir, loadConfig } from '../workspace/config.ts';

const DEFAULT_SERVE_PORT = 7443;
const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;

export interface TailnetPeer {
  nodeId: string;
  dnsName: string;
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
  hello: (url: string, auth: Record<string, string>) => Promise<HelloReply>;
}

/** Splits an `offload.machines` entry, `name` or `name:port`. */
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
    return dnsName === name || dnsName.startsWith(`${name}.`) ? [{ nodeId: peer.ID, dnsName }] : [];
  });
  if (found.length === 0) return 'missing';
  return found.length === 1 ? found[0]! : 'ambiguous';
}

function endpoint(peer: TailnetPeer, port: number): string {
  return port === 443 ? `wss://${peer.dnsName}` : `wss://${peer.dnsName}:${port}`;
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

function hello(url: string, auth: Record<string, string>): Promise<HelloReply> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { handshakeTimeout: HELLO_TIMEOUT_MS });
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

function note(title: string, detail: string, fix: string | null = null): Finding {
  return { code: 'build-machine', level: 'note', title, detail, fix };
}

const approval = (entry: string, deviceId: string) =>
  `A person on ${entry} approves it with \`stim-server devices grant ${deviceId} --build\`.`;

async function requestAccess(
  entry: string,
  peer: TailnetPeer,
  port: number,
  deviceName: string,
  io: BuildMachineIo,
): Promise<Finding> {
  const reply = await io.hello(endpoint(peer, port), { request: 'build', deviceName });
  if (!('result' in reply) || !reply.result.approval || !reply.result.deviceToken) {
    const reason = 'failed' in reply ? reply.failed : 'error' in reply ? reply.error.message : 'it granted no request';
    return note(`Could not ask ${entry} for build access`, reason);
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
  return note(
    `Asked ${entry} for build access`,
    `The request lapses at ${reply.result.approval.expiresAt}.`,
    approval(entry, credential.deviceId),
  );
}

/**
 * Doctor findings for each `offload.machines` entry. The worker's node is pinned when access is requested; a
 * later connection goes only to the current MagicDNS name of that same node, checked before the token is sent.
 * With `fix`, requests access from a named machine this Mac holds no pairing for, requests again when the
 * pinned node forgot this Mac, and forgets pairings of machines no longer named.
 */
export async function inspectBuildMachines(
  { fix }: { fix: boolean },
  io: BuildMachineIo = realIo,
  entries: string[] = configuredMachines(),
): Promise<Finding[]> {
  const unnamed = (each: BuildMachineCredential) => !entries.includes(each.machine);
  if (fix && readBuildMachines().some(unnamed)) {
    updateCredentials((credentials) => credentials.filter((each) => !unnamed(each)));
  }
  if (entries.length === 0) return [];
  const status = io.status();
  if (!isJsonObject(status)) {
    return [
      note('Build machines are unreachable', 'offload.machines names build machines, but Tailscale is not running.'),
    ];
  }
  const self = isJsonObject(status.Self) ? status.Self : {};
  const deviceName = typeof self.HostName === 'string' && self.HostName ? self.HostName : hostname();
  const findings: Finding[] = [];
  for (const entry of entries) {
    const parsed = parseMachine(entry);
    if (!parsed) {
      findings.push(note(`Build machine ${entry} is not a tailnet name`, 'Expected `name` or `name:port`.'));
      continue;
    }
    const peer = findPeer(status, parsed.name);
    if (peer === 'missing' || peer === 'ambiguous') {
      const detail = peer === 'missing' ? 'No peer on this tailnet has that name.' : 'Several peers match that name.';
      findings.push(note(`Build machine ${entry} is not on this tailnet`, detail));
      continue;
    }
    const credential = readBuildMachines().find((each) => each.machine === entry);
    if (credential && credential.nodeId !== peer.nodeId) {
      findings.push(
        note(
          `Build machine ${entry} is a different tailnet node`,
          `This Mac paired with node ${credential.nodeId}, but ${peer.dnsName} is now node ${peer.nodeId}. Stim does not connect to it.`,
          `If that Mac was replaced, remove ${entry} from offload.machines, run \`stim doctor --fix\` to forget the old pairing, then add it back and run \`stim doctor --fix\` again.`,
        ),
      );
      continue;
    }
    if (!credential) {
      findings.push(
        fix
          ? await requestAccess(entry, peer, parsed.port, deviceName, io)
          : note(
              `Build machine ${entry} has not approved this Mac`,
              'This Mac has not asked it for build access.',
              'Run `stim doctor --fix` to ask.',
            ),
      );
      continue;
    }
    const reply = await io.hello(endpoint(peer, parsed.port), { deviceToken: credential.deviceToken });
    if ('result' in reply && reply.result.capabilities.includes('build')) {
      if (credential.state !== 'approved') {
        updateCredentials((credentials) =>
          credentials.map((each) => (each.machine === entry ? { ...each, state: 'approved' } : each)),
        );
      }
      continue;
    }
    if ('error' in reply && reply.error.code === 'approval-pending') {
      findings.push(
        note(
          `Build machine ${entry} has not approved this Mac yet`,
          `Requested at ${credential.requestedAt}.`,
          approval(entry, credential.deviceId),
        ),
      );
      continue;
    }
    if ('error' in reply && reply.error.code === 'unauthorized') {
      findings.push(
        fix
          ? await requestAccess(entry, peer, parsed.port, deviceName, io)
          : note(
              `Build machine ${entry} no longer accepts this Mac`,
              `${reply.error.message} It was revoked, or the request lapsed before approval.`,
              'Run `stim doctor --fix` to ask again.',
            ),
      );
      continue;
    }
    const reason = 'failed' in reply ? reply.failed : 'error' in reply ? reply.error.message : 'unexpected reply';
    findings.push(note(`Could not reach build machine ${entry}`, reason));
  }
  return findings;
}
