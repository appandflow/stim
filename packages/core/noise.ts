import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';

export const NOISE_XX = 'Noise_XX_25519_ChaChaPoly_SHA256';
export const NOISE_XX_PSK2 = 'Noise_XXpsk2_25519_ChaChaPoly_SHA256';
export type NoiseProtocolName = typeof NOISE_XX | typeof NOISE_XX_PSK2;

/** Largest handshake message either side writes or reads, payload included. */
export const MAX_HANDSHAKE_MESSAGE_BYTES = 1024;

const KEY_BYTES = 32;
const HASH_BYTES = 32;
const TAG_BYTES = 16;
// Noise revision 34, section 5.1: nonce 2^64-1 is reserved and must never encrypt a message.
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = Buffer.alloc(0);
const TEXT = 0x01;
const BINARY = 0x02;

// RFC 8410 DER wrappers; node:crypto on Node 22.12 has no raw X25519 key import.
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

/** Thrown for any handshake or transport failure; the handshake or transport is unusable afterwards. */
export class NoiseError extends Error {
  override name = 'NoiseError';
}

/** A raw 32-byte X25519 key pair. */
export interface NoiseKeyPair {
  readonly publicKey: Buffer;
  readonly privateKey: Buffer;
}

export function generateNoiseKeyPair(): NoiseKeyPair {
  const { privateKey } = generateKeyPairSync('x25519');
  return noiseKeyPairFromPrivateKey(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-KEY_BYTES));
}

export function noiseKeyPairFromPrivateKey(privateKey: Uint8Array): NoiseKeyPair {
  if (privateKey.length !== KEY_BYTES) throw new RangeError('An X25519 private key is 32 bytes');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' });
  return {
    publicKey: createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-KEY_BYTES),
    privateKey: Buffer.from(privateKey),
  };
}

/** X25519 of a raw 32-byte private key and a peer's raw 32-byte public key; it throws for a low-order key. */
export type NoiseDh = (privateKey: Buffer, publicKey: Buffer) => Uint8Array;

const nodeDh: NoiseDh = (privateKey, publicKey) =>
  diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, publicKey]), format: 'der', type: 'spki' }),
  });

// Noise revision 34, section 12.3: the ChaChaPoly nonce is 32 zero bits then the 64-bit counter, little-endian.
function nonceBytes(n: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

function aeadEncrypt(k: Buffer, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: TAG_BYTES });
  cipher.setAAD(ad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aeadDecrypt(k: Buffer, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Buffer {
  if (ciphertext.length < TAG_BYTES) throw new NoiseError('Message is shorter than its authentication tag');
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: TAG_BYTES });
  decipher.setAAD(ad, { plaintextLength: body.length });
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new NoiseError('Message failed authentication');
  }
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

// Noise revision 34, section 4.3 HKDF; node's hkdf takes a salt and info rather than this chaining.
function hkdf(chainingKey: Buffer, input: Uint8Array): [Buffer, Buffer, Buffer] {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Uint8Array.of(1));
  const second = hmac(temp, first, Uint8Array.of(2));
  return [first, second, hmac(temp, second, Uint8Array.of(3))];
}

/** Noise's CipherState: a key and a 64-bit counter used as the nonce. */
export class CipherState {
  #k: Buffer | undefined;
  #n = 0n;

  constructor(key?: Uint8Array) {
    if (key && key.length !== KEY_BYTES) throw new RangeError('A cipher key is 32 bytes');
    this.#k = key && Buffer.from(key);
  }

  hasKey(): boolean {
    return this.#k !== undefined;
  }

