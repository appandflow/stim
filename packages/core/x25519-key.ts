import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const KEY_BYTES = 32;

// RFC 8410 DER wrappers; node:crypto on Node 22.12 has no raw X25519 key import.
export const PKCS8_X25519: Buffer = Buffer.from('302e020100300506032b656e04220420', 'hex');

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
