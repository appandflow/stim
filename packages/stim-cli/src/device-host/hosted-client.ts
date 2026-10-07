import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOSTED_APP_CHUNK_BYTES,
  hostedMacosAppSlot,
  isJsonObject,
  readDeviceHostMachines,
  type DeviceHostMachineCredential,
} from '@stim-cli/core/state';
import { BuildConnection } from '../offload/client.ts';
import { pinnedEndpoint } from '../offload/tailnet.ts';
import { configuredMachines } from './machines.ts';

const CONNECT_TIMEOUT_MS = 10_000;
export const POLL_MS: number = 500;
/** Covers 90s stop + 15s final logs + three 10s worker group-settle bounds, with 45s for polling and transport. */
export const SESSION_TIMEOUT_MS: number = 90_000 + 15_000 + 3 * 10_000 + 45_000;
export const INSTALL_TIMEOUT_MS: number = 5 * 60_000;

interface ManifestFile {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

export interface HostedSession {
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

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
export const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function credentialRefusal(message: string, remedy = 'Run stim doctor.'): Error & { code: string; remedy: string } {
  return Object.assign(new Error(message), { code: 'STIM_HOSTING_REFUSED', remedy });
}

function hostingCredential(machine: string): DeviceHostMachineCredential {
  const configured = configuredMachines();
  if (configured === null)
    throw credentialRefusal(
      'hosting.machines is invalid. Run stim guide settings and correct it.',
      'Run stim guide settings and correct hosting.machines.',
    );
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
    throw credentialRefusal('The hosting credentials are unreadable. Run stim doctor.');
  }
  const credential = credentials.find((each) => each.machine === machine);
  if (!credential)
    throw credentialRefusal(
      `This Mac has not asked ${machine} for hosting access. Run stim doctor --fix.`,
      'Run stim doctor --fix.',
    );
  if (credential.state !== 'approved') {
    const remedy = `A person on ${machine} approves it with stim-server devices grant ${credential.deviceId} --device-host; then run stim doctor.`;
    throw credentialRefusal(`${machine} has not confirmed hosting access for this Mac. ${remedy}`, remedy);
  }
  return credential;
}

/** Connects only to the pinned node of an approved hosting machine, and only when it grants `device-host`. */
export async function connectHost(
  machine: string,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
  strict = false,
): Promise<HostConnection> {
  const credential = hostingCredential(machine);
  const target = pinnedEndpoint(credential);
  if (typeof target === 'string')
    throw Object.assign(new Error(`Stim does not connect to ${machine}: ${target}.`), { code: 'STIM_HOSTING_REFUSED' });
  const opened = await BuildConnection.open(target, credential.deviceToken, timeoutMs, 'device-host').catch(
    (error: unknown) => {
      throw Object.assign(
        new Error(`${machine} is unreachable. Check stim-server and its tailnet serve route on ${machine}.`, {
          cause: error,
        }),
        { code: strict ? 'STIM_HOSTING_REFUSED' : 'closed' },
      );
    },
  );
  if (!(opened instanceof BuildConnection)) {
    throw Object.assign(
      new Error(
        opened.refused
          ? `${machine} refused this Mac: ${opened.failure.replaceAll(credential.deviceToken, '[redacted]').replace(/\.+$/, '')}. Run stim doctor.`
          : `${machine} is unreachable: ${opened.failure.replaceAll(credential.deviceToken, '[redacted]')}. Check stim-server and its tailnet serve route on ${machine}.`,
      ),
      {
        code: strict ? 'STIM_HOSTING_REFUSED' : opened.refused ? 'STIM_HOSTING_REFUSED' : (opened.code ?? 'closed'),
        hostCode: opened.code,
      },
    );
  }
  return { machine, credential, connection: opened };
}

const gatewaySecrets = new WeakMap<HostConnection, string>();

function redactHostText(host: HostConnection, message: string): string {
  for (const secret of [host.credential.deviceToken, gatewaySecrets.get(host)]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message;
}

export async function call(
  host: HostConnection,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  if (method === 'device-host.metro.open' && isJsonObject(params) && typeof params.secret === 'string')
    gatewaySecrets.set(host, params.secret);
  const reply = await host.connection.request(method, params, timeoutMs);
  if ('error' in reply)
    throw Object.assign(new Error(`${host.machine} refused ${method}: ${redactHostText(host, reply.error.message)}`), {
      code: reply.error.code,
    });
  if (!isJsonObject(reply.result)) throw new Error(`${host.machine} answered ${method} without a result.`);
  return typeof reply.result.notice === 'string'
    ? { ...reply.result, notice: redactHostText(host, reply.result.notice) }
    : reply.result;
}

export function hostedSession(
  host: HostConnection,
  value: Record<string, unknown>,
  platform: 'ios' | 'android' | 'macos' = 'macos',
): HostedSession {
  if (typeof value.id !== 'string' || typeof value.state !== 'string' || value.platform !== platform) {
    throw new Error(`${host.machine} answered with a session that is not a hosted ${platform} session.`);
  }
  return {
    id: value.id,
    state: value.state,
    device: value.device,
    ...(hostedMacosAppSlot(value.appSlot) ? { appSlot: value.appSlot } : {}),
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
  };
}

export const heldNoLonger = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'unknown-session';

export async function attach(
  host: HostConnection,
  session: string,
  timeoutMs?: number,
  platform: 'ios' | 'android' | 'macos' = 'macos',
): Promise<HostedSession> {
  return hostedSession(host, await call(host, 'device-host.attach', { session }, timeoutMs), platform);
}

export type HostedSessionProbe =
  | { state: 'ready' }
  | { state: 'stopped' }
  | { state: 'unknown'; notice?: string }
  | { state: 'unreachable'; reason: string };

interface ProbeOptions {
  timeoutMs?: number;
  ttlMs?: number;
}

const probeCache = new Map<string, { expiresAt: number; promise: Promise<HostedSessionProbe> }>();

export function probeHostedSession(
  placement: { machine: string; session: string; device?: unknown; platform?: 'ios' | 'android' },
  { timeoutMs = 3000, ttlMs = 10_000 }: ProbeOptions = {},
): Promise<HostedSessionProbe> {
  const key = JSON.stringify([placement.machine, placement.session]);
  const cached = probeCache.get(key);
  if (ttlMs > 0 && cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = probeSession(placement, timeoutMs);
  if (ttlMs > 0) {
    const entry = { expiresAt: Infinity, promise };
    probeCache.delete(key);
    probeCache.set(key, entry);
    if (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value!);
    void promise.then((result) => {
      entry.expiresAt = Date.now() + ttlMs;
      return result;
    });
  }
  return promise;
}

async function probeSession(
  placement: { machine: string; session: string; device?: unknown; platform?: 'ios' | 'android' },
  timeoutMs: number,
): Promise<HostedSessionProbe> {
  let host: HostConnection | undefined;
  try {
    host = await connectHost(placement.machine, timeoutMs);
    const session = await attach(
      host,
      placement.session,
      timeoutMs,
      placement.platform ??
        (placement.device === undefined
          ? 'macos'
          : isJsonObject(placement.device) && 'avdName' in placement.device
            ? 'android'
            : 'ios'),
    );
    if (session.state === 'ready' || session.state === 'stopped') return { state: session.state };
    return {
      state: 'unknown',
      notice:
        session.state === 'unknown'
          ? session.notice
          : `The hosted session ${session.id} on ${host.machine} is ${session.state}.${session.notice ? ` ${session.notice}` : ''}`,
    };
  } catch (error) {
    if (heldNoLonger(error)) return { state: 'stopped' };
    return { state: 'unreachable', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    host?.connection.close();
  }
}

export async function settle(
  host: HostConnection,
  session: HostedSession,
  passing: string[],
  timeoutMs: number,
  platform: 'ios' | 'android' | 'macos' = 'macos',
): Promise<HostedSession> {
  const deadline = Date.now() + timeoutMs;
  while (passing.includes(session.state)) {
    if (Date.now() > deadline)
      throw new Error(`The hosted session ${session.id} on ${host.machine} stayed ${session.state}.`);
    await sleep(POLL_MS);
    session = await attach(host, session.id, undefined, platform);
  }
  return session;
}

export function unknownSession(host: HostConnection, session: HostedSession): Error {
  return new Error(
    `The hosted session ${session.id} on ${host.machine} is in an unknown state${session.notice ? `: ${session.notice}` : ''}. Run stim stop to reconcile it.`,
  );
}

export function bundleManifest(bundle: string): { files: ManifestFile[]; content: Map<string, () => Buffer> } {
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

export async function upload(
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
