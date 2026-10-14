import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generateNoiseKeyPair,
  HandshakeState,
  MAX_HANDSHAKE_MESSAGE_BYTES,
  NOISE_XX,
  NOISE_XX_PSK2,
  NoiseError,
  noiseKeyPairFromPrivateKey,
  NoiseTransport,
  type NoiseKeyPair,
} from './noise.ts';

/** The protocol version byte that opens every protocol 2 connection. */
export const STIM_PROTOCOL_VERSION = 2;
/** A client the server already has a record for: `Noise_XX`, nothing after the mode byte. */
export const MODE_RETURNING = 0;
/** A client spending a pairing token or setup ticket: `Noise_XXpsk2`, with the secret's `lookup` after the mode byte. */
export const MODE_FIRST_CONTACT = 1;
export type HandshakeMode = typeof MODE_RETURNING | typeof MODE_FIRST_CONTACT;

export const SECRET_BYTES = 32;
export const LOOKUP_BYTES = 16;
/** Largest message, plaintext without its type byte, a server accepts from a client. */
export const MAX_CLIENT_MESSAGE_BYTES: number = 64 * 1024;
/** Largest message, plaintext without its type byte, a server sends. */
export const MAX_SERVER_MESSAGE_BYTES: number = 16 * 1024 * 1024;
/** What a transport message adds to its plaintext on the wire: the type byte and the ChaCha20-Poly1305 tag. */
export const TRANSPORT_OVERHEAD_BYTES = 17;
const MAX_PREFIX_BYTES = 2 + LOOKUP_BYTES;
/** The largest first WebSocket message: the cleartext prefix and Noise message 1. */
export const MAX_FIRST_MESSAGE_BYTES: number = MAX_PREFIX_BYTES + MAX_HANDSHAKE_MESSAGE_BYTES;

/** The close code a server or client uses for an authentication refusal; the close reason is the error code. */
export const CLOSE_REFUSED = 4401;
/** The close code for a message this side cannot use, such as a protocol 1 hello; the reason is the error code. */
export const CLOSE_BAD_REQUEST = 4400;