  setNonce(n: bigint): void {
    this.#n = n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.#k) return Buffer.from(plaintext);
    if (this.#n >= MAX_NONCE) throw new NoiseError('Nonce exhausted');
    const ciphertext = aeadEncrypt(this.#k, this.#n, ad, plaintext);
    this.#n++;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.#k) return Buffer.from(ciphertext);
    if (this.#n >= MAX_NONCE) throw new NoiseError('Nonce exhausted');
    const plaintext = aeadDecrypt(this.#k, this.#n, ad, ciphertext);
    this.#n++;
    return plaintext;
  }
}

class SymmetricState {
  #ck: Buffer;
  #h: Buffer;
  cipher = new CipherState();

  constructor(protocol: NoiseProtocolName) {
    const name = Buffer.from(protocol, 'ascii');
    // Noise revision 34, section 5.2: a name of at most HASHLEN bytes is zero-padded, a longer one hashed.
    this.#h = name.length <= HASH_BYTES ? Buffer.concat([name, Buffer.alloc(HASH_BYTES - name.length)]) : sha256(name);
    this.#ck = this.#h;
  }

  get handshakeHash(): Buffer {
    return Buffer.from(this.#h);
  }

  mixKey(input: Uint8Array): void {
    const [ck, k] = hkdf(this.#ck, input);
    this.#ck = ck;
    this.cipher = new CipherState(k);
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(this.#h, data);
  }

  mixKeyAndHash(input: Uint8Array): void {
    const [ck, h, k] = hkdf(this.#ck, input);
    this.#ck = ck;
    this.mixHash(h);
    this.cipher = new CipherState(k);
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ciphertext = this.cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const plaintext = this.cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.#ck, EMPTY);
    return [new CipherState(first), new CipherState(second)];
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'psk';

const PATTERNS: Record<NoiseProtocolName, readonly (readonly Token[])[]> = {
  [NOISE_XX]: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']],
  [NOISE_XX_PSK2]: [['e'], ['e', 'ee', 's', 'es', 'psk'], ['s', 'se']],
};

export interface HandshakeOptions {
  protocol: NoiseProtocolName;
  initiator: boolean;
  prologue: Uint8Array;
  staticKeyPair: NoiseKeyPair;
  /** 32 bytes, required for {@link NOISE_XX_PSK2} and refused for {@link NOISE_XX}. */
  psk?: Uint8Array;
  /** Fixed ephemeral key, only for reproducing published test vectors. */
  ephemeralKeyPair?: NoiseKeyPair;
  /**
   * X25519 in place of node:crypto's, for a runtime whose node:crypto cannot derive with an imported raw public key,
   * such as Cloudflare workerd.
   */
  dh?: NoiseDh;
}

/**
 * Noise's HandshakeState for {@link NOISE_XX} and {@link NOISE_XX_PSK2}. The initiator writes messages 1 and 3. Any
 * error from {@link writeMessage} or {@link readMessage}, including an out-of-turn call, a call after the last
 * message, or an invalid or oversized message, ends the handshake: every later call throws {@link NoiseError}.
 */
export class HandshakeState {
  readonly #symmetric: SymmetricState;
  readonly #messages: readonly (readonly Token[])[];
  readonly #initiator: boolean;
  readonly #s: NoiseKeyPair;
  readonly #psk: Buffer | undefined;
  readonly #dh: NoiseDh;
  #e: NoiseKeyPair | undefined;
  #re: Buffer | undefined;
  #rs: Buffer | undefined;
  #index = 0;
  #failed = false;
  #split = false;

  constructor(options: HandshakeOptions) {
    const usesPsk = options.protocol === NOISE_XX_PSK2;
    if (usesPsk !== (options.psk !== undefined)) throw new TypeError(`${options.protocol} psk mismatch`);
    if (options.psk && options.psk.length !== KEY_BYTES) throw new RangeError('A PSK is 32 bytes');
    this.#symmetric = new SymmetricState(options.protocol);
    this.#symmetric.mixHash(options.prologue);
    this.#messages = PATTERNS[options.protocol];
    this.#initiator = options.initiator;
    this.#s = options.staticKeyPair;
    this.#psk = options.psk && Buffer.from(options.psk);
    this.#e = options.ephemeralKeyPair;
    this.#dh = options.dh ?? nodeDh;
  }

  get isComplete(): boolean {
    return this.#index === this.#messages.length;
  }

  /** The peer's static public key, once the message that carries it has been read and authenticated. */
  get remoteStaticPublicKey(): Buffer | undefined {
    return this.#failed || !this.#rs ? undefined : Buffer.from(this.#rs);
  }

  get handshakeHash(): Buffer {
    if (!this.isComplete) throw new NoiseError('The handshake is not complete');
    return this.#symmetric.handshakeHash;
  }

  writeMessage(payload: Uint8Array = EMPTY): Buffer {
    return this.#step(true, (tokens) => {
      const parts: Buffer[] = [];
      for (const token of tokens) {
        if (token === 'e') {
          this.#e ??= generateNoiseKeyPair();
          parts.push(this.#e.publicKey);
          this.#mixEphemeral(this.#e.publicKey);
        } else if (token === 's') parts.push(this.#symmetric.encryptAndHash(this.#s.publicKey));
        else this.#mixToken(token);
      }
      parts.push(this.#symmetric.encryptAndHash(payload));
      const message = Buffer.concat(parts);
      if (message.length > MAX_HANDSHAKE_MESSAGE_BYTES) throw new NoiseError('Handshake message is too large');
      return message;
    });
  }

  readMessage(message: Uint8Array): Buffer {
    return this.#step(false, (tokens) => {
      if (message.length > MAX_HANDSHAKE_MESSAGE_BYTES) throw new NoiseError('Handshake message is too large');
      let offset = 0;
      const take = (length: number): Buffer => {
        if (message.length - offset < length) throw new NoiseError('Handshake message is truncated');
        const part = Buffer.from(message.subarray(offset, offset + length));
        offset += length;
        return part;
      };
      for (const token of tokens) {
        if (token === 'e') {
          this.#re = take(KEY_BYTES);
          this.#mixEphemeral(this.#re);
        } else if (token === 's') {
          const length = KEY_BYTES + (this.#symmetric.cipher.hasKey() ? TAG_BYTES : 0);
          this.#rs = this.#symmetric.decryptAndHash(take(length));
        } else this.#mixToken(token);
      }
      return this.#symmetric.decryptAndHash(message.subarray(offset));
    });
  }

  /** Noise's Split(), returning this side's sending and receiving cipher states. It can be called once. */
  split(): { send: CipherState; receive: CipherState } {
    if (this.#failed || !this.isComplete) throw new NoiseError('The handshake is not complete');
    if (this.#split) throw new NoiseError('The handshake has already been split');
    this.#split = true;
    const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
    return this.#initiator
      ? { send: initiatorToResponder, receive: responderToInitiator }
      : { send: responderToInitiator, receive: initiatorToResponder };
  }

  #step(writing: boolean, run: (tokens: readonly Token[]) => Buffer): Buffer {
    if (this.#failed) throw new NoiseError('The handshake has failed');
    try {
      const tokens = this.#messages[this.#index];
      if (!tokens) throw new NoiseError('The handshake is complete');
      if (writing !== (this.#initiator === (this.#index % 2 === 0)))
        throw new NoiseError(`It is not this side's turn to ${writing ? 'write' : 'read'}`);
      const result = run(tokens);
      this.#index++;
      return result;
    } catch (error) {
      this.#failed = true;
      throw error instanceof NoiseError ? error : new NoiseError('Handshake failed', { cause: error });
    }
  }

  #mixEphemeral(publicKey: Buffer): void {
    this.#symmetric.mixHash(publicKey);
    // Noise revision 34, section 9.2: in a PSK handshake every "e" token also calls MixKey(e.public_key).
    if (this.#psk) this.#symmetric.mixKey(publicKey);
  }

  #x25519(keyPair: NoiseKeyPair, publicKey: Buffer): Buffer {
    try {
      return Buffer.from(this.#dh(keyPair.privateKey, publicKey));
    } catch {
      throw new NoiseError('X25519 failed; the peer sent an invalid public key');
    }
  }

  #mixToken(token: Exclude<Token, 'e' | 's'>): void {
    if (token === 'psk') {
      if (!this.#psk) throw new NoiseError('Pattern needs a PSK');
      this.#symmetric.mixKeyAndHash(this.#psk);
      return;
    }
    const remote = (key: Buffer | undefined): Buffer => {
      if (!key) throw new NoiseError(`Token ${token} needs a remote key`);
      return key;
    };
    const e = this.#e;
    if (!e) throw new NoiseError(`Token ${token} needs an ephemeral key`);
    if (token === 'ee') this.#symmetric.mixKey(this.#x25519(e, remote(this.#re)));
    else if (token === 'es')
      this.#symmetric.mixKey(
        this.#initiator ? this.#x25519(e, remote(this.#rs)) : this.#x25519(this.#s, remote(this.#re)),
      );
    else
      this.#symmetric.mixKey(
        this.#initiator ? this.#x25519(this.#s, remote(this.#re)) : this.#x25519(e, remote(this.#rs)),
      );
  }
}

export interface NoiseTransportOptions {
  send: CipherState;
  receive: CipherState;
  /** Largest message, in bytes (UTF-8 bytes for text), this side may send. */
  maxSendBytes: number;
  /** Largest message, in bytes (UTF-8 bytes for text), this side accepts. */
  maxReceiveBytes: number;
}

/** A message carried by one WebSocket message: text or binary, as the sender passed it. */
export type NoiseMessage = { type: 'text'; data: string } | { type: 'binary'; data: Buffer };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Stim's transport framing after the handshake: each WebSocket message is one ChaCha20-Poly1305 message with empty
 * associated data under the next counter value. The first plaintext byte is the message type, 0x01 text or 0x02
 * binary. Counters are not sent, so a reordered, replayed, dropped or altered message fails to decrypt. Any decryption
 * failure closes the transport: every later call throws {@link NoiseError}. Nonce 2^64-1 is reserved and never used:
 * after a direction's last usable message, at counter 2^64-2, the next call in that direction closes the transport.
 */
export class NoiseTransport {
  readonly #send: CipherState;
  readonly #receive: CipherState;
  readonly #maxSend: number;
  readonly #maxReceive: number;
  #closed = false;

  constructor(options: NoiseTransportOptions) {
    if (!options.send.hasKey() || !options.receive.hasKey()) throw new TypeError('Transport cipher states need keys');
    this.#send = options.send;
    this.#receive = options.receive;
    this.#maxSend = options.maxSendBytes;
    this.#maxReceive = options.maxReceiveBytes;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Encrypts a string as a text message or bytes as a binary message. Data over `maxSendBytes` (UTF-8 bytes for text)
   * throws a `RangeError`, consumes no counter, and leaves the transport open: it is the caller's own error and nothing
   * was sent.
   */
  encrypt(data: string | Uint8Array): Buffer {
    this.#assertOpen();
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (body.length > this.#maxSend) throw new RangeError(`Message exceeds ${this.#maxSend} bytes`);
    try {
      return this.#send.encryptWithAd(
        EMPTY,
        Buffer.concat([Uint8Array.of(typeof data === 'string' ? TEXT : BINARY), body]),
      );
    } catch (error) {
      this.#closed = true;
      throw error;
    }
  }

  decrypt(message: Uint8Array): NoiseMessage {
    this.#assertOpen();
    try {
      if (message.length > this.#maxReceive + 1 + TAG_BYTES) throw new NoiseError('Message is too large');
      const plaintext = this.#receive.decryptWithAd(EMPTY, message);
      const body = plaintext.subarray(1);
      if (plaintext[0] === TEXT) return { type: 'text', data: utf8.decode(body) };
      if (plaintext[0] === BINARY) return { type: 'binary', data: body };
      throw new NoiseError('Unknown message type');
    } catch (error) {
      this.#closed = true;
      throw error instanceof NoiseError ? error : new NoiseError('Message is not valid', { cause: error });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new NoiseError('The transport is closed');
  }
}
