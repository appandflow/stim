import type { WebSocketServer, WebSocket } from 'ws';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import { acceptNoise, type AcceptedHandshake, type NoiseSocket } from '@stim-cli/core/noise-session';

/** A stand-in remote stim-server's key; credentials pin its public key as `serverKey`. */
const FAKE_SERVER_KEY: NoiseKeyPair = generateNoiseKeyPair();
export const FAKE_SERVER_PUBLIC: string = FAKE_SERVER_KEY.publicKey.toString('base64url');

/**
 * Runs the server side of the protocol 2 handshake on every connection to `server`, then hands the authenticated
 * socket to `onConnection`. `psk` answers first-contact lookups; without it only returning clients get through.
 */
export function acceptNoiseConnections(
  server: WebSocketServer,
  onConnection: (socket: NoiseSocket, accepted: AcceptedHandshake) => void,
  {
    keyPair = FAKE_SERVER_KEY,
    psk = () => null,
  }: { keyPair?: NoiseKeyPair; psk?: (lookup: string) => Buffer | null } = {},
): void {
  server.on('connection', (raw: WebSocket) => {
    raw.once('message', (data, isBinary) => {
      acceptNoise(raw, data, isBinary, { keyPair, psk, timeoutMs: 5000 }).then(
        (accepted) => onConnection(accepted.socket, accepted),
        () => undefined,
      );
    });
  });
}
