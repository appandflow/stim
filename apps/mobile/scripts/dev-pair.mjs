#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: npm run dev:pair -- [--mock] [--port <n>] [--endpoint <url>]

Pairs this app's development builds with the Stim server on this Mac and writes
the endpoint and device token to .env.local.

  --mock            pair with \`npm run mock-server\` instead of stim-server
  --port <n>        the server's port (default 7787)
  --endpoint <url>  the endpoint the app connects to (default ws://127.0.0.1:<port>),
                    such as the tailnet endpoint stim-server prints`;

const ENV_FILE = new URL('../.env.local', import.meta.url);
const ENDPOINT_KEY = 'EXPO_PUBLIC_STIM_DEV_ENDPOINT';
const TOKEN_KEY = 'EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN';

function fail(message) {
  console.error(`dev:pair: ${message}`);
  process.exit(1);
}

function pairingToken(mock, port) {
  if (mock) {
    const file = join(tmpdir(), `stim-mobile-mock-server-pairing-${port}.json`);
    try {
      return JSON.parse(readFileSync(file, 'utf8')).pairingToken;
    } catch {
      fail(`no mock server pairing code in ${file}. Start it with \`npm run mock-server -- --port ${port}\`.`);
    }
  }
  let output;
  try {
    output = execFileSync('stim-server', ['pair', '--json', '--port', String(port)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    fail(`\`stim-server pair --json\` failed: ${error.message}`);
  }
  return JSON.parse(output).qr.pairingToken;
}

function spend(endpoint, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.onerror = () => reject(new Error(`cannot reach ${endpoint}. Is the server running?`));
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'hello',
          params: {
            protocol: 1,
            client: { name: 'stim-mobile-dev-pair', version: '0.0.0' },
            auth: { pairingToken: token, deviceName: `Stim Mobile development (${hostname()})` },
          },
        }),
      );
    socket.onmessage = (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.id !== 1) return;
      socket.close();
      if (reply.error) reject(new Error(`${reply.error.code}: ${reply.error.message}`));
      else resolve(reply.result);
    };
  });
}

function writeEnv(values) {
  let lines = [];
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch {}
  const kept = lines.filter((line) => line !== '' && !Object.keys(values).some((key) => line.startsWith(`${key}=`)));
  const added = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(ENV_FILE, `${[...kept, ...added].join('\n')}\n`, { mode: 0o600 });
}

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    port: { type: 'string', default: '7787' },
    endpoint: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`--port must be a port number, got ${values.port}.`);
const endpoint = (values.endpoint ?? `ws://127.0.0.1:${port}`).replace(/\/+$/, '');

const result = await spend(endpoint, pairingToken(values.mock, port)).catch((error) => fail(error.message));
if (!result.deviceToken) fail('the server did not issue a device token.');
writeEnv({ [ENDPOINT_KEY]: endpoint, [TOKEN_KEY]: result.deviceToken });

console.log(`Paired with ${result.server.name} at ${endpoint}; wrote ${ENDPOINT_KEY} and ${TOKEN_KEY} to .env.local.`);
console.log('Development builds open that Mac on launch. Restart Metro (`stim start`) if it is running, then reload.');
if (result.device) console.log(`Revoke this device when you are done: stim-server devices revoke ${result.device.id}`);
else
  console.log('Device tokens the mock server issues last until its token file in the temporary directory is deleted.');
