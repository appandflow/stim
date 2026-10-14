import {
  CipherState,
  HandshakeState,
  NOISE_XX,
  NOISE_XX_PSK2,
  NoiseTransport,
  noiseKeyPairFromPrivateKey,
  type NoiseDh,
  type NoiseProtocolName,
} from '@stim-cli/core/noise';

import handshakes from '../../../packages/core/__tests__/fixtures/noise-vectors.json';
import framing from '../../../packages/core/__tests__/fixtures/noise-framing-vectors.json';

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_psks?: string[];
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral: string;
  resp_psks?: string[];
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const EMPTY = new Uint8Array();
const MiB = 1024 * 1024;
const PROTOCOLS: NoiseProtocolName[] = [NOISE_XX, NOISE_XX_PSK2];
const vectors: Vector[] = handshakes.vectors;

function handshakeFailures(vector: Vector, dh: NoiseDh): string[] {
  const protocol = PROTOCOLS.find((name) => name === vector.protocol_name);
  if (!protocol) return [`unexpected protocol ${vector.protocol_name}`];
  const side = (initiator: boolean): HandshakeState => {
    const prefix = initiator ? 'init' : 'resp';
    const psk = vector[`${prefix}_psks`]?.[0];
    return new HandshakeState({
      protocol,
      initiator,
      prologue: hex(vector[`${prefix}_prologue`]),
      staticKeyPair: noiseKeyPairFromPrivateKey(hex(vector[`${prefix}_static`])),
      ephemeralKeyPair: noiseKeyPairFromPrivateKey(hex(vector[`${prefix}_ephemeral`])),
      ...(psk === undefined ? {} : { psk: hex(psk) }),
      dh,
    });
  };
  const failures: string[] = [];
  const check = (what: string, actual: string, expected: string): void => {
    if (actual !== expected) failures.push(`${vector.protocol_name} ${what}: ${actual} is not ${expected}`);
  };
  const initiator = side(true);
  const responder = side(false);
  for (const [index, { payload, ciphertext }] of vector.messages.slice(0, 3).entries()) {
    const [writer, reader] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
    check(`message ${index}`, writer.writeMessage(hex(payload)).toString('hex'), ciphertext);
    check(`payload ${index}`, reader.readMessage(hex(ciphertext)).toString('hex'), payload);
  }
  if (vector.handshake_hash) check('handshake hash', initiator.handshakeHash.toString('hex'), vector.handshake_hash);
  const sent = initiator.split();
  const received = responder.split();
  for (const [offset, { payload, ciphertext }] of vector.messages.slice(3).entries()) {
    const [writer, reader] = offset % 2 === 0 ? [received.send, sent.receive] : [sent.send, received.receive];
    check(`transport ${offset}`, writer.encryptWithAd(EMPTY, hex(payload)).toString('hex'), ciphertext);
    check(`transport payload ${offset}`, reader.decryptWithAd(EMPTY, hex(ciphertext)).toString('hex'), payload);
  }
  return failures;
}

function framingFailures(vector: (typeof framing.vectors)[number]): string[] {
  const at = (): CipherState => {
    const cipher = new CipherState(hex(vector.key));
    cipher.setNonce(BigInt(vector.counter));
    return cipher;
  };
  const transport = new NoiseTransport({ send: at(), receive: at(), maxSendBytes: MiB, maxReceiveBytes: MiB });
  const data = vector.type === 'text' ? hex(vector.data).toString('utf8') : hex(vector.data);
  const ciphertext = transport.encrypt(data).toString('hex');
  const decrypted = transport.decrypt(hex(vector.ciphertext));
  const plaintext = typeof decrypted.data === 'string' ? decrypted.data : decrypted.data.toString('hex');
  const expected = typeof data === 'string' ? data : data.toString('hex');
  return ciphertext === vector.ciphertext && decrypted.type === vector.type && plaintext === expected
    ? []
    : [`framing at counter ${vector.counter}: ${ciphertext} is not ${vector.ciphertext}`];
}

/** Runs core's shared Noise and framing vectors through core's Noise with `dh`; an empty `failures` passes. */
export function runSharedVectors(dh: NoiseDh): { ran: number; failures: string[] } {
  const failures = [
    ...vectors.flatMap((vector) => handshakeFailures(vector, dh)),
    ...framing.vectors.flatMap(framingFailures),
  ];
  return { ran: vectors.length + framing.vectors.length, failures };
}
