import type { StimContext } from '@stim-cli/core';
import { reportSignal, trackReportResource } from '../report-runtime.ts';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
  HandshakeRefusal,
  initiateNoise,
  MAX_SERVER_MESSAGE_BYTES,
  TRANSPORT_OVERHEAD_BYTES,
  decodeSecret,
  keyFingerprint,
  newSecret,
  type NoiseSocket,
} from '@stim-cli/core/noise-session';
import {
  clientIdentity,
  DEFAULT_SERVER_PORT,
  endpoint,
  findPeer,
  isJsonObject,
  machineEndpoint,
  parseMachine,
  type Endpoint,
  type MachineCredential,
  type MachineTransport,
  type TailnetIdentity,
  wrongTailnet,
  type TailnetPeer,
} from '@stim-cli/core/state';
export { parseMachine, findPeer, endpoint, type Endpoint, type TailnetPeer } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readAccessTicket } from './access-ticket.ts';
import {
  classifyTransport,
  diagnoseLocalUnreachable,
  diagnoseUnreachable,
  parsePeerStartup,
  wrongTailnetDiagnosis,
  readTailscale,
  tailscaleDiagnosis,
  type PeerStartup,
  type Transport,
} from './diagnosis.ts';
import type { RemoteDiagnosis } from '@stim-cli/core/protocol';

const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3000;
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
      onServerKey?: (serverKey: string) => void | Promise<void>;
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
  | { failed: string; transport?: Transport };

export interface TailnetMachineIo {
  /** `tailscale status --json`, or null when Tailscale is not running. */
  status: () => unknown;
  hello: (endpoint: Endpoint, auth: MachineAuth) => Promise<HelloReply>;
  /** `tailscale status --json` whatever its backend state, or null when no command answered; says why `status` is null. */
  rawStatus?: () => unknown;
  /** The `startup` of the peer's `/health` after a 503, or null when it says none. */
  startup?: (endpoint: Endpoint) => Promise<PeerStartup | null>;
  /** Whether `tailscale ping` gets an answer from the peer's address. */
  ping?: (address: string) => Promise<boolean>;
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

function parseTailscaleStatus(output: string): unknown {
  const status = parseJson(output);
  return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
}

function rawTailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output !== null) return parseJson(output);
  }
  return null;
}

/** Reads the `startup` of a peer's `/health`, which stim-server answers with 503 while it is not serving clients. */
function peerStartup({ url, servername, host }: Endpoint): Promise<PeerStartup | null> {
  return new Promise((resolve) => {
    const base = new URL(url);
    const plain = base.protocol === 'ws:';
    const request = (plain ? httpRequest : httpsRequest)(
      {
        host: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || (plain ? 80 : 443),
        path: '/health',
        ...(plain ? {} : { servername }),
        headers: { Host: host },
        timeout: HEALTH_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) request.destroy();
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(parsePeerStartup(parseJson(Buffer.concat(chunks).toString('utf8')))));
        response.on('error', () => resolve(null));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    request.end();
  });
}

function tailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output !== null) return parseTailscaleStatus(output);
  }
  return null;
}

async function tailscaleOutputAsync(signal?: AbortSignal): Promise<string | null> {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    signal?.throwIfAborted();
    let output: string;
    try {
      output = await getExecutor().runFileAsync(binary, ['status', '--json'], { timeoutMs: 5000, signal });
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
    return output;
  }
  return null;
}

export async function tailscaleStatusAsync(signal?: AbortSignal): Promise<unknown> {
  const output = await tailscaleOutputAsync(signal);
  return output === null ? null : parseTailscaleStatus(output);
}

async function pingPeer(address: string, signal?: AbortSignal): Promise<boolean> {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    signal?.throwIfAborted();
    try {
      await getExecutor().runFileAsync(
        binary,
        ['ping', '--c', '1', '--until-direct=false', '--timeout', '4s', address],
        { timeoutMs: 6000, signal },
      );
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (!/ENOENT|not found/i.test(String(error))) return false;
    }
  }
  return false;
}

async function rawTailscaleStatusAsync(signal?: AbortSignal): Promise<unknown> {
  const output = await tailscaleOutputAsync(signal);
  return output === null ? null : parseJson(output);
}

