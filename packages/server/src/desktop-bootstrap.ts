import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { DesktopBootstrapChallenge } from '@stim-cli/core/protocol';

const PROOF = /^[A-Za-z0-9_-]{43}$/;
const INPUT_ERROR = 'Desktop bootstrap input is invalid or unavailable.';

/** Private parent-child key; challenges and replies do not expose its value. */
export class DesktopBootstrap {
  readonly #key: Buffer;

  constructor(key: string) {
    if (!PROOF.test(key)) throw new Error(INPUT_ERROR);
    this.#key = Buffer.from(key, 'base64url');
  }

  challenge(): DesktopBootstrapChallenge {
    const nonce = randomBytes(32).toString('base64url');
    return { nonce, proof: this.#sign(`server:${nonce}`) };
  }

  verify(nonce: string, proof: unknown): boolean {
    if (typeof proof !== 'string' || !PROOF.test(proof)) return false;
    return timingSafeEqual(Buffer.from(proof), Buffer.from(this.#sign(`client:${nonce}`)));
  }

  #sign(message: string): string {
    return createHmac('sha256', this.#key).update(message).digest('base64url');
  }
}

/** Consume at most one private 32-byte key, encoded as base64url with an optional trailing newline. */
export function readDesktopBootstrap(input: Readable, timeoutMs = 5000): Promise<DesktopBootstrap> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error: boolean) => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', failed);
      input.destroy();
      const key = bytes.toString('utf8').replace(/\n$/, '');
      if (error || !PROOF.test(key)) reject(new Error(INPUT_ERROR));
      else resolve(new DesktopBootstrap(key));
    };
    const failed = () => finish(true);
    const data = (chunk: Buffer | string) => {
      const next = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (bytes.length + next.length > 44) return failed();
      bytes = Buffer.concat([bytes, next]);
    };
    const end = () => finish(false);
    const timer = setTimeout(failed, timeoutMs);
    input.on('data', data);
    input.once('end', end);
    input.once('error', failed);
  });
}
