// usage: node noise-responder.mjs <server runtime directory> <pairing token>
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, token] = process.argv.slice(2);
const modules = join(runtime, 'node_modules');
const { WebSocketServer } = createRequire(join(modules, 'index.js'))('ws');
const core = (file) => import(pathToFileURL(join(modules, '@stim-cli/core/dist', file)).href);
const { generateNoiseKeyPair } = await core('noise.mjs');
const { acceptNoise, keyFingerprint, secretValues } = await core('noise-session.mjs');

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
    accepted.socket.close(1000, 'done');
  });
});
server.on('listening', () => {
  console.log(JSON.stringify({ port: server.address().port, fingerprint: keyFingerprint(keyPair.publicKey) }));
});
