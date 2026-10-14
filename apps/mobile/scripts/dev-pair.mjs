#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: pnpm run dev:pair [--mock] [--control] [--port <n>] [--endpoint <url>]

Takes a pairing code from the Stim server on this Mac and writes it to .env.local.
A development build spends it on its next launch, with the key it keeps on the
device, and then shows that Mac.

  --mock            pair with \`pnpm run mock-server\` instead of stim-server
  --control         let this pairing run actions (stim-server only)
  --port <n>        the server's port (default 7787)
  --endpoint <url>  the endpoint the app connects to (default ws://127.0.0.1:<port>),
                    such as the tailnet endpoint stim-server prints`;

const ENV_FILE = new URL('../.env.local', import.meta.url);
const PAIRING_KEY = 'EXPO_PUBLIC_STIM_DEV_PAIRING';
const STALE_KEYS = ['EXPO_PUBLIC_STIM_DEV_ENDPOINT', 'EXPO_PUBLIC_STIM_DEV_DEVICE_TOKEN'];

function fail(message) {
  console.error(`dev:pair: ${message}`);
  process.exit(1);
}

function pairingCode(mock, port, control) {
  if (mock) {
    const file = join(tmpdir(), `stim-mobile-mock-server-pairing-${port}.json`);
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      fail(`no mock server pairing code in ${file}. Start it with \`pnpm run mock-server --port ${port}\`.`);
    }
  }
  try {
    const args = ['pair', '--json', '--port', String(port), ...(control ? ['--control'] : [])];
    const output = execFileSync('stim-server', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(output).qr;
  } catch (error) {
    fail(`\`stim-server pair --json\` failed: ${error.message}`);
  }
}

function writeEnv(values) {
  let lines = [];
  try {
    lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch {}
  const replaced = [...Object.keys(values), ...STALE_KEYS];
  const kept = lines.filter((line) => !replaced.some((key) => line.startsWith(`${key}=`)));
  while (kept.at(-1) === '') kept.pop();
  const added = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(ENV_FILE, `${[...kept, ...added].join('\n')}\n`, { mode: 0o600 });
}

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    control: { type: 'boolean', default: false },
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

const code = pairingCode(values.mock, port, values.control);
if (code?.v !== 2 || typeof code.pairingToken !== 'string' || typeof code.fingerprint !== 'string')
  fail('the server did not give a protocol 2 pairing code; update stim-server.');
writeEnv({ [PAIRING_KEY]: JSON.stringify({ ...code, endpoint }) });

console.log(`Wrote a pairing code for ${code.name || 'the server'} at ${endpoint} to ${PAIRING_KEY} in .env.local.`);
console.log('Development builds pair on their next launch; reload the app (`stim reload`) if it is running.');
console.log('The code expires like any pairing code; run dev:pair again if the app reports it expired.');
