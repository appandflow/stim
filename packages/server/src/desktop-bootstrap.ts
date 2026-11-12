import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DesktopBootstrapChallenge } from '@stim-cli/core/protocol';

const PROOF = /^[A-Za-z0-9_-]{43}$/;
const INPUT_ERROR = 'The Desktop key in run/desktop.key is invalid.';

/** stimd's private Desktop key; challenges and replies do not expose its value. */
// @ref LLP 0008#desktop-proves-local-authority -- the local socket alone does not grant Desktop authority
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