const PROLOGUE = Buffer.from('stim noise v1', 'ascii');
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A pairing token or setup ticket as people and commands carry it: 43 base64url characters of 32 random bytes. */
export function newSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/** The 32 bytes of a pairing token or setup ticket, or null when `text` is not one. */
export function decodeSecret(text: string): Buffer | null {
  if (!SECRET_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === SECRET_BYTES && bytes.toString('base64url') === text ? bytes : null;
}

export interface SecretValues {
  /** The Noise PSK: `SHA-256("stim noise psk v1" || t)`. */
  psk: Buffer;
  /** Names the secret in the cleartext prefix: `SHA-256("stim noise lookup v1" || t)[0..16]`. */
  lookup: Buffer;
  /** The setup journal's file name and URL path, lowercase hex of `SHA-256("stim setup journal v1" || t)`. */
  journal: string;
}

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** The values both sides derive from a secret's 32 bytes. None reveals `psk` or the secret. */
export function secretValues(secret: Uint8Array): SecretValues {
  if (secret.length !== SECRET_BYTES) throw new RangeError('A pairing token or setup ticket is 32 bytes');
  return {
    psk: sha256(Buffer.from('stim noise psk v1', 'ascii'), secret),
    lookup: sha256(Buffer.from('stim noise lookup v1', 'ascii'), secret).subarray(0, LOOKUP_BYTES),
    journal: sha256(Buffer.from('stim setup journal v1', 'ascii'), secret).toString('hex'),
  };
}

/** A server key's fingerprint, as the pairing QR code carries it: base64url of the key's SHA-256. */
export function keyFingerprint(publicKey: Uint8Array): string {
  return sha256(publicKey).toString('base64url');
}

/** The cleartext prefix of the first WebSocket message. */
export function handshakePrefix(mode: HandshakeMode, lookup?: Uint8Array): Buffer {
  if ((mode === MODE_FIRST_CONTACT) !== (lookup !== undefined)) throw new TypeError('Only first contact sends lookup');
  if (lookup && lookup.length !== LOOKUP_BYTES) throw new RangeError('lookup is 16 bytes');
  return Buffer.concat([Uint8Array.of(STIM_PROTOCOL_VERSION, mode), lookup ?? Buffer.alloc(0)]);
}

export type ParsedFirstMessage =
  | { mode: typeof MODE_RETURNING; prefix: Buffer; message: Buffer }
  | { mode: typeof MODE_FIRST_CONTACT; prefix: Buffer; lookup: Buffer; message: Buffer }
  | { error: 'protocol-unsupported' | 'handshake-failed' };

/** Splits the first WebSocket message into its prefix and Noise message 1. */
export function parseFirstMessage(data: Uint8Array): ParsedFirstMessage {
  const bytes = Buffer.from(data);
  if (bytes.length < 1 || bytes[0] !== STIM_PROTOCOL_VERSION) return { error: 'protocol-unsupported' };
  if (bytes.length > MAX_FIRST_MESSAGE_BYTES) return { error: 'handshake-failed' };
  if (bytes[1] === MODE_RETURNING)
    return { mode: MODE_RETURNING, prefix: bytes.subarray(0, 2), message: bytes.subarray(2) };
  if (bytes[1] === MODE_FIRST_CONTACT && bytes.length >= MAX_PREFIX_BYTES) {
    return {
      mode: MODE_FIRST_CONTACT,
      prefix: bytes.subarray(0, MAX_PREFIX_BYTES),
      lookup: bytes.subarray(2, MAX_PREFIX_BYTES),
      message: bytes.subarray(MAX_PREFIX_BYTES),
    };
  }
  return { error: 'handshake-failed' };
}

/** `"stim noise v1" || prefix`, so the handshake authenticates the version, mode and lookup. */
export function handshakePrologue(prefix: Uint8Array): Buffer {
  return Buffer.concat([PROLOGUE, prefix]);
}

/**
 * The long-term X25519 key in `file`, created with mode 0600 the first time. A file that exists but does not hold a
 * 32-byte key throws instead of being replaced, because a new key makes every pinned peer refuse this side.
 */
export function readOrCreateKeyFile(file: string): NoiseKeyPair {
  const read = (): NoiseKeyPair => {
    const bytes = readFileSync(file);
    if (bytes.length !== 32)
      throw new Error(`${file} does not hold a 32-byte X25519 key; move it away to make a new one`);
    return noiseKeyPairFromPrivateKey(bytes);
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const keyPair = generateNoiseKeyPair();
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, keyPair.privateKey, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return read();
  } finally {
    rmSync(temporary, { force: true });
  }
  return keyPair;
}

/** The subset of a `ws` WebSocket that a Noise session runs on. */
export interface RawSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  /** Bytes go as a binary message and a string as a text message, as `ws` sends them. */
  send(data: Buffer | string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping?(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  off(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  off(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

function bytesOf(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as Uint8Array);
}

/** Why a handshake did not complete. `code` is the server's close reason when it refused this client. */
export class HandshakeRefusal extends Error {
  override name = 'HandshakeRefusal';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const REFUSAL_MESSAGES: Record<string, string> = {
  'unknown-secret': 'The machine does not know this pairing token or setup ticket yet, or it expired.',
  unauthorized: 'The machine does not recognize this client. Pair again.',
  'protocol-unsupported':
    'The machine speaks another stim-server protocol. Update it and this client, then pair again.',
  'handshake-failed': 'The authentication handshake failed.',
  'server-key-mismatch': 'The machine answered with a different server key than the one pinned at pairing. Pair again.',
};

/**
 * One authenticated, encrypted connection over a WebSocket, with the subset of `ws`'s WebSocket API Stim uses.
 * `send` takes a string for a text message and bytes for a binary one; `message` listeners get the plaintext as a
 * Buffer and whether it was binary. A message that fails to decrypt closes the connection.
 */
export class NoiseSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  /** The authenticated static public key of the other side. */
  readonly remoteKey: Buffer;
  readonly #raw: RawSocket;
  readonly #transport: NoiseTransport;
  /** Messages that arrive before the first `message` listener, such as a hello sent right after message 3. */
  #held: [Buffer, boolean][] | null = [];

  constructor(raw: RawSocket, transport: NoiseTransport, remoteKey: Buffer) {
    super();
    this.#raw = raw;
    this.#transport = transport;
    this.remoteKey = remoteKey;
    raw.on('message', (data, isBinary) => {
      if (!isBinary) return void raw.close(CLOSE_BAD_REQUEST, 'handshake-failed');
      let message;
      try {
        message = transport.decrypt(bytesOf(data));
      } catch {
        return void raw.close(CLOSE_BAD_REQUEST, 'decrypt-failed');
      }
      const event: [Buffer, boolean] =
        message.type === 'text' ? [Buffer.from(message.data, 'utf8'), false] : [message.data, true];
      if (this.#held) this.#held.push(event);
      else this.emit('message', ...event);
    });
    this.on('newListener', (event: string) => {
      if (event !== 'message' || !this.#held) return;
      const held = this.#held;
      this.#held = null;
      queueMicrotask(() => {
        for (const each of held) this.emit('message', ...each);
      });
    });
    raw.on('close', (code, reason) => this.emit('close', code, reason));
    raw.on('error', (error) => this.emit('error', error));
    raw.on('pong', () => this.emit('pong'));
  }

  get readyState(): number {
    return this.#raw.readyState;
  }

  get bufferedAmount(): number {
    return this.#raw.bufferedAmount;
  }

  /**
   * Sends a string as a text message or bytes as a binary message. A message over this side's limit closes the
   * connection with 1009, as a WebSocket peer does for an oversized frame.
   */
  send(
    data: string | Uint8Array,
    options?: { binary?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    const done = typeof options === 'function' ? options : callback;
    const binary = typeof options === 'object' ? options.binary : undefined;
    if (this.#raw.readyState !== this.OPEN) return void done?.(new Error('The connection is not open'));
    let frame: Buffer;
    try {
      frame = this.#transport.encrypt(
        typeof data !== 'string' && binary === false ? Buffer.from(data).toString() : data,
      );
    } catch (error) {
      this.#raw.close(error instanceof RangeError ? 1009 : 1011, 'message not sent');
      return void done?.(error as Error);
    }
    this.#raw.send(frame, done);
  }

  close(code?: number, reason?: string): void {
    this.#raw.close(code, reason);
  }

  terminate(): void {
    this.#raw.terminate();
  }

  ping(): void {
    this.#raw.ping?.();
  }
}

export interface InitiateOptions {
  keyPair: NoiseKeyPair;
  /** The server key pinned at pairing; the handshake fails unless the server proves it holds this key. */
  serverKey?: Uint8Array;
  /** A pairing token or setup ticket's 32 bytes, for first contact. Without it, the client must pin `serverKey`. */
  secret?: Uint8Array;
  /** The device name first contact records; sent encrypted in message 3. */
  name?: string;
  /** Accepts a server key on first contact, such as one matching a QR code's fingerprint. */
  acceptServerKey?: (key: Buffer) => boolean;
  timeoutMs: number;
  /** Largest message this client sends and receives; defaults to the client side of the spec's limits. */
  maxSendBytes?: number;
  maxReceiveBytes?: number;
}

/**
 * Runs the client side of the protocol 2 handshake on an open WebSocket. It rejects with {@link HandshakeRefusal} and
 * closes the socket when the server refuses or the handshake fails; the server's close reason names why.
 */
export function initiateNoise(raw: RawSocket, options: InitiateOptions): Promise<NoiseSocket> {
  const first = options.secret !== undefined;
  if (!first && !options.serverKey) throw new TypeError('A returning client pins the server key');
  const values = first ? secretValues(options.secret!) : null;
  const prefix = values ? handshakePrefix(MODE_FIRST_CONTACT, values.lookup) : handshakePrefix(MODE_RETURNING);
  const handshake = new HandshakeState({
    protocol: values ? NOISE_XX_PSK2 : NOISE_XX,
    initiator: true,
    prologue: handshakePrologue(prefix),
    staticKeyPair: options.keyPair,
    ...(values ? { psk: values.psk } : {}),
  });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      raw.off('message', onMessage);
      raw.off('close', onClose);
      raw.off('error', onError);
    };
    const fail = (code: string, detail?: string) => {
      cleanup();
      if (raw.readyState === 1) raw.close(CLOSE_REFUSED, code);
      reject(
        new HandshakeRefusal(code, detail ?? REFUSAL_MESSAGES[code] ?? `The machine refused the connection (${code}).`),
      );
    };
    const onClose = (code: number, reason: Buffer) => {
      const text = reason.toString();
      fail(text || 'closed', text ? undefined : `The connection closed during the handshake (${code}).`);
    };
    const onError = (error: Error) => fail('closed', error.message);
    const onMessage = (data: unknown, isBinary: boolean) => {
      if (!isBinary) {
        const refusal = plaintextRefusal(bytesOf(data));
        return fail(refusal?.code ?? 'handshake-failed', refusal?.message);
      }
      try {
        handshake.readMessage(bytesOf(data));
      } catch {
        return fail('handshake-failed');
      }
      const serverKey = handshake.remoteStaticPublicKey!;
      if (
        options.serverKey
          ? !serverKey.equals(Buffer.from(options.serverKey))
          : options.acceptServerKey?.(serverKey) === false
      )
        return fail('server-key-mismatch');
      const payload = first ? Buffer.from(JSON.stringify({ name: options.name ?? '' }), 'utf8') : undefined;
      let message3: Buffer;
      try {
        message3 = handshake.writeMessage(payload);
      } catch {
        return fail('handshake-failed');
      }
      cleanup();
      raw.send(message3);
      const { send, receive } = handshake.split();
      resolve(
        new NoiseSocket(
          raw,
          new NoiseTransport({
            send,
            receive,
            maxSendBytes: options.maxSendBytes ?? MAX_CLIENT_MESSAGE_BYTES,
            maxReceiveBytes: options.maxReceiveBytes ?? MAX_SERVER_MESSAGE_BYTES,
          }),
          serverKey,
        ),
      );
    };
    const timer = setTimeout(
      () => fail('timeout', 'The machine did not finish the handshake in time.'),
      options.timeoutMs,
    );
    raw.on('message', onMessage);
    raw.on('close', onClose);
    raw.on('error', onError);
    try {
      raw.send(Buffer.concat([prefix, handshake.writeMessage()]));
    } catch {
      fail('handshake-failed');
    }
  });
}

function plaintextRefusal(data: Buffer): { code: string; message: string } | null {
  try {
    const message = JSON.parse(data.toString('utf8')) as { error?: { code?: unknown; message?: unknown } };
    return typeof message.error?.code === 'string' && typeof message.error.message === 'string'
      ? { code: message.error.code, message: message.error.message }
      : null;
  } catch {
    return null;
  }
}

/** What the server learned from a completed handshake, before it decides whether to keep the connection. */
export interface AcceptedHandshake {
  socket: NoiseSocket;
  mode: HandshakeMode;
  /** The first-contact secret's lookup, as hex. */
  lookup?: string;
  clientKey: Buffer;
  /** Message 3's payload: the first-contact JSON `{ "name": ... }`, or empty. */
  payload: Buffer;
}

export interface AcceptOptions {
  keyPair: NoiseKeyPair;
  /** The PSK of the secret `lookup` (hex) names, or null when no valid secret matches. */
  psk: (lookup: string) => Buffer | null;
  timeoutMs: number;
  maxSendBytes?: number;
  maxReceiveBytes?: number;
}

/** The message a protocol 1 client gets: in cleartext, since it cannot decrypt, then the socket closes. */
export const PROTOCOL_UNSUPPORTED_MESSAGE: string =
  'This stim-server speaks protocol 2, with its own authentication. Update this app or Stim, then pair again.';

/**
 * Runs the server side of the handshake on the first message a client sent. It closes the socket and rejects with
 * {@link HandshakeRefusal} when the client speaks another protocol, names no valid secret (`unknown-secret`), or fails
 * the handshake. A text first message, a protocol 1 hello, gets a cleartext `protocol-unsupported` reply.
 */
export function acceptNoise(
  raw: RawSocket,
  first: unknown,
  isBinary: boolean,
  options: AcceptOptions,
): Promise<AcceptedHandshake> {
  return new Promise((resolve, reject) => {
    const refuse = (code: string, closeCode = CLOSE_REFUSED) => {
      clearTimeout(timer);
      raw.off('message', onMessage);
      raw.off('close', onClose);
      if (raw.readyState === 1) raw.close(closeCode, code);
      reject(new HandshakeRefusal(code, REFUSAL_MESSAGES[code] ?? code));
    };
    const onClose = () => refuse('closed');
    let handshake: HandshakeState | null = null;
    let parsed: Exclude<ParsedFirstMessage, { error: string }>;
    const onMessage = (data: unknown, binary: boolean) => {
      if (!binary || !handshake) return refuse('handshake-failed');
      let payload: Buffer;
      try {
        payload = handshake.readMessage(bytesOf(data));
      } catch {
        return refuse('handshake-failed');
      }
      clearTimeout(timer);
      raw.off('message', onMessage);
      raw.off('close', onClose);
      const { send, receive } = handshake.split();
      const clientKey = handshake.remoteStaticPublicKey!;
      resolve({
        socket: new NoiseSocket(
          raw,
          new NoiseTransport({
            send,
            receive,
            maxSendBytes: options.maxSendBytes ?? MAX_SERVER_MESSAGE_BYTES,
            maxReceiveBytes: options.maxReceiveBytes ?? MAX_CLIENT_MESSAGE_BYTES,
          }),
          clientKey,
        ),
        mode: parsed.mode,
        ...(parsed.mode === MODE_FIRST_CONTACT ? { lookup: parsed.lookup.toString('hex') } : {}),
        clientKey,
        payload,
      });
    };
    const timer = setTimeout(() => refuse('timeout'), options.timeoutMs);
    raw.on('close', onClose);
    if (!isBinary) {
      const bytes = bytesOf(first);
      let id: unknown = null;
      try {
        id = (JSON.parse(bytes.toString('utf8')) as { id?: unknown }).id ?? null;
      } catch {
        id = null;
      }
      const reply = {
        id: typeof id === 'number' || typeof id === 'string' ? id : null,
        error: { code: 'protocol-unsupported', message: PROTOCOL_UNSUPPORTED_MESSAGE },
      };
      if (raw.readyState === 1) raw.send(JSON.stringify(reply));
      return refuse('protocol-unsupported', CLOSE_BAD_REQUEST);
    }
    const message = parseFirstMessage(bytesOf(first));
    if ('error' in message)
      return refuse(message.error, message.error === 'protocol-unsupported' ? CLOSE_BAD_REQUEST : CLOSE_REFUSED);
    parsed = message;
    const psk = message.mode === MODE_FIRST_CONTACT ? options.psk(message.lookup.toString('hex')) : null;
    if (message.mode === MODE_FIRST_CONTACT && !psk) return refuse('unknown-secret');
    try {
      handshake = new HandshakeState({
        protocol: psk ? NOISE_XX_PSK2 : NOISE_XX,
        initiator: false,
        prologue: handshakePrologue(message.prefix),
        staticKeyPair: options.keyPair,
        ...(psk ? { psk } : {}),
      });
      handshake.readMessage(message.message);
      raw.send(handshake.writeMessage());
    } catch (error) {
      if (!(error instanceof NoiseError)) throw error;
      return refuse('handshake-failed');
    }
    raw.on('message', onMessage);
  });
}
