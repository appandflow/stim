import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  HOSTED_APP_CHUNK_BYTES,
  hostedMacosAppSlot,
  hostedMacosBundleId,
  isJsonObject,
  parseHostedAgentGrant,
  parseHostedMacosDevice,
  readDeviceHostMachines,
  type DeviceHostMachineCredential,
  type HostedAgentAccess,
  type HostedMacosPlacement,
} from '@stim-cli/core/state';
import { macosDir } from '../macos/state.ts';
import { BuildConnection } from '../offload/client.ts';
import { parseMachine, pinnedEndpoint } from '../offload/tailnet.ts';
import { configuredMachines } from './machines.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const POLL_MS = 500;
const SESSION_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

interface ManifestFile {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

interface HostedSession {
  id: string;
  state: string;
  device: unknown;
  appSlot?: number;
  notice?: string;
}

export interface HostConnection {
  machine: string;
  credential: DeviceHostMachineCredential;
  connection: BuildConnection;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** The approved hosting credential for `machine`; anything else refuses before any connection. */
function hostingCredential(machine: string): DeviceHostMachineCredential {
  const configured = configuredMachines();
  if (configured === null) throw new Error('hosting.machines is invalid. Run stim guide settings and correct it.');
  if (!configured.includes(machine)) {
    throw Object.assign(
      new Error(
        `${machine} is not in hosting.machines. Add it with stim settings set hosting.machines, then run stim doctor --fix to ask it for hosting access.`,
      ),
      { code: 'STIM_BAD_ARG' },
    );
  }
  let credentials: DeviceHostMachineCredential[];
  try {
    credentials = readDeviceHostMachines();
  } catch {
    throw new Error('The hosting credentials are unreadable. Run stim doctor.');
  }
  const credential = credentials.find((each) => each.machine === machine);
  if (!credential) throw new Error(`This Mac has not asked ${machine} for hosting access. Run stim doctor --fix.`);
  if (credential.state !== 'approved') {
    throw new Error(
      `${machine} has not confirmed hosting access for this Mac. A person on ${machine} approves it with stim-server devices grant ${credential.deviceId} --device-host; then run stim doctor.`,
    );
  }
  return credential;
}

/** Connects only to the pinned node of an approved hosting machine, and only when it grants `device-host`. */
export async function connectHost(machine: string): Promise<HostConnection> {
  const credential = hostingCredential(machine);
  const target = pinnedEndpoint(credential);
  if (typeof target === 'string') throw new Error(`Stim does not connect to ${machine}: ${target}.`);
  const opened = await BuildConnection.open(target, credential.deviceToken, CONNECT_TIMEOUT_MS, 'device-host');
  if (!(opened instanceof BuildConnection)) {
    throw new Error(
      opened.refused
        ? `${machine} refused this Mac: ${opened.failure}. Run stim doctor.`
        : `${machine} is unreachable: ${opened.failure}. Check stim-server and its tailnet serve route on ${machine}.`,
    );
  }
  return { machine, credential, connection: opened };
}

async function call(host: HostConnection, method: string, params: unknown): Promise<Record<string, unknown>> {
  const reply = await host.connection.request(method, params);
  if ('error' in reply) throw new Error(`${host.machine} refused ${method}: ${reply.error.message}`);
  if (!isJsonObject(reply.result)) throw new Error(`${host.machine} answered ${method} without a result.`);
  return reply.result;
}

function hostedSession(host: HostConnection, value: Record<string, unknown>): HostedSession {
  if (typeof value.id !== 'string' || typeof value.state !== 'string' || value.platform !== 'macos') {
    throw new Error(`${host.machine} answered with a session that is not a hosted macOS session.`);
  }
  return {
    id: value.id,
    state: value.state,
    device: value.device,
    ...(hostedMacosAppSlot(value.appSlot) ? { appSlot: value.appSlot } : {}),
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
  };
}

async function attach(host: HostConnection, session: string): Promise<HostedSession> {
  return hostedSession(host, await call(host, 'device-host.attach', { session }));
}

async function settle(
  host: HostConnection,
  session: HostedSession,
  passing: string[],
  timeoutMs: number,
): Promise<HostedSession> {
  const deadline = Date.now() + timeoutMs;
  while (passing.includes(session.state)) {
    if (Date.now() > deadline)
      throw new Error(`The hosted session ${session.id} on ${host.machine} stayed ${session.state}.`);
    await sleep(POLL_MS);
    session = await attach(host, session.id);
  }
  return session;
}

function unknownSession(host: HostConnection, session: HostedSession): Error {
  return new Error(
    `The hosted session ${session.id} on ${host.machine} is in an unknown state${session.notice ? `: ${session.notice}` : ''}. Run stim stop to reconcile it.`,
  );
}

/** Every file and link of an `.app` bundle, relative to it, as the host's app manifest names them. */
function bundleManifest(bundle: string): { files: ManifestFile[]; content: Map<string, () => Buffer> } {
  const files: ManifestFile[] = [];
  const content = new Map<string, () => Buffer>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      let read: () => Buffer;
      let kind: ManifestFile['kind'];
      if (stat.isDirectory()) {
        walk(absolute, path);
        continue;
      } else if (stat.isSymbolicLink()) {
        read = () => Buffer.from(readlinkSync(absolute));
        kind = 'link';
      } else if (stat.isFile()) {
        read = () => readFileSync(absolute);
        kind = stat.mode & 0o111 ? 'exec' : 'file';
      } else continue;
      const bytes = read();
      const digest = sha256(bytes);
      files.push({ path, kind, size: bytes.length, sha256: digest });
      content.set(digest, read);
    }
  };
  walk(bundle, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, content };
}

