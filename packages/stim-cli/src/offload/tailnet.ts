import type { StimContext } from '@stim-cli/core';
import { reportSignal, trackReportResource } from '../report-runtime.ts';
import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
  HandshakeRefusal,
  initiateNoise,
  MAX_SERVER_MESSAGE_BYTES,
  TRANSPORT_OVERHEAD_BYTES,
  decodeSecret,
  newSecret,
  type NoiseSocket,
} from '@stim-cli/core/noise-session';
import {
  clientIdentity,
  isJsonObject,
  machineEndpoint,
  parseMachine,
  type Endpoint,
  type MachineCredential,
} from '@stim-cli/core/state';
export { parseMachine, findPeer, endpoint, type Endpoint } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readAccessTicket } from './access-ticket.ts';

const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;
/** How long a setup ticket `stim doctor --fix` generates stays valid; `stim-server setup` takes at most 2 hours. */
const GENERATED_TICKET_MS = 2 * 60 * 60_000 - 60_000;

export type Access = 'build' | 'device-host';

/**
 * How this machine proves itself to a remote stim-server: as a returning client that pins `serverKey`, or on first
 * contact with the setup ticket the worker's `stim-server setup` approved. Both use this machine's client key.
 */
export type MachineAuth =
  | { access: Access; serverKey: string }
  | {
      access: Access;
      ticket: string;
      name: string;
      /** Runs once the ticket's handshake authenticated the server key, before `hello`, so a lost reply can recover. */
      onServerKey?: (serverKey: string) => void;
    };

export type HelloReply =
  | {
      result: {
        host?: { name: string; screenRecording: boolean; accessibility: boolean } | null;
        capabilities: string[];
        features?: string[];
        device: { id: string; name: string };
      };
      /** The server key the handshake authenticated. */
      serverKey: string;
    }
  | { error: { code: string; message: string } }
  | { failed: string };

export interface TailnetMachineIo {
  /** `tailscale status --json`, or null when Tailscale is not running. */
  status: () => unknown;
  hello: (endpoint: Endpoint, auth: MachineAuth) => Promise<HelloReply>;
}

function parseTailscaleStatus(output: string): unknown {
  try {
    const status = JSON.parse(output) as unknown;
    return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
  } catch {
    return null;
  }
}

function tailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output !== null) return parseTailscaleStatus(output);
  }
  return null;
}

