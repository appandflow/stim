import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '@stim-cli/core';
import {
  DEVICE_HOST_LIMITS,
  HOSTED_APP_CHUNK_BYTES,
  HOSTED_PARKED_CANDIDATES,
  hostedWorkerSettleMs,
  hostedMacosAppSlot,
  isJsonObject,
  readDeviceHostMachines,
  type DeviceHostMachineCredential,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { cancellableSleep, throwIfCancelled } from '../cancellation.ts';
import { BuildConnection } from '../offload/client.ts';
import {
  diagnoseConnectFailure,
  resolveEndpoint,
  SERVER_OUTDATED,
  type ConnectFailure,
  type Endpoint,
} from '../offload/tailnet.ts';
import { configuredMachines } from './machines.ts';

const CONNECT_TIMEOUT_MS = 10_000;
export const POLL_MS: number = 500;
export const HOSTED_POLL_MARGIN_MS: number = 45_000;
export const HOSTED_REQUEST_MARGIN_MS: number = 5_000;
const workerBoundMs = (deadlineMs: number): number => deadlineMs + hostedWorkerSettleMs();
export const SESSION_TIMEOUT_MS: number =
  hostedWorkerSettleMs() +
  workerBoundMs(DEVICE_HOST_LIMITS.logsMs) +
  2 * workerBoundMs(DEVICE_HOST_LIMITS.stopMs) +
  HOSTED_POLL_MARGIN_MS;
export const PREPARE_TIMEOUT_MS: number = workerBoundMs(DEVICE_HOST_LIMITS.prepareMs) + HOSTED_POLL_MARGIN_MS;
export const INSTALL_TIMEOUT_MS: number = workerBoundMs(DEVICE_HOST_LIMITS.prepareMs) + HOSTED_POLL_MARGIN_MS;
export const OFFER_TIMEOUT_MS: number = workerBoundMs(DEVICE_HOST_LIMITS.offerMs) + HOSTED_REQUEST_MARGIN_MS;
export const RESERVE_TIMEOUT_MS: number =
  HOSTED_PARKED_CANDIDATES * (workerBoundMs(DEVICE_HOST_LIMITS.offerMs) + workerBoundMs(DEVICE_HOST_LIMITS.stopMs)) +
  workerBoundMs(DEVICE_HOST_LIMITS.offerMs) +
  HOSTED_REQUEST_MARGIN_MS;

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

export const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function credentialRefusal(message: string, remedy = 'Run stim doctor.'): Error & { code: string; remedy: string } {
  return Object.assign(new Error(message), { code: 'STIM_HOSTING_REFUSED', remedy });
}

function hostingCredential(machine: string): DeviceHostMachineCredential {
  const configured = configuredMachines();
  if (configured === null)
    throw credentialRefusal(
      'remote.machines is invalid. Run stim guide settings and correct it.',
      'Run stim guide settings and correct remote.machines.',
    );
  if (!configured.includes(machine)) {
    throw Object.assign(
      new Error(
        `${machine} is not in remote.machines. Add it with stim settings set remote.machines, then run stim doctor --fix to ask it for hosting access.`,
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
      `This machine has not asked ${machine} for hosting access. Run stim doctor --fix.`,
      'Run stim doctor --fix.',
    );
  if (credential.state !== 'approved') {
    const remedy = `A person on ${machine} runs the stim-server setup command stim doctor --fix printed; then run stim doctor.`;
    throw credentialRefusal(`${machine} has not confirmed hosting access for this machine. ${remedy}`, remedy);
  }
  return credential;
}

function turnedAway(machine: string, opened: ConnectFailure): string | null {
  if (opened.code === SERVER_OUTDATED)
    return `${machine} runs a stim-server that speaks an older protocol than this Stim. Run stim doctor for the command that updates it there, then retry.`;
  if (opened.refused) return `${machine} refused this machine: ${opened.failure.replace(/\.+$/, '')}. Run stim doctor.`;
  return null;
}

/** Connects only to the stim-server that proves it holds the approved machine's pinned key, and only for `device-host`. */
export async function connectHost(
  machine: string,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
  strict = false,
  signal?: AbortSignal,
): Promise<HostConnection> {
  signal?.throwIfAborted();
  const credential = hostingCredential(machine);
  const target = await resolveEndpoint(credential, undefined, signal);
  signal?.throwIfAborted();
  if (typeof target === 'string')
    throw Object.assign(new Error(`Stim does not connect to ${machine}: ${target}.`), { code: 'STIM_HOSTING_REFUSED' });
  const opened = await BuildConnection.open(target, credential.serverKey!, timeoutMs, 'device-host', signal).catch(
    (error: unknown) => {
      throw Object.assign(
        new Error(`${machine} is unreachable. Run stim doctor to see which layer failed.`, {
          cause: error,
        }),
        { code: strict ? 'STIM_HOSTING_REFUSED' : 'closed' },
      );
    },
  );
  if (signal?.aborted && opened instanceof BuildConnection) opened.close();
  signal?.throwIfAborted();
  if (!(opened instanceof BuildConnection)) {
    const refusal = turnedAway(machine, opened);
    const diagnosis = refusal === null ? await diagnoseConnectFailure(machine, opened, signal) : null;
    throw Object.assign(
      new Error(
        refusal ??
          diagnosis?.message ??
          `${machine} is unreachable: ${opened.failure}. Run stim doctor to see which layer failed.`,
      ),
      {
        code: strict ? 'STIM_HOSTING_REFUSED' : opened.refused ? 'STIM_HOSTING_REFUSED' : (opened.code ?? 'closed'),
        hostCode: opened.code,
        ...(diagnosis ? { remedy: diagnosis.remedy } : {}),
      },
    );
  }
  return { machine, credential, connection: opened };
}

/**
 * Opens `device-host` connections to `machine` for a caller that retries on its own, as `connectHost` does but without
 * diagnosing failures, resolving the machine's address again only after one fails. Only a failure a retry cannot fix,
 * such as a refusal or a missing approval, carries a `STIM_` code; Tailscale not running or not listing the machine is
 * worth retrying.
 */
export function hostConnector(machine: string): () => Promise<BuildConnection> {
  let resolving: Promise<Endpoint | string> | undefined;
  return async () => {
    const credential = hostingCredential(machine);
    const pending = (resolving ??= resolveEndpoint(credential));
    const target = await pending.catch((error: unknown) => {
      if (resolving === pending) resolving = undefined;
      throw error;
    });
    if (typeof target === 'string') {
      if (resolving === pending) resolving = undefined;
      throw Object.assign(new Error(`Stim does not connect to ${machine}: ${target}.`), { code: 'closed' });
    }
    const opened = await BuildConnection.open(target, credential.serverKey!, CONNECT_TIMEOUT_MS, 'device-host').catch(
      (error: unknown): ConnectFailure => ({
        failure: error instanceof Error ? error.message : String(error),
        refused: false,
      }),
    );
    if (opened instanceof BuildConnection) return opened;
    const refusal = turnedAway(machine, opened);
    if (refusal !== null) throw credentialRefusal(refusal);
    if (resolving === pending) resolving = undefined;
    throw Object.assign(
      new Error(`${machine} is unreachable: ${opened.failure}. Run stim doctor to see which layer failed.`),
      { code: opened.code ?? 'closed' },
    );
  };
}

export function requireHostedAppMode(
  host: HostConnection,
  platform: 'ios' | 'android',
  mode?: HostedAppOffer['mode'],
): void {
  if (mode !== 'process') return;
  if (!host.connection.supports(platform === 'ios' ? 'hosted-ios-process' : 'hosted-android-process'))
    throw credentialRefusal(
      `${host.machine} does not support hosted ${platform} process apps.`,
      `Update stim-server on ${host.machine} to a version supporting hosted ${platform} process apps, then retry.`,
    );
}

export async function call(
  host: HostConnection,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const reply = await host.connection.request(method, params, timeoutMs);
  if ('error' in reply)
    throw Object.assign(new Error(`${host.machine} refused ${method}: ${reply.error.message}`), {
      code: reply.error.code,
    });
  if (!isJsonObject(reply.result)) throw new Error(`${host.machine} answered ${method} without a result.`);
  return reply.result;
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
  const key = JSON.stringify([configDir(), placement.machine, placement.session]);
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
  signal?: AbortSignal,
): Promise<HostedSession> {
  const deadline = Date.now() + timeoutMs;
  const what = `wait for hosted session ${session.id}`;
  while (passing.includes(session.state)) {
    throwIfCancelled(signal, what);
    if (Date.now() > deadline)
      throw new Error(`The hosted session ${session.id} on ${host.machine} stayed ${session.state}.`);
    await cancellableSleep(POLL_MS, { signal, what });
    session = await attach(host, session.id, undefined, platform);
  }
  return session;
}

const reason = (session: HostedSession): string => (session.notice ? `: ${session.notice.replace(/\.+$/, '')}` : '');

export function unknownSession(host: HostConnection, session: HostedSession): Error {
  return new Error(
    `The hosted session ${session.id} on ${host.machine} is in an unknown state${reason(session)}. Run stim stop to reconcile it.`,
  );
}

export function stoppedSession(host: HostConnection, session: HostedSession): Error {
  return new Error(
    `The hosted session ${session.id} on ${host.machine} stopped before it was ready${reason(session)}. Retry when the host can take it; it needs no stim stop.`,
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
