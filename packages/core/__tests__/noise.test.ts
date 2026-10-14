/*
 * fixtures/noise-vectors.json holds every Noise_XX_25519_ChaChaPoly_SHA256 and Noise_XXpsk2_25519_ChaChaPoly_SHA256
 * vector from these suites, normalized to the cacophony JSON shape:
 *
 * - cacophony, public domain:
 *   https://github.com/haskell-cryptography/cacophony/blob/18b7348c54fd61fcd0c220298883de0d09c8364d/vectors/cacophony.txt
 * - snow: https://github.com/mcginty/snow/blob/d00b360cc61a7fe519ce7539974dca4f36c4654a/tests/vectors/snow.txt
 *   MIT License, Copyright (c) 2021 Jake McGinty. Permission is hereby granted, free of charge, to any person
 *   obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
 *   subject to the following conditions: The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 *   KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 *   OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH
 *   THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * - flynn/noise: https://github.com/flynn/noise/blob/fc3a9f3b3c4fba0af38ac409e8867672499d26e4/vectors.txt
 *   Its transport messages restart at the initiator; msg_3 and msg_4 are swapped into the cacophony order.
 *   Copyright (c) 2015 Prime Directive, Inc. All rights reserved. Redistribution and use in source and binary forms,
 *   with or without modification, are permitted provided that the following conditions are met: Redistributions of
 *   source code must retain the above copyright notice, this list of conditions and the following disclaimer.
 *   Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
 *   following disclaimer in the documentation and/or other materials provided with the distribution. Neither the name
 *   of Prime Directive, Inc. nor the names of its contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
 *   CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 *   OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 *   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 *   (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
 *   BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 *   TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *   POSSIBILITY OF SUCH DAMAGE.
 * - source "noiseprotocol": Noise_XXpsk2 vectors generated with the Python noiseprotocol 0.3.1 package, which also
 *   reproduces every vector above.
 *
 * fixtures/noise-framing-vectors.json is Stim's transport framing, generated with the Python cryptography package's
 * ChaCha20Poly1305.
 */
import { readFileSync } from 'node:fs';
import {
  CipherState,
  HandshakeState,
  NOISE_XX,
  NOISE_XX_PSK2,
  NoiseError,
  NoiseTransport,
  generateNoiseKeyPair,
  noiseKeyPairFromPrivateKey,
  type NoiseKeyPair,
  type NoiseProtocolName,
} from '../noise.ts';