async function tailscaleStatusAsync(signal?: AbortSignal): Promise<unknown> {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    signal?.throwIfAborted();
    let output: string;
    try {
      output = await getExecutor().runFileAsync(binary, ['status', '--json'], {
        timeoutMs: 5000,
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
    return parseTailscaleStatus(output);
  }
  return null;
}

/** Why a connection did not authenticate. `refused` when the machine answered and turned this machine away. */
export interface ConnectFailure {
  failure: string;
  refused: boolean;
  code?: string;
}

const TURNED_AWAY = new Set(['unauthorized', 'forbidden', 'protocol-unsupported', 'server-key-mismatch']);

/** The connect code for a protocol 1 stim-server, which closes on the binary Noise prefix before answering it. */
export const SERVER_OUTDATED = 'server-outdated';

/**
 * The doctor finding for a protocol 1 stim-server on `entry`, shared by the build and device-host checks so doctor
 * prints it once. `command` is the setup command, when this machine has an unexpired ticket for it.
 */
export function outdatedServer(
  entry: string,
  version: string,
  command: string | null,
): { title: string; detail: string; fix: string } {
  const update =
    `On ${entry}, run \`stim-server service update --release ${version}\`` +
    ' (add `--label <name>` for a custom service label; a server Stim Desktop runs updates with Stim Desktop)';
  return {
    title: `Remote machine ${entry} runs an older stim-server`,
    detail: `The stim-server on ${entry} speaks an older protocol than this Stim, so it cannot authenticate this machine.`,
    fix: command
      ? `${update}, then run this there to approve this machine: ${command}`
      : `${update}, then run \`stim doctor --fix\` here.`,
  };
}

/**
 * Opens a WebSocket to `target` and runs the protocol 2 handshake with this machine's client key. A returning client
 * goes ahead only with the server that proves it holds the pinned key.
 */
export function openAuthenticated(
  target: Endpoint,
  auth: MachineAuth,
  timeoutMs: number,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<NoiseSocket | ConnectFailure> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const options: ClientOptions & ConnectionOptions = {
      handshakeTimeout: timeoutMs,
      servername: target.servername,
      headers: { Host: target.host },
      maxPayload: MAX_SERVER_MESSAGE_BYTES + TRANSPORT_OVERHEAD_BYTES,
    };
    const socket = new WebSocket(target.url, options);
    if (reportSignal(operation))
      trackReportResource(operation, new Promise<void>((done) => socket.once('close', () => done())), () =>
        socket.terminate(),
      );
    let settled = false;
    const finish = (value: NoiseSocket | ConnectFailure) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timer);
      if (!('send' in value)) {
        socket.removeAllListeners('open');
        socket.removeAllListeners('message');
        socket.removeAllListeners('error');
        socket.on('error', () => {});
        socket.terminate();
      }
      resolve(value);
    };
    const cancel = () => finish({ failure: 'cancelled', refused: false, code: 'STIM_CANCELLED' });
    const timer = setTimeout(() => finish({ failure: 'no reply in time', refused: false }), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    const failed = (error: Error) =>
      finish({
        failure: /Unexpected server response: 502/.test(error.message)
          ? 'no stim-server answers behind its tailscale serve route (HTTP 502)'
          : error.message,
        refused: false,
      });
    socket.once('error', failed);
    socket.once('open', () => {
      const secret = 'ticket' in auth ? decodeSecret(auth.ticket) : null;
      let keyPair;
      try {
        keyPair = clientIdentity();
      } catch (error) {
        return finish({
          failure: `this machine's client key is unavailable: ${(error as Error).message}`,
          refused: false,
        });
      }
      void (async () => {
        try {
          const noise = await initiateNoise(socket, {
            keyPair,
            ...('serverKey' in auth ? { serverKey: Buffer.from(auth.serverKey, 'base64url') } : {}),
            ...(secret ? { secret, name: 'name' in auth ? auth.name : '' } : {}),
            timeoutMs,
          });
          socket.off('error', failed);
          socket.on('error', () => {});
          finish(noise);
        } catch (error) {
          const code = error instanceof HandshakeRefusal ? error.code : 'handshake-failed';
          if (code === 'unexpected binary frame')
            return finish({
              failure: 'its stim-server speaks an older protocol than this Stim',
              refused: true,
              code: SERVER_OUTDATED,
            });
          finish({
            failure: (error as Error).message,
            refused: TURNED_AWAY.has(code) || code === 'unknown-secret',
            code,
          });
        }
      })();
    });
  });
}

/** Sends `hello` on an authenticated connection; a close before the reply carries the server's refusal code. */
export function sayHello(
  socket: NoiseSocket,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ result: Record<string, unknown> } | { error: { code: string; message: string } }> {
  return new Promise((resolve) => {
    const done = (reply: { result: Record<string, unknown> } | { error: { code: string; message: string } }) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      resolve(reply);
    };
    const onMessage = (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let message: unknown;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        message = null;
      }
      if (!isJsonObject(message) || message.id !== 1) return;
      if (isJsonObject(message.error))
        return done({ error: { code: String(message.error.code), message: String(message.error.message) } });
      done({ result: isJsonObject(message.result) ? message.result : {} });
    };
    const onClose = (code: number, reason: Buffer) =>
      done({
        error: {
          code: reason.length ? reason.toString() : 'closed',
          message: `the connection closed before a hello result (${code}${reason.length ? ` ${reason.toString()}` : ''})`,
        },
      });
    const timer = setTimeout(() => done({ error: { code: 'timeout', message: 'no reply in time' } }), timeoutMs);
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.send(JSON.stringify({ id: 1, method: 'hello', params }));
  });
}

