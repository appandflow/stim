import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HandshakeState, NOISE_XX, NOISE_XX_PSK2, NoiseError, NoiseTransport } from '@stim-cli/core/noise';

const VERSION = 2;
const RETURNING = 0;
const FIRST_CONTACT = 1;
const LOOKUP_BYTES = 16;
const MAX_FROM_CLIENT = 64 * 1024;
const MAX_TO_CLIENT = 16 * 1024 * 1024;
// Close codes and reasons this mock uses for refusals; the phone keys on the reason.
const CLOSE_REFUSED = 4401;
const CLOSE_BAD_REQUEST = 4400;

const labeled = (label, secret) => createHash('sha256').update(label).update(secret).digest();
export const derivePsk = (secret) => labeled('stim noise psk v1', secret);
export const deriveLookup = (secret) => labeled('stim noise lookup v1', secret).subarray(0, LOOKUP_BYTES);

/**
 * The responder side of Stim's protocol 2 on a `ws` socket, built on @stim-cli/core/noise. It emits `ready` with
 * `{ clientKey, paired }` after the handshake and `message` with each plaintext text message, and `send` takes a
 * string (text) or a Buffer (binary) like a `ws` socket does.
 *
 * `findSecret(lookup)` returns `{ secret }` for a live pairing token, or null. `knows(clientKey)` says whether a
 * returning client's key has a record. `paired(clientKey)` records a key after a first contact.
 */
export class NoiseSession extends EventEmitter {
  #socket;
  #options;
  #handshake = null;
  #transport = null;
  #mode = null;

  constructor(socket, options) {
    super();
    this.#socket = socket;
    this.#options = options;
    this.OPEN = socket.OPEN;
    socket.on('message', (data, isBinary) => this.#receive(Buffer.from(data), isBinary));
    socket.on('close', () => this.emit('close'));
  }

  get readyState() {
    return this.#transport ? this.#socket.readyState : this.#socket.CONNECTING;
  }

  send(data) {
    if (!this.#transport || this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(this.#transport.encrypt(typeof data === 'string' ? data : Buffer.from(data)));
  }

  close(code = 1000, reason = '') {
    this.#socket.close(code, reason);
  }

  #refuse(code, reason) {
    this.#handshake = null;
    this.#transport = null;
    this.#socket.close(code, reason);
  }

  #receive(data, isBinary) {
    try {
      if (this.#transport) {
        if (!isBinary) return this.#refuse(CLOSE_BAD_REQUEST, 'text after handshake');
        const message = this.#transport.decrypt(data);
        if (message.type === 'text') this.emit('message', message.data);
        return;
      }
      if (!this.#handshake) return this.#first(data, isBinary);
      this.#handshake.readMessage(data);
      const clientKey = this.#handshake.remoteStaticPublicKey;
      const { send, receive } = this.#handshake.split();
      this.#handshake = null;
      const paired = this.#mode === FIRST_CONTACT;
      if (!paired && !this.#options.knows(clientKey)) return this.#refuse(CLOSE_REFUSED, 'unauthorized');
      if (paired) this.#options.paired(clientKey);
      this.#transport = new NoiseTransport({ send, receive, maxSendBytes: MAX_TO_CLIENT, maxReceiveBytes: MAX_FROM_CLIENT });
      this.emit('ready', { clientKey, paired });
    } catch (error) {
      this.#refuse(CLOSE_BAD_REQUEST, error instanceof NoiseError ? 'handshake failed' : 'bad message');
    }
  }

  #first(data, isBinary) {
    if (!isBinary) return this.#refuse(CLOSE_BAD_REQUEST, 'protocol-unsupported');
    if (data[0] !== VERSION) return this.#refuse(CLOSE_BAD_REQUEST, 'protocol-unsupported');
    const mode = data[1];
    let prefixLength = 2;
    let psk;
    if (mode === FIRST_CONTACT) {
      prefixLength += LOOKUP_BYTES;
      const found = this.#options.findSecret(data.subarray(2, prefixLength));
      if (!found) return this.#refuse(CLOSE_REFUSED, 'unknown-secret');
      psk = derivePsk(found.secret);
    } else if (mode !== RETURNING) {
      return this.#refuse(CLOSE_BAD_REQUEST, 'protocol-unsupported');
    }
    this.#mode = mode;
    const prefix = data.subarray(0, prefixLength);
    this.#handshake = new HandshakeState({
      protocol: psk ? NOISE_XX_PSK2 : NOISE_XX,
      initiator: false,
      prologue: Buffer.concat([Buffer.from('stim noise v1'), prefix]),
      staticKeyPair: this.#options.keyPair,
      ...(psk ? { psk } : {}),
    });
    this.#handshake.readMessage(data.subarray(prefixLength));
    this.#socket.send(this.#handshake.writeMessage());
  }
}
