// usage: node noise-responder.mjs <built stim package directory> <pairing token> [hold]
// With "hold" the socket stays open after message 3, so no reply to hello ever comes.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { generateNoiseKeyPair } from '../../../../../packages/core/dist/noise.mjs';
import { acceptNoise, keyFingerprint, secretValues } from '../../../../../packages/core/dist/noise-session.mjs';

const [stim, token, mode] = process.argv.slice(2);
const { WebSocketServer } = createRequire(join(stim, 'package.json'))('ws');

const keyPair = generateNoiseKeyPair();
const values = secretValues(Buffer.from(token, 'base64url'));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('connection', (socket) => {
  socket.once('message', async (data, isBinary) => {
    let accepted;
    try {
      accepted = await acceptNoise(socket, data, isBinary, {
        keyPair,
        psk: (lookup) => (lookup === values.lookup.toString('hex') ? values.psk : null),
        timeoutMs: 5000,
      });
    } catch (error) {
      console.log(JSON.stringify({ message3: false, code: error.code }));
      return;
    }
    console.log(JSON.stringify({ message3: true, payload: accepted.payload.toString('utf8') }));
    if (mode !== 'hold') accepted.socket.close(1000, 'done');
  });
});
server.on('listening', () => {
  console.log(JSON.stringify({ port: server.address().port, fingerprint: keyFingerprint(keyPair.publicKey) }));
});