/** Why a connection did not authenticate. `refused` when the machine answered and turned this machine away. */
export interface ConnectFailure {
  failure: string;
  refused: boolean;
  code?: string;
  /** What the connection did below the handshake, when that is why it failed. */
  transport?: Transport;
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
      ? `${update}, then run this there to approve this machine: ${command}\nAfter approving, run \`stim doctor\` on this machine to reconnect.`
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
        socket.removeAllListeners('unexpected-response');
        socket.on('error', () => {});
        socket.terminate();
      }
      resolve(value);
    };
    const cancel = () => finish({ failure: 'cancelled', refused: false, code: 'STIM_CANCELLED' });
    let opened = false;
    const timer = setTimeout(
      () =>
        finish({
          failure: 'no reply in time',
          refused: false,
          transport: opened ? { kind: 'other', message: 'the handshake got no reply' } : { kind: 'silent' },
        }),
      timeoutMs,
    );
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    const served = target.url.startsWith('wss:');
    const failed = (error: Error & { code?: string }, status?: number) =>
      finish({
        failure:
          status === 502 && served
            ? 'no stim-server answers behind its tailscale serve route (HTTP 502)'
            : status === 503
              ? `stim-server answers${served ? ' behind its tailscale serve route' : ''} but is not serving clients (HTTP 503)`
              : status !== undefined
                ? `${served ? 'its tailscale serve route' : 'it'} answered HTTP ${status}`
                : error.message,
        refused: false,
        transport:
          opened && status === undefined ? { kind: 'other', message: error.message } : classifyTransport(error, status),
      });
    socket.once('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      failed(new Error(`Unexpected server response: ${response.statusCode}`), response.statusCode);
    });
    socket.once('error', failed);
    socket.once('open', () => {
      opened = true;
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
    return socket.code
      ? { error: { code: socket.code, message: socket.failure } }
      : { failed: socket.failure, ...(socket.transport ? { transport: socket.transport } : {}) };
  try {
    if ('onServerKey' in auth) await auth.onServerKey?.(socket.remoteKey.toString('base64url'));
  } catch (error) {
    socket.close(1000);
    throw error;
  }
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

export const realIo: TailnetMachineIo = {
  status: tailscaleStatus,
  hello,
  rawStatus: rawTailscaleStatus,
  startup: peerStartup,
  ping: (address) => pingPeer(address),
};
export function doctorIo(operation?: StimContext): TailnetMachineIo {
  return {
    status: () => tailscaleStatusAsync(operation?.signal),
    hello: (target, auth) => hello(target, auth, operation),
    rawStatus: () => rawTailscaleStatusAsync(operation?.signal),
    startup: peerStartup,
    ping: (address) => pingPeer(address, operation?.signal),
  };
}

/**
 * Names the layer an unreachable `entry` stopped at. A 503 reads the peer's `/health` for why the server is not
 * serving; an older stim-server answers without it, and the diagnosis then says only that it is not ready.
 */
export async function diagnoseOutcome(
  io: Pick<TailnetMachineIo, 'startup' | 'ping'>,
  input: { entry: string; peer: TailnetPeer; port: number; target: Endpoint; reason: string; transport?: Transport },
): Promise<RemoteDiagnosis> {
  const { target, ...rest } = input;
  const needsStartup = rest.transport?.kind === 'http' && rest.transport.status === 503;
  const startup = needsStartup ? await io.startup?.(target) : null;
  const pinged = rest.transport?.kind === 'silent' ? await io.ping?.(rest.peer.address) : undefined;
  return diagnoseUnreachable({ ...rest, startup, pinged });
}

/**
 * The diagnosis `stim doctor` gives for a machine that resolved to a tailnet peer but did not connect, without
 * doctor's `tailscale ping`: the connection has already waited out its timeout. Reads `tailscale status` only here,
 * after the failure. Null when Tailscale no longer lists the machine.
 */
export async function diagnoseConnectFailure(
  machine: string,
  failure: ConnectFailure,
  signal?: AbortSignal,
): Promise<RemoteDiagnosis | null> {
  const parsed = parseMachine(machine);
  if (!parsed) return null;
  if (parsed.transport === 'local') {
    const target = machineEndpoint(machine, null);
    const startup =
      typeof target !== 'string' && failure.transport?.kind === 'http' && failure.transport.status === 503
        ? await peerStartup(target)
        : null;
    return diagnoseLocalUnreachable({
      entry: machine,
      port: parsed.port,
      reason: failure.failure,
      startup,
      ...(failure.transport ? { transport: failure.transport } : {}),
    });
  }
  const peer = findPeer(await tailscaleStatusAsync(signal), parsed.name);
  if (typeof peer === 'string') return null;
  return diagnoseOutcome(
    { startup: peerStartup },
    {
      entry: machine,
      peer,
      port: parsed.port,
      target: endpoint(peer, parsed.port),
      reason: failure.failure,
      ...(failure.transport ? { transport: failure.transport } : {}),
    },
  );
}

/** Why `status` is null, as a diagnosis of the Tailscale layer; falls back to the daemon being unavailable. */
export async function diagnoseTailscale(io: TailnetMachineIo): Promise<RemoteDiagnosis> {
  const reading = readTailscale(io.rawStatus ? await io.rawStatus() : null);
  return tailscaleDiagnosis(reading.running ? 'tailscale-unavailable' : reading.code);
}

/**
 * Where to reach a paired machine now, or why Stim cannot; the handshake then checks its pinned key. A machine
 * missing from the tailnet this Mac is signed in to says so when the credential recorded another tailnet.
 */
export async function resolveEndpoint(
  credential: Pick<MachineCredential, 'machine'> & Partial<Pick<MachineCredential, 'address' | 'tailnet'>>,
  status: () => unknown = () => tailscaleStatusAsync(signal),
  signal?: AbortSignal,
): Promise<Endpoint | string> {
  const parsed = parseMachine(credential.machine);
  const current = parsed?.transport === 'tailscale' ? await status() : null;
  const found = machineEndpoint(credential.machine, current);
  if (typeof found !== 'string' || parsed?.transport !== 'tailscale' || findPeer(current, parsed.name) !== 'missing')
    return found;
  const wrong = wrongTailnet(credential, current);
  if (!wrong) return found;
  const { message, remedy } = wrongTailnetDiagnosis(credential.machine, wrong);
  return `${message} ${remedy}`.replace(/\.$/, '');
}

/** Where a remote machine stands with this machine, for one access. */
export type AccessOutcome =
  | { state: 'approved'; credential: MachineCredential; result: Extract<HelloReply, { result: unknown }>['result'] }
  | { state: 'pending'; credential: MachineCredential; command: string | null; reason: string }
  | { state: 'lapsed'; credential: MachineCredential }
  | { state: 'revoked'; credential: MachineCredential; reason: string }
  | { state: 'key-changed'; credential: MachineCredential }
  | { state: 'unconfirmed'; credential: MachineCredential; fingerprint: string }
  | { state: 'not-asked' }
  | { state: 'outdated'; credential: MachineCredential; command: string | null }
  | { state: 'unreachable'; credential?: MachineCredential; reason: string; transport?: Transport };

export interface AccessInput {
  machine: string;
  access: Access;
  endpoint: Endpoint;
  address: string;
  /** The tailnet this machine is signed in to now; recorded on a credential that has none. Absent for a `local` machine. */
  tailnet?: TailnetIdentity;
  credential: MachineCredential | undefined;
  /**
   * Reads the same machine's credential for the other access, whose ticket a new request shares and whose pinned key
   * a spent ticket falls back to. Read again after `unknown-secret`, since that check may run alongside this one.
   */
  other: () => MachineCredential | undefined;
  /** Saves a pending credential as soon as its ticket's handshake pinned the server key. */
  persist: (credential: MachineCredential) => void | Promise<void>;
  fix: boolean;
  deviceName: string;
  /** The `--build`/`--device-host` flags the printed setup command carries. */
  setupFlags: Access[];
  serverVersion: string;
  io: TailnetMachineIo;
  /** Tickets made in this doctor run by machine, so its build and device-host checks print one command. */
  tickets: GeneratedTickets;
  /**
   * For a machine on the local network, which no transport pins: asks a person to compare the server key's fingerprint
   * with the one `stim-server setup` printed there, after the ticket's handshake. The key is pinned only on true; a
   * key this machine already pinned for the same entry is not asked again.
   */
  confirmKey?: (serverKey: string) => Promise<boolean>;
  now?: number;
}

export type GeneratedTickets = Map<string, { ticket: string; expiresAt: string }>;

/** Whether a person confirmed that `serverKey` is the key of the stim-server on `machine`. */
export type KeyConfirmer = (machine: string, serverKey: string) => Promise<boolean>;

/**
 * Shows a local network machine's server key fingerprint and asks a person whether it matches the one
 * `stim-server setup` printed there. Questions go one at a time, and each machine and key is asked once per doctor
 * run, so its build and device-host checks share the answer. Without a terminal every answer is no.
 */
export function keyConfirmer(ask: ((question: string) => Promise<boolean>) | null): KeyConfirmer {
  const answers = new Map<string, Promise<boolean>>();
  let queue: Promise<unknown> = Promise.resolve();
  return (machine, serverKey) => {
    if (!ask) return Promise.resolve(false);
    const id = `${machine}\0${serverKey}`;
    let answer = answers.get(id);
    if (!answer) {
      const fingerprint = keyFingerprint(Buffer.from(serverKey, 'base64url'));
      answer = queue.then(() =>
        ask(
          `${machine} answered with this stim-server key fingerprint:\n  ${fingerprint}\nDoes it match the fingerprint \`stim-server setup\` printed on ${machine}? Only then does Stim trust it. [y/N] `,
        ),
      );
      queue = answer.catch(() => false);
      answers.set(id, answer);
    }
    return answer;
  };
}

/** The remedy for a pending request: the printed setup command, or where the person finds it. */
export function setupRemedy(entry: string, command: string | null): string {
  return command
    ? `A person on ${entry} runs this there to approve this machine: ${command}\nAfter approving, run \`stim doctor\` on this machine to reconnect.`
    : `A person on ${entry} runs the \`stim-server setup\` command Stim Desktop showed for this machine.`;
}

function setupCommand(machine: string, ticket: string, expiresAt: string, flags: Access[], version: string): string {
  const parsed = parseMachine(machine);
  const port = parsed?.transport === 'local' && parsed.port !== DEFAULT_SERVER_PORT ? ` --port ${parsed.port}` : '';
  return `STIM_SETUP_TICKET=${ticket} STIM_SETUP_ORIGIN=doctor npx --yes --package @stim-cli/server@${version} stim-server setup --expires ${expiresAt} ${flags.map((flag) => `--${flag}`).join(' ')}${port}`;
}

function transportOf(machine: string): MachineTransport {
  return parseMachine(machine)?.transport ?? 'tailscale';
}

function newPending(input: AccessInput, ticket: string, expiresAt: string | undefined, now: number): MachineCredential {
  return {
    machine: input.machine,
    transport: transportOf(input.machine),
    address: input.address,
    state: 'pending',
    requestedAt: new Date(now).toISOString(),
    ticket,
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.tailnet ? { tailnet: input.tailnet } : {}),
  };
}

function approved(
  input: AccessInput,
  reply: Extract<HelloReply, { result: unknown }>,
  requestedAt: string,
): AccessOutcome {
  const tailnet = input.credential?.tailnet ?? input.tailnet;
  return {
    state: 'approved',
    credential: {
      machine: input.machine,
      transport: transportOf(input.machine),
      address: input.address,
      state: 'approved',
      requestedAt,
      serverKey: reply.serverKey,
      deviceId: reply.result.device.id,
      ...(tailnet ? { tailnet } : {}),
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
    const known = (serverKey: string) => pending.serverKey === serverKey || input.other()?.serverKey === serverKey;
    const reply = await io.hello(input.endpoint, {
      access,
      ticket: pending.ticket!,
      name: input.deviceName,
      onServerKey: (serverKey) => {
        if (input.confirmKey && !known(serverKey)) return;
        pending = { ...pending, serverKey };
        return input.persist(pending);
      },
    });
    if ('result' in reply && reply.result.capabilities.includes(access)) {
      if (input.confirmKey && !known(reply.serverKey)) {
        if (!(await input.confirmKey(reply.serverKey)))
          return {
            state: 'unconfirmed',
            credential: pending,
            fingerprint: keyFingerprint(Buffer.from(reply.serverKey, 'base64url')),
          };
        pending = { ...pending, serverKey: reply.serverKey };
        await input.persist(pending);
      }
      return approved(input, reply, pending.requestedAt);
    }
    const command = pending.expiresAt
      ? setupCommand(input.machine, pending.ticket!, pending.expiresAt, input.setupFlags, input.serverVersion)
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
      ...('failed' in reply && reply.transport ? { transport: reply.transport } : {}),
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
    return {
      state: 'unreachable',
      credential,
      reason: 'failed' in reply ? reply.failed : reply.error.message,
      ...('failed' in reply && reply.transport ? { transport: reply.transport } : {}),
    };
  }
  if (input.fix && given && given !== credential.ticket) return ask();
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= now)
    return input.fix ? ask() : { state: 'lapsed', credential };
  return firstContact(credential);
}