async function hello(target: Endpoint, auth: MachineAuth, operation?: StimContext): Promise<HelloReply> {
  const socket = await openAuthenticated(target, auth, HELLO_TIMEOUT_MS, reportSignal(operation), operation);
  if (!('send' in socket))
    return socket.code ? { error: { code: socket.code, message: socket.failure } } : { failed: socket.failure };
  if ('onServerKey' in auth) auth.onServerKey?.(socket.remoteKey.toString('base64url'));
  const reply = await sayHello(
    socket,
    { client: { name: 'stim', version: '1' }, access: auth.access },
    HELLO_TIMEOUT_MS,
  );
  socket.close(1000);
  if ('error' in reply) return reply;
  const { result } = reply;
  const device = isJsonObject(result.device) ? result.device : null;
  if (!device || typeof device.id !== 'string' || !Array.isArray(result.capabilities))
    return { failed: 'the reply was not a hello result' };
  return {
    result: result as Extract<HelloReply, { result: unknown }>['result'],
    serverKey: socket.remoteKey.toString('base64url'),
  };
}

export const realIo: TailnetMachineIo = { status: tailscaleStatus, hello };
export function doctorIo(operation?: StimContext): TailnetMachineIo {
  return {
    status: () => tailscaleStatusAsync(operation?.signal),
    hello: (target, auth) => hello(target, auth, operation),
  };
}

/** Where to reach a paired machine now, or why Stim cannot; the handshake then checks its pinned key. */
export async function resolveEndpoint(
  credential: { machine: string },
  status: () => unknown = () => tailscaleStatusAsync(signal),
  signal?: AbortSignal,
): Promise<Endpoint | string> {
  return machineEndpoint(credential.machine, parseMachine(credential.machine) ? await status() : null);
}

/** Where a remote machine stands with this machine, for one access. */
export type AccessOutcome =
  | { state: 'approved'; credential: MachineCredential; result: Extract<HelloReply, { result: unknown }>['result'] }
  | { state: 'pending'; credential: MachineCredential; command: string | null; reason: string }
  | { state: 'lapsed'; credential: MachineCredential }
  | { state: 'revoked'; credential: MachineCredential; reason: string }
  | { state: 'key-changed'; credential: MachineCredential }
  | { state: 'not-asked' }
  | { state: 'outdated'; credential: MachineCredential; command: string | null }
  | { state: 'unreachable'; credential?: MachineCredential; reason: string };

export interface AccessInput {
  machine: string;
  access: Access;
  endpoint: Endpoint;
  address: string;
  credential: MachineCredential | undefined;
  /**
   * Reads the same machine's credential for the other access, whose ticket a new request shares and whose pinned key
   * a spent ticket falls back to. Read again after `unknown-secret`, since that check may run alongside this one.
   */
  other: () => MachineCredential | undefined;
  /** Saves a pending credential as soon as its ticket's handshake pinned the server key. */
  persist: (credential: MachineCredential) => void;
  fix: boolean;
  deviceName: string;
  /** The `--build`/`--device-host` flags the printed setup command carries. */
  setupFlags: Access[];
  serverVersion: string;
  io: TailnetMachineIo;
  /** Tickets made in this doctor run by machine, so its build and device-host checks print one command. */
  tickets: GeneratedTickets;
  now?: number;
}

export type GeneratedTickets = Map<string, { ticket: string; expiresAt: string }>;

/** The remedy for a pending request: the printed setup command, or where the person finds it. */
export function setupRemedy(entry: string, command: string | null): string {
  return command
    ? `A person on ${entry} runs this there to approve this machine: ${command}`
    : `A person on ${entry} runs the \`stim-server setup\` command Stim Desktop showed for this machine.`;
}

function setupCommand(ticket: string, expiresAt: string, flags: Access[], version: string): string {
  return `STIM_SETUP_TICKET=${ticket} npx --yes --package @stim-cli/server@${version} stim-server setup --expires ${expiresAt} ${flags.map((flag) => `--${flag}`).join(' ')}`;
}