async function upload(
  host: HostConnection,
  ids: { session: string; attempt: string },
  missing: unknown,
  content: Map<string, () => Buffer>,
): Promise<void> {
  if (!Array.isArray(missing))
    throw new Error(`${host.machine} answered device-host.app.offer without missing content.`);
  for (const entry of missing) {
    const read = isJsonObject(entry) && typeof entry.sha256 === 'string' ? content.get(entry.sha256) : undefined;
    if (!read || !isJsonObject(entry) || typeof entry.offset !== 'number') {
      throw new Error(`${host.machine} asked for content this app does not have.`);
    }
    const bytes = read();
    let offset = entry.offset;
    do {
      const data = bytes.subarray(offset, offset + HOSTED_APP_CHUNK_BYTES).toString('base64');
      const next = (await call(host, 'device-host.app.chunk', { ...ids, sha256: entry.sha256, offset, data })).offset;
      if (typeof next !== 'number' || (next <= offset && next !== bytes.length)) {
        throw new Error(`${host.machine} did not accept app content at byte ${offset}.`);
      }
      offset = next;
    } while (offset < bytes.length);
  }
}

export const agentRemoteConfig = (root: string): string => join(macosDir(root), 'agent-device-remote.json');

/** Turns the host's grant into what a coding agent uses; a token only ever lands in a 0600 file. */
function agentAccess(root: string, credential: DeviceHostMachineCredential, grant: unknown): HostedAgentAccess {
  const parsed = grant === undefined ? null : parseHostedAgentGrant(grant);
  const file = agentRemoteConfig(root);
  if (!parsed || parsed.driver === 'none') {
    rmSync(file, { force: true });
    return { driver: 'none', setting: 'hosting.agentDriver' };
  }
  const port = parseMachine(credential.machine)?.port ?? 443;
  const config = {
    daemonBaseUrl: `https://${credential.dnsName}${port === 443 ? '' : `:${port}`}${parsed.path}`,
    daemonAuthToken: parsed.token,
    leaseId: parsed.scope,
    platform: 'macos',
  };
  mkdirSync(macosDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { driver: 'agent-device', remoteConfig: file, command: `agent-device <command> --remote-config ${file}` };
}

export interface HostedMacosRun {
  placement: HostedMacosPlacement;
  launched: boolean;
}

/**
 * Places a staged `.app` on `host`: reuses the recorded session when the host still holds it ready, else reserves one,
 * then delivers the bundle as a new app attempt, launches it and waits for the host to report it installed. `reserved`
 * records the placement as soon as a session exists, so `stim stop` can find it even if delivery fails.
 */
export async function placeHostedMacos(
  host: HostConnection,
  {
    root,
    bundle,
    bundleId,
    recorded,
    reserved,
    note,
  }: {
    root: string;
    bundle: string;
    bundleId: string;
    recorded: HostedMacosPlacement | undefined;
    reserved: (placement: HostedMacosPlacement) => void;
    note: (line: string) => void;
  },
): Promise<HostedMacosRun> {
  let session: HostedSession | null = null;
  if (recorded) {
    session = await settle(host, await attach(host, recorded.session), ['preparing', 'stopping'], SESSION_TIMEOUT_MS);
    if (session.state === 'unknown') throw unknownSession(host, session);
    if (session.state === 'stopped') session = null;
  }
  if (!session) {
    note(`Reserving a macOS session on ${host.machine}`);
    session = hostedSession(
      host,
      await call(host, 'device-host.reserve', {
        workspace: root,
        slot: 'default',
        attempt: randomUUID(),
        platform: 'macos',
      }),
    );
  }
  session = await settle(host, session, ['preparing'], SESSION_TIMEOUT_MS);
  if (session.state === 'unknown') throw unknownSession(host, session);
  if (session.state !== 'ready')
    throw new Error(`The hosted session ${session.id} on ${host.machine} is ${session.state}.`);
  const device = parseHostedMacosDevice(session.device);
  if (!device || (session.appSlot !== undefined && device.appSlot !== session.appSlot)) {
    throw new Error(`${host.machine} reported a ready session without a macOS app slot.`);
  }
  const appAttempt = randomUUID();
  const placement: HostedMacosPlacement = {
    machine: host.machine,
    session: session.id,
    appSlot: device.appSlot,
    appAttempt,
    bundleId: hostedMacosBundleId(bundleId, device.appSlot),
    agent: { driver: 'none', setting: 'hosting.agentDriver' },
  };
  reserved(placement);
  const { files, content } = bundleManifest(bundle);
  const manifest = Buffer.from(JSON.stringify(files));
  content.set(sha256(manifest), () => manifest);
  const ids = { session: session.id, attempt: appAttempt };
  const offer = { ...ids, bundleId, mode: 'release', manifest: { sha256: sha256(manifest), size: manifest.length } };
  note(`Delivering ${files.length} files to ${host.machine} (macOS ${device.macosVersion}, ${device.architecture})`);
  await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
  await upload(host, ids, (await call(host, 'device-host.app.offer', offer)).missing, content);
  note(`Launching on ${host.machine}`);
  let delivery = await call(host, 'device-host.app.launch', ids);
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (delivery.state !== 'installed') {
    if (delivery.state === 'unknown') {
      throw new Error(
        `${host.machine} could not install or launch the app${typeof delivery.notice === 'string' ? `: ${delivery.notice}` : ''}.`,
      );
    }
    if (Date.now() > deadline) throw new Error(`${host.machine} did not finish installing the app.`);
    await sleep(POLL_MS);
    delivery = await call(host, 'device-host.app.attach', ids);
  }
  if (typeof delivery.notice === 'string') note(delivery.notice);
  return {
    placement: { ...placement, agent: agentAccess(root, host.credential, delivery.agent) },
    launched: delivery.launched === true,
  };
}

/** Stops a recorded hosted session and waits until the host confirms it stopped; anything else is a failure. */
export async function stopHostedMacos(root: string, placement: HostedMacosPlacement): Promise<void> {
  const host = await connectHost(placement.machine);
  try {
    let session = hostedSession(host, await call(host, 'device-host.stop', { session: placement.session }));
    session = await settle(host, session, ['stopping'], SESSION_TIMEOUT_MS);
    if (session.state !== 'stopped') throw unknownSession(host, session);
  } finally {
    host.connection.close();
  }
  rmSync(agentRemoteConfig(root), { force: true });
}
