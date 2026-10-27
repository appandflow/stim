import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRawTailscaleStatus, readTailscaleStatus, serveRoute, whois } from '../src/tailscale.ts';

const APP_CLI = `#!/usr/bin/env node
const term = process.env.TERM;
if (!term) {
  console.log('The Tailscale GUI failed to start: The operation could not be completed. (Tailscale.CLIError error 3.)');
  process.exit(0);
}
if (process.argv[2] === 'whois') {
  console.log(JSON.stringify({ Node: { StableID: 'node-' + term, Name: 'laptop.tail.ts.net.' }, UserProfile: { LoginName: 'a@b.c' } }));
} else if (process.argv[2] === 'serve') {
  console.log('{}');
} else {
  console.log(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.1'], Self: { DNSName: term + '.tail.ts.net.', HostName: 'mac' } }));
}
`;

describe.skipIf(process.platform === 'win32')('Tailscale CLI environment', () => {
  let dir: string;
  let binary: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-tailscale-env-'));
    binary = join(dir, 'tailscale');
    writeFileSync(binary, APP_CLI);
    chmodSync(binary, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs every call with a TERM when the service environment has none, as the Tailscale.app CLI needs', async () => {
    const env = { PATH: process.env.PATH };
    expect(await whois(binary, env, '100.64.0.2')).toMatchObject({ nodeId: 'node-dumb' });
    expect(await readTailscaleStatus(binary, env)).toMatchObject({ state: 'running', dnsName: 'dumb.tail.ts.net' });
    expect(await readRawTailscaleStatus(binary, env)).toMatchObject({ BackendState: 'Running' });
    expect(await serveRoute(binary, env, 7787, [])).toMatchObject({ state: 'missing' });
  });

  it('keeps the TERM the environment has', async () => {
    const env = { PATH: process.env.PATH, TERM: 'xterm-256color' };
    expect(await whois(binary, env, '100.64.0.2')).toMatchObject({ nodeId: 'node-xterm-256color' });
  });
});
