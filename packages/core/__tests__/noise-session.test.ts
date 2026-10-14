/*
 * fixtures/noise-secret-vectors.json holds the psk, lookup and journal derivations and a key fingerprint, generated
 * with Python's hashlib.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateNoiseKeyPair } from '../noise.ts';
import {
  acceptNoise,
  decodeSecret,
  initiateNoise,
  keyFingerprint,
  newSecret,
  readOrCreateKeyFile,
  secretValues,
  type AcceptedHandshake,
  type RawSocket,
} from '../noise-session.ts';

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'noise-secret-vectors.json'), 'utf8'),
) as {
  secrets: { secret: string; psk: string; lookup: string; journal: string }[];
  fingerprint: { publicKey: string; fingerprint: string };
};

class FakeSocket extends EventEmitter implements RawSocket {
  readyState = 1;
  bufferedAmount = 0;
  peer!: FakeSocket;
  sent: { data: Buffer; isBinary: boolean }[] = [];
  /** Rewrites each outgoing message; tests use it to play a man in the middle. */
  tamper: ((data: Buffer, index: number) => Buffer) | null = null;

  send(data: Buffer | string): void {
    if (typeof data === 'string') this.sendRaw(Buffer.from(data), false);
    else this.sendRaw(data, true);
  }

  sendRaw(data: Buffer, isBinary: boolean): void {
    if (this.readyState !== 1) return;
    const out = this.tamper ? this.tamper(Buffer.from(data), this.sent.length) : data;
    this.sent.push({ data: out, isBinary });
    setImmediate(() => this.peer.emit('message', out, isBinary));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.peer.readyState = 3;
    setImmediate(() => {
      this.emit('close', code, Buffer.from(reason));
      this.peer.emit('close', code, Buffer.from(reason));
    });
  }

  terminate(): void {
    this.close(1006);
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

const server = generateNoiseKeyPair();
const client = generateNoiseKeyPair();

function accept(raw: FakeSocket, psks: Map<string, Buffer> = new Map()): Promise<AcceptedHandshake> {
  const accepted = new Promise<AcceptedHandshake>((resolve, reject) => {
    raw.once('message', (data: Buffer, isBinary: boolean) =>
      acceptNoise(raw, data, isBinary, {
        keyPair: server,
        psk: (lookup) => psks.get(lookup) ?? null,
        timeoutMs: 2000,
      }).then(resolve, reject),
    );
  });
  accepted.catch(() => undefined);
  return accepted;
}

function closeReason(raw: FakeSocket): Promise<string> {
  return new Promise((resolve) => raw.once('close', (_code: number, reason: Buffer) => resolve(reason.toString())));
}

describe('secrets', () => {
  it('derives psk, lookup and journal as an independent implementation does', () => {
    for (const vector of vectors.secrets) {
      const values = secretValues(decodeSecret(vector.secret)!);
      expect({
        psk: values.psk.toString('hex'),
        lookup: values.lookup.toString('hex'),
        journal: values.journal,
      }).toEqual({
        psk: vector.psk,
        lookup: vector.lookup,
        journal: vector.journal,
      });
    }
    expect(keyFingerprint(Buffer.from(vectors.fingerprint.publicKey, 'hex'))).toBe(vectors.fingerprint.fingerprint);
  });

  it('reads only the 43-character form of 32 bytes', () => {
    expect(decodeSecret(newSecret())).toHaveLength(32);
    expect(decodeSecret('A'.repeat(42))).toBeNull();
    expect(decodeSecret(`${'A'.repeat(42)}B`)).toBeNull();
  });
});

describe('handshake', () => {
  it('first contact authenticates both keys, carries the name and encrypts both directions', async () => {
    const [clientRaw, serverRaw] = socketPair();
    const secret = decodeSecret(newSecret())!;
    const { psk, lookup } = secretValues(secret);
    const accepted = accept(serverRaw, new Map([[lookup.toString('hex'), psk]]));
    const socket = await initiateNoise(clientRaw, { keyPair: client, secret, name: 'Phone', timeoutMs: 2000 });
    const done = await accepted;
    expect(socket.remoteKey.equals(server.publicKey)).toBe(true);
    expect(done.clientKey.equals(client.publicKey)).toBe(true);
    expect(done).toMatchObject({ mode: 1, lookup: lookup.toString('hex') });
    expect(JSON.parse(done.payload.toString())).toEqual({ name: 'Phone' });
    const received = new Promise<[string, boolean]>((resolve) =>
      done.socket.once('message', (data: Buffer, binary: boolean) => resolve([data.toString(), binary])),
    );
    socket.send('{"id":1}');
    expect(await received).toEqual(['{"id":1}', false]);
    expect(clientRaw.sent.at(-1)!.data.includes(Buffer.from('"id"'))).toBe(false);
    const back = new Promise<[Buffer, boolean]>((resolve) =>
      socket.once('message', (data: Buffer, binary: boolean) => resolve([data, binary])),
    );
    done.socket.send(Buffer.from([1, 2, 3]));
    expect(await back).toEqual([Buffer.from([1, 2, 3]), true]);
  });

  it('a returning client reaches only the server key it pinned', async () => {
    const [clientRaw, serverRaw] = socketPair();
    void accept(serverRaw).catch(() => undefined);
    const other = generateNoiseKeyPair();
    await expect(
      initiateNoise(clientRaw, { keyPair: client, serverKey: other.publicKey, timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'server-key-mismatch' });

    const [again, againServer] = socketPair();
    const accepted = accept(againServer);
    await initiateNoise(again, { keyPair: client, serverKey: server.publicKey, timeoutMs: 2000 });
    expect((await accepted).mode).toBe(0);
  });

  it('closes with unknown-secret when no secret matches the lookup', async () => {
    const [clientRaw, serverRaw] = socketPair();
    const refused = accept(serverRaw);
    await expect(
      initiateNoise(clientRaw, { keyPair: client, secret: decodeSecret(newSecret())!, timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'unknown-secret' });
    await expect(refused).rejects.toMatchObject({ code: 'unknown-secret' });
  });

  it('fails when the cleartext prefix is changed in transit, since the prologue binds it', async () => {
    const [clientRaw, serverRaw] = socketPair();
    const secret = decodeSecret(newSecret())!;
    const { psk, lookup } = secretValues(secret);
    const other = secretValues(decodeSecret(newSecret())!).lookup;
    clientRaw.tamper = (data, index) =>
      index === 0 ? Buffer.concat([data.subarray(0, 2), other, data.subarray(18)]) : data;
    const refused = accept(
      serverRaw,
      new Map([
        [lookup.toString('hex'), psk],
        [other.toString('hex'), psk],
      ]),
    );
    await expect(initiateNoise(clientRaw, { keyPair: client, secret, timeoutMs: 2000 })).rejects.toMatchObject({
      code: 'handshake-failed',
    });
    await expect(refused).rejects.toMatchObject({ code: 'handshake-failed' });
  });

  it('answers a protocol 1 hello in cleartext with protocol-unsupported', async () => {
    const [clientRaw, serverRaw] = socketPair();
    const refused = accept(serverRaw);
    const reply = new Promise<string>((resolve) =>
      clientRaw.once('message', (data: Buffer) => resolve(data.toString())),
    );
    const reason = closeReason(clientRaw);
    clientRaw.sendRaw(Buffer.from('{"id":7,"method":"hello","params":{"protocol":1}}'), false);
    expect(JSON.parse(await reply)).toMatchObject({ id: 7, error: { code: 'protocol-unsupported' } });
    expect(await reason).toBe('protocol-unsupported');
    await expect(refused).rejects.toMatchObject({ code: 'protocol-unsupported' });
  });

  it('closes the connection when a transport message is replayed', async () => {
    const [clientRaw, serverRaw] = socketPair();
    const accepted = accept(serverRaw);
    const socket = await initiateNoise(clientRaw, { keyPair: client, serverKey: server.publicKey, timeoutMs: 2000 });
    const done = await accepted;
    const messages: string[] = [];
    done.socket.on('message', (data: Buffer) => messages.push(data.toString()));
    const reason = closeReason(serverRaw);
    socket.send('first');
    await new Promise((resolve) => setImmediate(resolve));
    clientRaw.sendRaw(clientRaw.sent.at(-1)!.data, true);
    expect(await reason).toBe('decrypt-failed');
    expect(messages).toEqual(['first']);
  });
});

describe('key files', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('creates a private key once and refuses to replace a damaged one', () => {
    dir = mkdtempSync(join(tmpdir(), 'stim-key-'));
    const file = join(dir, 'nested', 'identity.key');
    const created = readOrCreateKeyFile(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOrCreateKeyFile(file).publicKey.equals(created.publicKey)).toBe(true);
    writeFileSync(file, 'short');
    expect(() => readOrCreateKeyFile(file)).toThrow(/32-byte/);
  });
});
