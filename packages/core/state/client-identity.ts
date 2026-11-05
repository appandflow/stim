import type { NoiseKeyPair } from '../noise.ts';
import { readOrCreateKeyFile } from '../noise-session.ts';
import { clientIdentityKeyFile } from './paths.ts';

/** This machine's long-term X25519 key as a client of other machines, in `$STIM_HOME/client-identity.key`. */
export function clientIdentity(): NoiseKeyPair {
  return readOrCreateKeyFile(clientIdentityKeyFile());
}
