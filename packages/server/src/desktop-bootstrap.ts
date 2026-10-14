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

/** Read a newline-terminated private key; the open pipe then tracks the owning parent's lifetime. */
export function readDesktopBootstrap(
  input: Readable,
  timeoutMs = 5000,
): Promise<{ bootstrap: DesktopBootstrap; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let ready = false;
    let close!: () => void;
    const closed = new Promise<void>((resolveClosed) => {
      close = resolveClosed;
    });
    const ended = () => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', ended);
      input.off('error', ended);
      input.off('close', ended);
      input.destroy();
      close();
      if (!ready) reject(new Error(INPUT_ERROR));
    };
    const data = (chunk: Buffer | string) => {
      if (ready) return ended();
      const next = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (bytes.length + next.length > 44) return ended();
      bytes = Buffer.concat([bytes, next]);
      if (bytes.length < 44) return;
      const key = bytes.subarray(0, 43).toString('utf8');
      if (bytes[43] !== 10 || !PROOF.test(key)) return ended();
      ready = true;
      bytes = Buffer.alloc(0);
      clearTimeout(timer);
      resolve({ bootstrap: new DesktopBootstrap(key), closed });
    };
    const timer = setTimeout(ended, timeoutMs);
    input.on('data', data);
    input.once('end', ended);
    input.once('error', ended);
    input.once('close', ended);
  });
}