function newPending(input: AccessInput, ticket: string, expiresAt: string | undefined, now: number): MachineCredential {
  return {
    machine: input.machine,
    transport: 'tailscale',
    address: input.address,
    state: 'pending',
    requestedAt: new Date(now).toISOString(),
    ticket,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function approved(
  input: AccessInput,
  reply: Extract<HelloReply, { result: unknown }>,
  requestedAt: string,
): AccessOutcome {
  return {
    state: 'approved',
    credential: {
      machine: input.machine,
      transport: 'tailscale',
      address: input.address,
      state: 'approved',
      requestedAt,
      serverKey: reply.serverKey,
      deviceId: reply.result.device.id,
    },
    result: reply.result,
  };
}

/**
 * Connects to one remote machine for one access and says what changed. A returning client pins the stored server key.
 * A pending client spends its setup ticket in first contact until the worker's `stim-server setup` approves it; the
 * worker answers `unknown-secret` before that. With `fix`, a machine with no credential, or a revoked or lapsed one,
 * gets a new setup ticket: `STIM_ACCESS_TICKET` when set (Stim Desktop's Add Machine flow), else one this machine
 * generates, with the command to run on the worker. A pending credential is replaced when `STIM_ACCESS_TICKET` names
 * another ticket.
 */
export async function reachMachine(input: AccessInput): Promise<AccessOutcome> {
  const now = input.now ?? Date.now();
  const { credential, io, access } = input;
  const given = readAccessTicket();
  const ask = (): AccessOutcome | Promise<AccessOutcome> => {
    if (given) return firstContact(newPending(input, given, undefined, now));
    const other = input.other();
    const shared = other?.state === 'pending' && other.expiresAt ? other : undefined;
    const ticket = shared
      ? { ticket: shared.ticket!, expiresAt: shared.expiresAt! }
      : (input.tickets.get(input.machine) ?? {
          ticket: newSecret(),
          expiresAt: new Date(now + GENERATED_TICKET_MS).toISOString(),
        });
    input.tickets.set(input.machine, ticket);
    return firstContact(newPending(input, ticket.ticket, ticket.expiresAt, now));
  };
  const firstContact = async (asked: MachineCredential): Promise<AccessOutcome> => {
    let pending = asked;
    if (pending.serverKey) {
      const resumed = await io.hello(input.endpoint, { access, serverKey: pending.serverKey });
      if ('result' in resumed && resumed.result.capabilities.includes(access))
        return approved(input, resumed, pending.requestedAt);
    }
    const reply = await io.hello(input.endpoint, {
      access,
      ticket: pending.ticket!,
      name: input.deviceName,
      onServerKey: (serverKey) => {
        pending = { ...pending, serverKey };
        input.persist(pending);
      },
    });
    if ('result' in reply && reply.result.capabilities.includes(access))
      return approved(input, reply, pending.requestedAt);
    const command = pending.expiresAt
      ? setupCommand(pending.ticket!, pending.expiresAt, input.setupFlags, input.serverVersion)
      : null;
    if ('error' in reply && reply.error.code === SERVER_OUTDATED)
      return { state: 'outdated', credential: pending, command };
    const sibling = 'error' in reply && reply.error.code === 'unknown-secret' ? input.other()?.serverKey : undefined;
    if (sibling && sibling !== pending.serverKey) {
      const again = await io.hello(input.endpoint, { access, serverKey: sibling });
      if ('result' in again && again.result.capabilities.includes(access))
        return approved(input, again, pending.requestedAt);
    }
    if ('error' in reply && (reply.error.code === 'unknown-secret' || reply.error.code === 'forbidden'))
      return {
        state: 'pending',
        credential: pending,
        command,
        reason: reply.error.message,
      };
    return {
      state: 'unreachable',
      credential: pending,
      reason:
        'failed' in reply ? reply.failed : 'error' in reply ? reply.error.message : 'it did not grant this access',
    };
  };
  if (!credential) return input.fix ? ask() : { state: 'not-asked' };
  if (credential.state === 'approved') {
    const reply = await io.hello(input.endpoint, { access, serverKey: credential.serverKey! });
    if ('result' in reply && reply.result.capabilities.includes(access))
      return approved(input, reply, credential.requestedAt);
    if ('error' in reply && reply.error.code === 'server-key-mismatch') return { state: 'key-changed', credential };
    if ('error' in reply && reply.error.code === SERVER_OUTDATED)
      return { state: 'outdated', credential, command: null };
    if ('error' in reply && (reply.error.code === 'unauthorized' || reply.error.code === 'forbidden'))
      return input.fix ? ask() : { state: 'revoked', credential, reason: reply.error.message };
    if ('result' in reply)
      return input.fix ? ask() : { state: 'revoked', credential, reason: 'it no longer grants this access' };
    return { state: 'unreachable', credential, reason: 'failed' in reply ? reply.failed : reply.error.message };
  }
  if (input.fix && given && given !== credential.ticket) return ask();
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= now)
    return input.fix ? ask() : { state: 'lapsed', credential };
  return firstContact(credential);
}