interface Vector {
  source: string;
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

const { vectors }: { vectors: Vector[] } = JSON.parse(
  readFileSync(new URL('./fixtures/noise-vectors.json', import.meta.url), 'utf8'),
);
const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const MiB = 1024 * 1024;
const EMPTY = Buffer.alloc(0);

interface FramingVector {
  key: string;
  counter: string;
  type: 'text' | 'binary';
  data: string;
  ciphertext: string;
}

const framing: { vectors: FramingVector[] } = JSON.parse(
  readFileSync(new URL('./fixtures/noise-framing-vectors.json', import.meta.url), 'utf8'),
);

const PROTOCOLS: NoiseProtocolName[] = [NOISE_XX, NOISE_XX_PSK2];

function protocolOf(name: string): NoiseProtocolName {
  const protocol = PROTOCOLS.find((candidate) => candidate === name);
  if (!protocol) throw new Error(`Unexpected protocol ${name}`);
  return protocol;
}

function runVector(vector: Vector) {
  const protocol = protocolOf(vector.protocol_name);
  const side = (initiator: boolean) => {
    const prefix = initiator ? 'init' : 'resp';
    const psk = initiator ? vector.init_psks?.[0] : vector.resp_psks?.[0];
    return new HandshakeState({
      protocol,
      initiator,
      prologue: hex(initiator ? vector.init_prologue : vector.resp_prologue),
      staticKeyPair: noiseKeyPairFromPrivateKey(hex(vector[`${prefix}_static`])),
      ephemeralKeyPair: noiseKeyPairFromPrivateKey(hex(vector[`${prefix}_ephemeral`])),
      psk: psk === undefined ? undefined : hex(psk),
    });
  };
  const initiator = side(true);
  const responder = side(false);
  const messages = vector.messages.slice(0, 3).map(({ payload, ciphertext }, index) => {
    const [writer, reader] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
    const written = writer.writeMessage(hex(payload)).toString('hex');
    return { payload: reader.readMessage(hex(ciphertext)).toString('hex'), ciphertext: written };
  });
  const initiatorCiphers = initiator.split();
  const responderCiphers = responder.split();
  for (const [offset, { payload, ciphertext }] of vector.messages.slice(3).entries()) {
    const [writer, reader] =
      offset % 2 === 0
        ? [responderCiphers.send, initiatorCiphers.receive]
        : [initiatorCiphers.send, responderCiphers.receive];
    const written = writer.encryptWithAd(EMPTY, hex(payload)).toString('hex');
    messages.push({ payload: reader.decryptWithAd(EMPTY, hex(ciphertext)).toString('hex'), ciphertext: written });
  }
  return { messages, hashes: [initiator.handshakeHash, responder.handshakeHash] };
}

const named = (list: Vector[]) =>
  list.map((vector) => [`${vector.source} ${vector.protocol_name} #${vectors.indexOf(vector)}`, vector] as const);

test.each(named(vectors))('%s reproduces every message', (_name, vector) => {
  expect(runVector(vector).messages).toEqual(vector.messages);
});

test.each(named(vectors.filter((vector) => vector.handshake_hash)))(
  '%s reproduces the handshake hash',
  (_name, vector) => {
    expect(runVector(vector).hashes.map((hash) => hash.toString('hex'))).toEqual([
      vector.handshake_hash,
      vector.handshake_hash,
    ]);
  },
);

test.each(framing.vectors)('framing at counter $counter carries a $type message', (vector) => {
  const at = () => {
    const cipher = new CipherState(hex(vector.key));
    cipher.setNonce(BigInt(vector.counter));
    return cipher;
  };
  const transport = new NoiseTransport({ send: at(), receive: at(), maxSendBytes: MiB, maxReceiveBytes: MiB });
  const data = vector.type === 'text' ? hex(vector.data).toString('utf8') : hex(vector.data);
  expect(transport.encrypt(data).toString('hex')).toBe(vector.ciphertext);
  expect(transport.decrypt(hex(vector.ciphertext))).toEqual({ type: vector.type, data });
});

interface Party {
  staticKeyPair: NoiseKeyPair;
  psk?: Buffer;
}

const psk = Buffer.alloc(32, 7);
const prologue = Buffer.from('stim test prologue');

function parties(protocol: NoiseProtocolName, client: Party, server: Party) {
  return {
    initiator: new HandshakeState({ protocol, initiator: true, prologue, ...client }),
    responder: new HandshakeState({ protocol, initiator: false, prologue, ...server }),
  };
}

function party(protocol: NoiseProtocolName, keyPair = generateNoiseKeyPair()): Party {
  return protocol === NOISE_XX_PSK2 ? { staticKeyPair: keyPair, psk } : { staticKeyPair: keyPair };
}

type Tamper = (index: number, message: Buffer) => Buffer;

function flipByte(message: Buffer, position: number): Buffer {
  const copy = Buffer.from(message);
  copy.writeUInt8(copy.readUInt8(position) ^ 1, position);
  return copy;
}

const untouched: Tamper = (_index, message) => message;

function handshakeFailure(initiator: HandshakeState, responder: HandshakeState, tamper: Tamper) {
  for (let index = 0; index < 3; index++) {
    const [writer, reader] = index % 2 === 0 ? [initiator, responder] : [responder, initiator];
    const message = tamper(index, writer.writeMessage(Buffer.from(`payload ${index}`)));
    try {
      reader.readMessage(message);
    } catch (error) {
      return { index, error, reader };
    }
  }
  return undefined;
}

function failureOf(initiator: HandshakeState, responder: HandshakeState, tamper: Tamper = untouched) {
  const failure = handshakeFailure(initiator, responder, tamper);
  if (!failure) return undefined;
  let staysFailed = false;
  try {
    failure.reader.writeMessage();
  } catch (error) {
    staysFailed = error instanceof NoiseError;
  }
  return {
    index: failure.index,
    noiseError: failure.error instanceof NoiseError,
    staysFailed,
    remoteStatic: failure.reader.remoteStaticPublicKey,
  };
}

const failedAt = (index: number) => ({ index, noiseError: true, staysFailed: true, remoteStatic: undefined });

function connected(maxSendBytes = 16 * MiB, maxReceiveBytes = 16 * MiB) {
  const { initiator, responder } = parties(NOISE_XX, party(NOISE_XX), party(NOISE_XX));
  expect(handshakeFailure(initiator, responder, untouched)).toBeUndefined();
  return {
    client: new NoiseTransport({ ...initiator.split(), maxSendBytes, maxReceiveBytes }),
    server: new NoiseTransport({ ...responder.split(), maxSendBytes, maxReceiveBytes }),
  };
}

test.each(PROTOCOLS)('%s authenticates both static keys as each message carries them', (protocol) => {
  const client = generateNoiseKeyPair();
  const server = generateNoiseKeyPair();
  const { initiator, responder } = parties(protocol, party(protocol, client), party(protocol, server));
  responder.readMessage(initiator.writeMessage());
  expect(responder.remoteStaticPublicKey).toBeUndefined();
  initiator.readMessage(responder.writeMessage());
  expect(initiator.remoteStaticPublicKey).toEqual(server.publicKey);
  responder.readMessage(initiator.writeMessage());
  expect(responder.remoteStaticPublicKey).toEqual(client.publicKey);
  expect(initiator.handshakeHash).toEqual(responder.handshakeHash);
  initiator.split();
  expect(() => initiator.split()).toThrow(NoiseError);
});

test('the transport carries messages up to each direction limit as text or binary', () => {
  const { client, server } = connected();
  const large = Buffer.alloc(16 * MiB, 0xa5);
  large.writeUInt32BE(0xdeadbeef, 16 * MiB - 4);
  const directions: [NoiseTransport, NoiseTransport][] = [
    [client, server],
    [server, client],
  ];
  for (const [from, to] of directions) {
    const received = to.decrypt(from.encrypt(large));
    expect(received.type).toBe('binary');
    expect(Buffer.compare(Buffer.from(received.data), large)).toBe(0);
  }
  expect(server.decrypt(client.encrypt('héllo \u{1f600}'))).toEqual({ type: 'text', data: 'héllo \u{1f600}' });
  expect(server.decrypt(client.encrypt(EMPTY))).toEqual({ type: 'binary', data: EMPTY });
  expect(() => client.encrypt(Buffer.alloc(16 * MiB + 1))).toThrow(RangeError);
  expect(server.decrypt(client.encrypt('still open'))).toEqual({ type: 'text', data: 'still open' });
  expect(server.decrypt(client.encrypt('\ufeffbom'))).toEqual({ type: 'text', data: '\ufeffbom' });

  const narrow = connected(2 * MiB, 1 * MiB);
  expect(() => narrow.server.decrypt(narrow.client.encrypt(Buffer.alloc(MiB + 1)))).toThrow(NoiseError);
  expect(narrow.server.closed).toBe(true);
});

test('a wrong PSK fails the responder message that mixes it in', () => {
  const { initiator, responder } = parties(NOISE_XX_PSK2, party(NOISE_XX_PSK2), {
    staticKeyPair: generateNoiseKeyPair(),
    psk: Buffer.alloc(32, 8),
  });
  expect(failureOf(initiator, responder)).toEqual(failedAt(1));
});

test.each(PROTOCOLS)('%s refuses a static public key the peer does not hold', (protocol) => {
  const impostor = (victim: NoiseKeyPair): NoiseKeyPair => ({
    publicKey: victim.publicKey,
    privateKey: generateNoiseKeyPair().privateKey,
  });
  const server = parties(protocol, party(protocol), party(protocol, impostor(generateNoiseKeyPair())));
  expect(failureOf(server.initiator, server.responder)).toEqual(failedAt(1));
  const client = parties(protocol, party(protocol, impostor(generateNoiseKeyPair())), party(protocol));
  expect(failureOf(client.initiator, client.responder)).toEqual(failedAt(2));
});

test.each([
  [NOISE_XX, 0, 1],
  [NOISE_XX, 1, 1],
  [NOISE_XX, 2, 2],
  [NOISE_XX_PSK2, 0, 0],
  [NOISE_XX_PSK2, 1, 1],
  [NOISE_XX_PSK2, 2, 2],
] as const)('%s tampering with message %i fails reading message %i', (protocol, tampered, failsAt) => {
  for (const at of ['first', 'last'] as const) {
    const { initiator, responder } = parties(protocol, party(protocol), party(protocol));
    const flip = (index: number, message: Buffer) => {
      if (index !== tampered) return message;
      return flipByte(message, at === 'first' ? 0 : message.length - 1);
    };
    expect(failureOf(initiator, responder, flip)).toEqual(failedAt(failsAt));
  }
});

test.each([
  ['tampered', ([first]: [Buffer, Buffer]) => [flipByte(first, first.length - 1), first], 0],
  ['reordered', ([first, second]: [Buffer, Buffer]) => [second, first], 0],
  ['dropped', ([, second]: [Buffer, Buffer]) => [second], 0],
  ['replayed', ([first]: [Buffer, Buffer]) => [first, first], 1],
] as const)('a %s transport message closes the receiver', (_name, deliver, accepted) => {
  const { client, server } = connected();
  const delivered = deliver([client.encrypt('one'), client.encrypt('two')]);
  for (const message of delivered.slice(0, accepted)) server.decrypt(message);
  for (const message of delivered.slice(accepted)) expect(() => server.decrypt(message)).toThrow(NoiseError);
  expect(server.closed).toBe(true);
  expect(() => server.encrypt('reply')).toThrow(NoiseError);
});

test('an unknown message type or invalid UTF-8 text closes the receiver', () => {
  const key = Buffer.alloc(32, 3);
  for (const plaintext of [Buffer.from([0x03, 0x41]), Buffer.from([0x01, 0xff]), EMPTY]) {
    const sender = new CipherState(key);
    const receiver = new NoiseTransport({
      send: new CipherState(key),
      receive: new CipherState(key),
      maxSendBytes: MiB,
      maxReceiveBytes: MiB,
    });
    expect(() => receiver.decrypt(sender.encryptWithAd(EMPTY, plaintext))).toThrow(NoiseError);
    expect(receiver.closed).toBe(true);
  }
});

test('a transport closes instead of using the reserved nonce 2^64-1', () => {
  const key = Buffer.alloc(32, 9);
  const at = (n: bigint) => {
    const cipher = new CipherState(key);
    cipher.setNonce(n);
    return cipher;
  };
  const sender = new NoiseTransport({
    send: at(2n ** 64n - 2n),
    receive: at(0n),
    maxSendBytes: 16,
    maxReceiveBytes: 16,
  });
  const receiver = new NoiseTransport({
    send: at(0n),
    receive: at(2n ** 64n - 2n),
    maxSendBytes: 16,
    maxReceiveBytes: 16,
  });
  expect(receiver.decrypt(sender.encrypt('last'))).toEqual({ type: 'text', data: 'last' });
  expect(() => sender.encrypt('wrapped')).toThrow(NoiseError);
  expect(sender.closed).toBe(true);
});

test.each([
  ['initiator', 'reading first', (side: HandshakeState) => side.readMessage(Buffer.alloc(32))],
  ['responder', 'writing first', (side: HandshakeState) => side.writeMessage()],
  [
    'initiator',
    'writing message 1 twice',
    (side: HandshakeState) => {
      side.writeMessage();
      side.writeMessage();
    },
  ],
] as const)('an out-of-turn %s %s fails its handshake for good', (role, _name, misuse) => {
  const side = parties(NOISE_XX, party(NOISE_XX), party(NOISE_XX))[role];
  expect(() => misuse(side)).toThrow(NoiseError);
  expect(() => side.writeMessage()).toThrow('The handshake has failed');
  expect(() => side.readMessage(Buffer.alloc(32))).toThrow('The handshake has failed');
});

test('handshake messages are capped at 1024 bytes on both sides', () => {
  const fresh = () => parties(NOISE_XX, party(NOISE_XX), party(NOISE_XX));
  expect(fresh().initiator.writeMessage(Buffer.alloc(1024 - 32))).toHaveLength(1024);
  expect(() => fresh().initiator.writeMessage(Buffer.alloc(1024 - 31))).toThrow(NoiseError);
  expect(() => fresh().responder.readMessage(Buffer.alloc(1025, 1))).toThrow(NoiseError);
});

test('an all-zero ephemeral key from the peer fails the handshake', () => {
  const { responder } = parties(NOISE_XX, party(NOISE_XX), party(NOISE_XX));
  responder.readMessage(Buffer.alloc(32));
  expect(() => responder.writeMessage()).toThrow(NoiseError);
});
